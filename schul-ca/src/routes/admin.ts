import { Router, type IRequest } from "itty-router";
import { checkPassword, getSetting, issueToken, requireAdmin, setSetting, storePassword } from "../auth";
import { decryptSecret, encryptSecret } from "../crypto";
import type { Env } from "../env";
import { badRequest, fileResponse, MIME, readJson, safeName } from "../http";
import { clientIp, rateLimitOk } from "../rateLimit";
import {
	analyzeCsr,
	certPemToDer,
	generateRoot,
	issueIntermediate,
	parseDnsList,
	PkiError,
	validateRootImport,
	type KeyType,
	type SubjectFields,
} from "../pki";

export const adminRouter = Router({ base: "/api/admin" });

const MIN_ADMIN_PASSWORD = 10;
const MIN_STUDENT_PASSWORD = 6;
const MAX_VALIDITY_DAYS = 3650;
const SUBJECT_KEYS = ["C", "ST", "L", "O", "OU", "CN"] as const;

// ---- Auth ------------------------------------------------------------------

adminRouter.post("/login", async (request: IRequest, env: Env) => {
	if (!(await rateLimitOk(env, `admin-login:${clientIp(request)}`, 10, 900))) {
		return badRequest("Zu viele Anmeldeversuche. Bitte in einigen Minuten erneut versuchen.", 429);
	}
	const body = await readJson<{ password?: string }>(request);
	if (!body?.password || !(await checkPassword(env, "admin", body.password))) return badRequest("Ungültiges Passwort", 401);
	return Response.json({ token: await issueToken(env, "admin") });
});

// ---- Einstellungen -----------------------------------------------------------

adminRouter.get("/settings", requireAdmin, async (_request: IRequest, env: Env) => {
	const [hint, studentHash, adminHash] = await Promise.all([
		getSetting(env.DB, "password_hint"),
		getSetting(env.DB, "student_password_hash"),
		getSetting(env.DB, "admin_password_hash"),
	]);
	return Response.json({
		passwordHint: hint ?? "",
		studentPasswordSet: Boolean(studentHash),
		adminPasswordFromEnv: !adminHash,
	});
});

adminRouter.put("/settings", requireAdmin, async (request: IRequest, env: Env) => {
	const body = await readJson<{
		passwordHint?: string;
		studentPassword?: string;
		adminPassword?: string;
		currentAdminPassword?: string;
	}>(request);
	if (!body) return badRequest("Ungültige Anfrage");

	if (body.passwordHint !== undefined) {
		const hint = String(body.passwordHint).trim();
		if (hint.length > 300) return badRequest("Der Hinweistext darf höchstens 300 Zeichen lang sein.");
		await setSetting(env.DB, "password_hint", hint || null);
	}
	if (body.studentPassword) {
		if (body.studentPassword.length < MIN_STUDENT_PASSWORD) {
			return badRequest(`Das Schülerpasswort muss mindestens ${MIN_STUDENT_PASSWORD} Zeichen lang sein.`);
		}
		await storePassword(env, "student", body.studentPassword);
	}
	let newToken: string | undefined;
	if (body.adminPassword) {
		if (body.adminPassword.length < MIN_ADMIN_PASSWORD) {
			return badRequest(`Das Admin-Passwort muss mindestens ${MIN_ADMIN_PASSWORD} Zeichen lang sein.`);
		}
		if (!body.currentAdminPassword || !(await checkPassword(env, "admin", body.currentAdminPassword))) {
			return badRequest("Das aktuelle Admin-Passwort ist nicht korrekt.", 403);
		}
		await storePassword(env, "admin", body.adminPassword);
		// Alle bisherigen Admin-Sessions sind jetzt ungültig – neue Session für den Aufrufer.
		newToken = await issueToken(env, "admin");
	}
	return Response.json({ ok: true, token: newToken });
});

// ---- Stammzertifikate ------------------------------------------------------

interface RootRow {
	id: number;
	name: string;
	subject: string;
	cert_pem: string;
	key_encrypted: string;
	fingerprint_sha256: string;
	key_algorithm: string;
	not_before: string;
	not_after: string;
	is_active: number;
	created_at: string;
}

const serializeRoot = (r: Omit<RootRow, "key_encrypted"> & { csr_count?: number }) => ({
	id: r.id,
	name: r.name,
	subject: r.subject,
	fingerprint: r.fingerprint_sha256,
	keyAlgorithm: r.key_algorithm,
	notBefore: r.not_before,
	notAfter: r.not_after,
	isActive: Boolean(r.is_active),
	createdAt: r.created_at,
	csrCount: r.csr_count ?? 0,
});

adminRouter.get("/roots", requireAdmin, async (_request: IRequest, env: Env) => {
	const { results } = await env.DB.prepare(
		`SELECT r.id, r.name, r.subject, r.cert_pem, r.fingerprint_sha256, r.key_algorithm, r.not_before, r.not_after, r.is_active, r.created_at,
		        (SELECT COUNT(*) FROM csrs c WHERE c.root_ca_id = r.id) AS csr_count
		 FROM root_cas r ORDER BY r.created_at DESC`,
	).all<RootRow & { csr_count: number }>();
	return Response.json({ roots: results.map(serializeRoot) });
});

async function insertRoot(env: Env, name: string, info: { subject: string; certPem: string; fingerprint: string; keyAlgorithm: string; notBefore: string; notAfter: string }, pkcs8: Uint8Array) {
	const existing = await env.DB.prepare("SELECT id FROM root_cas WHERE fingerprint_sha256 = ?1").bind(info.fingerprint).first();
	if (existing) return badRequest("Dieses Stammzertifikat ist bereits hinterlegt.", 409);
	const row = await env.DB.prepare(
		`INSERT INTO root_cas (name, subject, cert_pem, key_encrypted, fingerprint_sha256, key_algorithm, not_before, not_after)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) RETURNING id, name, subject, cert_pem, fingerprint_sha256, key_algorithm, not_before, not_after, is_active, created_at`,
	)
		.bind(name, info.subject, info.certPem, await encryptSecret(env.MASTER_SECRET, pkcs8), info.fingerprint, info.keyAlgorithm, info.notBefore, info.notAfter)
		.first<RootRow>();
	return Response.json({ root: serializeRoot(row!) }, { status: 201 });
}

adminRouter.post("/roots/import", requireAdmin, async (request: IRequest, env: Env) => {
	const body = await readJson<{ name?: string; certPem?: string; keyPem?: string }>(request);
	const name = body?.name?.trim();
	if (!name || !body?.certPem || !body?.keyPem) return badRequest("Name, Zertifikat und Private Key sind erforderlich.");
	try {
		const { info, pkcs8 } = await validateRootImport(body.certPem, body.keyPem);
		return await insertRoot(env, name, info, pkcs8);
	} catch (e) {
		if (e instanceof PkiError) return badRequest(e.message, 422);
		throw e;
	}
});

adminRouter.post("/roots/generate", requireAdmin, async (request: IRequest, env: Env) => {
	const body = await readJson<{ name?: string; commonName?: string; org?: string; country?: string; years?: number; keyType?: KeyType }>(request);
	const name = body?.name?.trim();
	const commonName = body?.commonName?.trim();
	const years = Number(body?.years);
	const keyType = body?.keyType ?? "ec-p384";
	if (!name || !commonName) return badRequest("Name und Common Name sind erforderlich.");
	if (!Number.isInteger(years) || years < 1 || years > 30) return badRequest("Gültigkeit: 1–30 Jahre.");
	if (!["ec-p256", "ec-p384", "rsa-3072", "rsa-4096"].includes(keyType)) return badRequest("Unbekannter Schlüsseltyp.");
	const country = body?.country?.trim().toUpperCase();
	if (country && !/^[A-Z]{2}$/.test(country)) return badRequest("Land: zweistelliger ISO-Code (z. B. DE).");
	try {
		const { info, pkcs8 } = await generateRoot({ commonName, org: body?.org?.trim() || undefined, country: country || undefined, years, keyType });
		return await insertRoot(env, name, info, pkcs8);
	} catch (e) {
		if (e instanceof PkiError) return badRequest(e.message, 422);
		throw e;
	}
});

adminRouter.patch("/roots/:id", requireAdmin, async (request: IRequest, env: Env) => {
	const body = await readJson<{ name?: string; isActive?: boolean }>(request);
	if (!body) return badRequest("Ungültige Anfrage");
	const name = body.name?.trim();
	const result = await env.DB.prepare(
		"UPDATE root_cas SET name = COALESCE(?1, name), is_active = COALESCE(?2, is_active) WHERE id = ?3",
	)
		.bind(name || null, body.isActive === undefined ? null : body.isActive ? 1 : 0, Number(request.params.id))
		.run();
	if (!result.meta.changes) return badRequest("Nicht gefunden", 404);
	return Response.json({ ok: true });
});

adminRouter.delete("/roots/:id", requireAdmin, async (request: IRequest, env: Env) => {
	const id = Number(request.params.id);
	const used = await env.DB.prepare("SELECT COUNT(*) AS n FROM csrs WHERE root_ca_id = ?1").bind(id).first<{ n: number }>();
	if (used && used.n > 0) return badRequest("Zu diesem Stammzertifikat existieren CSRs/Zertifikate. Bitte stattdessen deaktivieren.", 409);
	await env.DB.prepare("DELETE FROM root_cas WHERE id = ?1").bind(id).run();
	return Response.json({ ok: true });
});

adminRouter.get("/roots/:id/certificate", requireAdmin, async (request: IRequest, env: Env) => {
	const root = await env.DB.prepare("SELECT name, cert_pem FROM root_cas WHERE id = ?1").bind(Number(request.params.id)).first<{ name: string; cert_pem: string }>();
	if (!root) return badRequest("Nicht gefunden", 404);
	return fileResponse(root.cert_pem + "\n", `${safeName(root.name)}.pem`, MIME.pem);
});

// ---- Templates -------------------------------------------------------------

interface TemplateRow {
	id: number;
	name: string;
	validity_days: number;
	path_len: number | null;
	subject_country: string | null;
	subject_state: string | null;
	subject_locality: string | null;
	subject_org: string | null;
	subject_org_unit: string | null;
	permitted_dns: string | null;
	crl_url: string | null;
	aia_url: string | null;
}

const serializeTemplate = (t: TemplateRow) => ({
	id: t.id,
	name: t.name,
	validityDays: t.validity_days,
	pathLen: t.path_len,
	subjectCountry: t.subject_country ?? "",
	subjectState: t.subject_state ?? "",
	subjectLocality: t.subject_locality ?? "",
	subjectOrg: t.subject_org ?? "",
	subjectOrgUnit: t.subject_org_unit ?? "",
	permittedDns: t.permitted_dns ?? "",
	crlUrl: t.crl_url ?? "",
	aiaUrl: t.aia_url ?? "",
});

interface TemplateBody {
	name?: string;
	validityDays?: number;
	pathLen?: number | null;
	subjectCountry?: string;
	subjectState?: string;
	subjectLocality?: string;
	subjectOrg?: string;
	subjectOrgUnit?: string;
	permittedDns?: string;
	crlUrl?: string;
	aiaUrl?: string;
}

function validateTemplate(body: TemplateBody | null): { error: string } | { values: unknown[] } {
	if (!body) return { error: "Ungültige Anfrage" };
	const name = body.name?.trim();
	const validityDays = Number(body.validityDays);
	if (!name) return { error: "Name erforderlich." };
	if (!Number.isInteger(validityDays) || validityDays < 1 || validityDays > MAX_VALIDITY_DAYS) return { error: `Gültigkeit: 1–${MAX_VALIDITY_DAYS} Tage.` };
	let pathLen: number | null = null;
	if (body.pathLen !== null && body.pathLen !== undefined && String(body.pathLen) !== "") {
		pathLen = Number(body.pathLen);
		if (!Number.isInteger(pathLen) || pathLen < 0 || pathLen > 10) return { error: "Pfadlänge: 0–10 oder leer (unbegrenzt)." };
	}
	const country = body.subjectCountry?.trim().toUpperCase() || null;
	if (country && !/^[A-Z]{2}$/.test(country)) return { error: "Land: zweistelliger ISO-Code (z. B. DE)." };
	let dns: string | null = null;
	try {
		const list = parseDnsList(body.permittedDns);
		dns = list.length ? list.join(", ") : null;
	} catch (e) {
		return { error: (e as Error).message };
	}
	const urlOk = (u: string | undefined) => !u?.trim() || /^https?:\/\/\S+$/i.test(u.trim());
	if (!urlOk(body.crlUrl) || !urlOk(body.aiaUrl)) return { error: "CRL-/AIA-URL muss mit http:// oder https:// beginnen." };
	const opt = (v: string | undefined) => v?.trim() || null;
	return {
		values: [
			name, validityDays, pathLen, country, opt(body.subjectState), opt(body.subjectLocality), opt(body.subjectOrg),
			opt(body.subjectOrgUnit), dns, opt(body.crlUrl), opt(body.aiaUrl),
		],
	};
}

const TEMPLATE_COLUMNS =
	"id, name, validity_days, path_len, subject_country, subject_state, subject_locality, subject_org, subject_org_unit, permitted_dns, crl_url, aia_url";

adminRouter.get("/templates", requireAdmin, async (_request: IRequest, env: Env) => {
	const { results } = await env.DB.prepare(`SELECT ${TEMPLATE_COLUMNS} FROM cert_templates ORDER BY name`).all<TemplateRow>();
	return Response.json({ templates: results.map(serializeTemplate) });
});

adminRouter.post("/templates", requireAdmin, async (request: IRequest, env: Env) => {
	const v = validateTemplate(await readJson<TemplateBody>(request));
	if ("error" in v) return badRequest(v.error);
	try {
		const row = await env.DB.prepare(
			`INSERT INTO cert_templates (name, validity_days, path_len, subject_country, subject_state, subject_locality, subject_org, subject_org_unit, permitted_dns, crl_url, aia_url)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) RETURNING ${TEMPLATE_COLUMNS}`,
		)
			.bind(...v.values)
			.first<TemplateRow>();
		return Response.json({ template: serializeTemplate(row!) }, { status: 201 });
	} catch (e) {
		if (String(e).includes("UNIQUE")) return badRequest("Ein Template mit diesem Namen existiert bereits.", 409);
		throw e;
	}
});

adminRouter.put("/templates/:id", requireAdmin, async (request: IRequest, env: Env) => {
	const v = validateTemplate(await readJson<TemplateBody>(request));
	if ("error" in v) return badRequest(v.error);
	try {
		const result = await env.DB.prepare(
			`UPDATE cert_templates SET name = ?1, validity_days = ?2, path_len = ?3, subject_country = ?4, subject_state = ?5,
			 subject_locality = ?6, subject_org = ?7, subject_org_unit = ?8, permitted_dns = ?9, crl_url = ?10, aia_url = ?11 WHERE id = ?12`,
		)
			.bind(...v.values, Number(request.params.id))
			.run();
		if (!result.meta.changes) return badRequest("Nicht gefunden", 404);
		return Response.json({ ok: true });
	} catch (e) {
		if (String(e).includes("UNIQUE")) return badRequest("Ein Template mit diesem Namen existiert bereits.", 409);
		throw e;
	}
});

adminRouter.delete("/templates/:id", requireAdmin, async (request: IRequest, env: Env) => {
	await env.DB.prepare("DELETE FROM cert_templates WHERE id = ?1").bind(Number(request.params.id)).run();
	return Response.json({ ok: true });
});

// ---- CSRs --------------------------------------------------------------------

interface CsrRow {
	id: number;
	root_ca_id: number;
	label: string;
	csr_pem: string;
	csr_subject: string;
	key_info: string;
	status: string;
	template_id: number | null;
	approved_subject: string | null;
	approved_validity_days: number | null;
	reject_reason: string | null;
	cert_pem: string | null;
	serial_number: string | null;
	not_before: string | null;
	not_after: string | null;
	submitted_at: string;
	decided_at: string | null;
	issued_at: string | null;
	root_name: string;
	template_name: string | null;
}

const CSR_SELECT = `SELECT c.*, r.name AS root_name, t.name AS template_name
	FROM csrs c JOIN root_cas r ON r.id = c.root_ca_id LEFT JOIN cert_templates t ON t.id = c.template_id`;

const serializeCsr = (c: CsrRow, withPem = false) => ({
	id: c.id,
	rootCaId: c.root_ca_id,
	rootName: c.root_name,
	label: c.label,
	subject: c.csr_subject,
	keyInfo: c.key_info,
	status: c.status,
	templateId: c.template_id,
	templateName: c.template_name,
	approvedSubject: c.approved_subject ? JSON.parse(c.approved_subject) : null,
	approvedValidityDays: c.approved_validity_days,
	rejectReason: c.reject_reason,
	serialNumber: c.serial_number,
	notBefore: c.not_before,
	notAfter: c.not_after,
	submittedAt: c.submitted_at,
	decidedAt: c.decided_at,
	issuedAt: c.issued_at,
	...(withPem ? { csrPem: c.csr_pem, certPem: c.cert_pem } : {}),
});

adminRouter.get("/csrs", requireAdmin, async (request: IRequest, env: Env) => {
	const status = new URL(request.url).searchParams.get("status");
	const stmt = status
		? env.DB.prepare(`${CSR_SELECT} WHERE c.status = ?1 ORDER BY c.submitted_at DESC LIMIT 500`).bind(status)
		: env.DB.prepare(`${CSR_SELECT} ORDER BY c.submitted_at DESC LIMIT 500`);
	const { results } = await stmt.all<CsrRow>();
	return Response.json({ csrs: results.map((c) => serializeCsr(c)) });
});

async function loadCsr(env: Env, id: number): Promise<CsrRow | null> {
	return env.DB.prepare(`${CSR_SELECT} WHERE c.id = ?1`).bind(id).first<CsrRow>();
}

adminRouter.get("/csrs/:id", requireAdmin, async (request: IRequest, env: Env) => {
	const csr = await loadCsr(env, Number(request.params.id));
	if (!csr) return badRequest("Nicht gefunden", 404);
	const info = await analyzeCsr(csr.csr_pem).catch(() => null);
	return Response.json({ csr: { ...serializeCsr(csr, true), csrFields: info?.fields ?? {} } });
});

// Freigeben: Template + (ggf. angepasste) Subject-Felder + Gültigkeit festlegen.
// Mit issue=true wird direkt anschließend das Zertifikat erzeugt.
adminRouter.post("/csrs/:id/approve", requireAdmin, async (request: IRequest, env: Env) => {
	const id = Number(request.params.id);
	const csr = await loadCsr(env, id);
	if (!csr) return badRequest("Nicht gefunden", 404);
	if (csr.status === "issued") return badRequest("Das Zertifikat wurde bereits ausgestellt.", 409);

	const body = await readJson<{ templateId?: number; validityDays?: number; subject?: Partial<SubjectFields>; issue?: boolean }>(request);
	const template = await env.DB.prepare(`SELECT ${TEMPLATE_COLUMNS} FROM cert_templates WHERE id = ?1`).bind(Number(body?.templateId)).first<TemplateRow>();
	if (!template) return badRequest("Bitte ein Template auswählen.");
	const validityDays = body?.validityDays !== undefined ? Number(body.validityDays) : template.validity_days;
	if (!Number.isInteger(validityDays) || validityDays < 1 || validityDays > MAX_VALIDITY_DAYS) return badRequest(`Gültigkeit: 1–${MAX_VALIDITY_DAYS} Tage.`);

	const subject: Record<string, string> = {};
	for (const k of SUBJECT_KEYS) {
		const v = body?.subject?.[k];
		if (typeof v === "string" && v.trim()) subject[k] = v.trim();
	}
	if (!subject.CN) return badRequest("Common Name (CN) ist erforderlich.");
	if (subject.C && !/^[A-Z]{2}$/i.test(subject.C)) return badRequest("Land: zweistelliger ISO-Code.");
	if (subject.C) subject.C = subject.C.toUpperCase();

	await env.DB.prepare(
		"UPDATE csrs SET status = 'approved', template_id = ?1, approved_subject = ?2, approved_validity_days = ?3, reject_reason = NULL, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?4",
	)
		.bind(template.id, JSON.stringify(subject), validityDays, id)
		.run();

	if (body?.issue) return issueCsr(env, id);
	return Response.json({ ok: true, status: "approved" });
});

adminRouter.post("/csrs/:id/reject", requireAdmin, async (request: IRequest, env: Env) => {
	const body = await readJson<{ reason?: string }>(request);
	const reason = body?.reason?.trim().slice(0, 300) || null;
	const result = await env.DB.prepare(
		"UPDATE csrs SET status = 'rejected', reject_reason = ?1, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?2 AND status != 'issued'",
	)
		.bind(reason, Number(request.params.id))
		.run();
	if (!result.meta.changes) return badRequest("CSR nicht gefunden oder bereits ausgestellt.", 409);
	return Response.json({ ok: true });
});

adminRouter.post("/csrs/:id/issue", requireAdmin, async (request: IRequest, env: Env) => issueCsr(env, Number(request.params.id)));

async function issueCsr(env: Env, id: number): Promise<Response> {
	const csr = await loadCsr(env, id);
	if (!csr) return badRequest("Nicht gefunden", 404);
	if (csr.status !== "approved" || !csr.approved_subject || !csr.template_id || !csr.approved_validity_days) {
		return badRequest("Der CSR muss zuerst freigegeben werden.", 409);
	}
	const [root, template] = await Promise.all([
		env.DB.prepare("SELECT cert_pem, key_encrypted FROM root_cas WHERE id = ?1").bind(csr.root_ca_id).first<{ cert_pem: string; key_encrypted: string }>(),
		env.DB.prepare(`SELECT ${TEMPLATE_COLUMNS} FROM cert_templates WHERE id = ?1`).bind(csr.template_id).first<TemplateRow>(),
	]);
	if (!root || !template) return badRequest("Stammzertifikat oder Template nicht mehr vorhanden.", 409);

	let pkcs8: Uint8Array;
	try {
		pkcs8 = await decryptSecret(env.MASTER_SECRET, root.key_encrypted);
	} catch {
		return badRequest("Der Root-Key kann nicht entschlüsselt werden (MASTER_SECRET geändert?). Bitte Stammzertifikat neu importieren.", 500);
	}
	try {
		const issued = await issueIntermediate({
			rootCertPem: root.cert_pem,
			rootPkcs8: pkcs8,
			csrPem: csr.csr_pem,
			subject: JSON.parse(csr.approved_subject) as SubjectFields,
			validityDays: csr.approved_validity_days,
			pathLen: template.path_len,
			permittedDns: parseDnsList(template.permitted_dns),
			crlUrl: template.crl_url,
			aiaUrl: template.aia_url,
		});
		const result = await env.DB.prepare(
			`UPDATE csrs SET status = 'issued', cert_pem = ?1, serial_number = ?2, not_before = ?3, not_after = ?4,
			 issued_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?5 AND status = 'approved'`,
		)
			.bind(issued.certPem, issued.serialNumber, issued.notBefore, issued.notAfter, id)
			.run();
		if (!result.meta.changes) return badRequest("Der CSR wurde zwischenzeitlich geändert.", 409);
		return Response.json({ ok: true, status: "issued", truncated: issued.truncated, notAfter: issued.notAfter });
	} catch (e) {
		if (e instanceof PkiError) return badRequest(e.message, 422);
		throw e;
	}
}

adminRouter.get("/csrs/:id/certificate", requireAdmin, async (request: IRequest, env: Env) => {
	const csr = await loadCsr(env, Number(request.params.id));
	if (!csr?.cert_pem) return badRequest("Noch kein Zertifikat vorhanden.", 404);
	const base = safeName(csr.label);
	const format = new URL(request.url).searchParams.get("format");
	if (format === "der") return fileResponse(certPemToDer(csr.cert_pem) as BodyInit, `${base}.cer`, MIME.crt);
	if (format === "chain") {
		const root = await env.DB.prepare("SELECT cert_pem FROM root_cas WHERE id = ?1").bind(csr.root_ca_id).first<{ cert_pem: string }>();
		return fileResponse(`${csr.cert_pem}\n${root?.cert_pem ?? ""}\n`, `${base}-chain.pem`, MIME.pem);
	}
	return fileResponse(csr.cert_pem + "\n", `${base}.pem`, MIME.pem);
});

adminRouter.delete("/csrs/:id", requireAdmin, async (request: IRequest, env: Env) => {
	await env.DB.prepare("DELETE FROM csrs WHERE id = ?1").bind(Number(request.params.id)).run();
	return Response.json({ ok: true });
});
