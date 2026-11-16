import { Router, type IRequest } from "itty-router";
import { verifyCaptcha } from "../captcha";
import { hashCode, normalizeCode } from "../codes";
import { createPickupToken, pickupCsrId } from "../pickup";
import { constantTimeEqual, decryptSecret, encryptSecret } from "../crypto";
import type { Env } from "../env";
import { badRequest, fileResponse, MIME, readJson, safeName } from "../http";
import {
	analyzeCsr,
	certPemToDer,
	generateQuickRequest,
	issueLeaf,
	locationFieldsOfCert,
	MAX_LEAF_VALIDITY_DAYS,
	remainingDays,
	parseSanList,
	permittedDnsOfCert,
	PkiError,
	sanToString,
	validateCaKey,
} from "../pki";
import { clientIp, rateLimitOk } from "../rateLimit";

// Öffentliche Ressource einer Zwischen-CA (/ca/<token>) – ohne Login. Wer die URL
// kennt, darf Anfragen einreichen und Zertifikate herunterladen. Verwalten
// (freigeben/ablehnen/Schlüssel) darf nur, wer den Abruf-Code der Zwischen-CA kennt.
export const caRouter = Router({ base: "/api/ca" });

const MAX_REQUESTS_PER_CA = 300;
const MAX_CSR_BYTES = 16 * 1024;
const MAX_KEY_BYTES = 8 * 1024;

interface CaRow {
	id: number;
	public_token: string;
	key_encrypted: string | null;
	csr_id: number;
	label: string;
	csr_subject: string;
	ca_cert_pem: string;
	serial_number: string | null;
	not_before: string | null;
	not_after: string | null;
	code_hash: string;
	root_name: string;
	root_cert_pem: string;
}

async function loadCa(env: Env, token: string): Promise<CaRow | null> {
	if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
	return env.DB.prepare(
		`SELECT r.id, r.public_token, r.key_encrypted, c.id AS csr_id, c.label, c.csr_subject, c.cert_pem AS ca_cert_pem,
		        c.serial_number, c.not_before, c.not_after, c.code_hash, root.name AS root_name, root.cert_pem AS root_cert_pem
		 FROM ca_resources r JOIN csrs c ON c.id = r.csr_id JOIN root_cas root ON root.id = c.root_ca_id
		 WHERE r.public_token = ?1 AND c.status = 'issued' AND c.cert_pem IS NOT NULL`,
	)
		.bind(token)
		.first<CaRow>();
}

const notFound = () => badRequest("Diese Zwischenzertifizierungsstelle wurde nicht gefunden.", 404);

// Inhaber-Authentifizierung: Abruf-Sitzung (Token aus Abruf-Code + Captcha), gebunden an genau diese Zwischen-CA.
async function requireOwner(request: IRequest, env: Env, ca: CaRow): Promise<Response | void> {
	if (!(await rateLimitOk(env, `ca-owner:${clientIp(request)}`, 120, 900))) return badRequest("Zu viele Anfragen.", 429);
	const csrId = await pickupCsrId(env, request);
	if (csrId === null || csrId !== ca.csr_id) return badRequest("Inhaber-Sitzung ungültig oder abgelaufen. Bitte mit dem Abruf-Code anmelden.", 401);
}

interface LeafRow {
	id: number;
	kind: string;
	requester: string;
	key_info: string;
	subject_cn: string;
	subject_ou: string;
	subject_email: string;
	san: string;
	status: string;
	reject_reason: string | null;
	serial_number: string | null;
	not_before: string | null;
	not_after: string | null;
	submitted_at: string;
	decided_at: string | null;
}

const LEAF_COLUMNS =
	"id, kind, requester, key_info, subject_cn, subject_ou, subject_email, san, status, reject_reason, serial_number, not_before, not_after, submitted_at, decided_at";

const serializeLeaf = (l: LeafRow, owner = false) => ({
	id: l.id,
	kind: l.kind,
	cn: l.subject_cn,
	ou: l.subject_ou,
	san: l.san,
	status: l.status,
	rejectReason: l.reject_reason,
	serialNumber: l.serial_number,
	notBefore: l.not_before,
	notAfter: l.not_after,
	submittedAt: l.submitted_at,
	keyInfo: l.key_info,
	// nur für den Inhaber (Freigabeformular)
	...(owner ? { requester: l.requester, email: l.subject_email } : {}),
});

// ---- Öffentlich ----------------------------------------------------------------

caRouter.get("/:token", async (request: IRequest, env: Env) => {
	const ca = await loadCa(env, request.params.token);
	if (!ca) return notFound();
	const { results } = await env.DB.prepare(`SELECT ${LEAF_COLUMNS} FROM leaf_requests WHERE ca_id = ?1 ORDER BY submitted_at DESC LIMIT 500`)
		.bind(ca.id)
		.all<LeafRow>();
	return Response.json(
		{
			name: ca.label,
			subject: ca.csr_subject,
			serialNumber: ca.serial_number,
			notBefore: ca.not_before,
			notAfter: ca.not_after,
			rootName: ca.root_name,
			permittedDns: permittedDnsOfCert(ca.ca_cert_pem),
			maxValidityDays: validityLimits(ca).maxValidityDays,
			keyStored: Boolean(ca.key_encrypted),
			certificates: results.map((r) => serializeLeaf(r)),
		},
		{ headers: { "Cache-Control": "no-store" } },
	);
});

caRouter.get("/:token/ca-certificate", async (request: IRequest, env: Env) => {
	const ca = await loadCa(env, request.params.token);
	if (!ca) return notFound();
	const base = safeName(ca.label);
	const format = new URL(request.url).searchParams.get("format");
	if (format === "der") return fileResponse(certPemToDer(ca.ca_cert_pem) as BodyInit, `${base}.cer`, MIME.crt);
	if (format === "chain") return fileResponse(`${ca.ca_cert_pem}\n${ca.root_cert_pem}\n`, `${base}-chain.pem`, MIME.pem);
	return fileResponse(ca.ca_cert_pem + "\n", `${base}.pem`, MIME.pem);
});

caRouter.get("/:token/certificates/:id", async (request: IRequest, env: Env) => {
	const ca = await loadCa(env, request.params.token);
	if (!ca) return notFound();
	const leaf = await env.DB.prepare("SELECT subject_cn, cert_pem FROM leaf_requests WHERE id = ?1 AND ca_id = ?2 AND status = 'issued'")
		.bind(Number(request.params.id), ca.id)
		.first<{ subject_cn: string; cert_pem: string }>();
	if (!leaf?.cert_pem) return badRequest("Zertifikat nicht gefunden.", 404);
	const base = safeName(leaf.subject_cn);
	const format = new URL(request.url).searchParams.get("format");
	if (format === "der") return fileResponse(certPemToDer(leaf.cert_pem) as BodyInit, `${base}.cer`, MIME.crt);
	// "chain" = Zertifikat + Zwischenzertifikat (üblich für Server), "fullchain" zusätzlich Root
	if (format === "chain") return fileResponse(`${leaf.cert_pem}\n${ca.ca_cert_pem}\n`, `${base}-chain.pem`, MIME.pem);
	if (format === "fullchain") return fileResponse(`${leaf.cert_pem}\n${ca.ca_cert_pem}\n${ca.root_cert_pem}\n`, `${base}-fullchain.pem`, MIME.pem);
	return fileResponse(leaf.cert_pem + "\n", `${base}.pem`, MIME.pem);
});

async function guardPublicSubmit(request: IRequest, env: Env, ca: CaRow, body: { captchaToken?: string; captchaAnswer?: string } | null): Promise<Response | void> {
	if (!(await rateLimitOk(env, `ca-submit:${clientIp(request)}`, 20, 3600))) return badRequest("Zu viele Anfragen. Bitte später erneut versuchen.", 429);
	if (!(await verifyCaptcha(env, body?.captchaToken, body?.captchaAnswer))) return badRequest("Captcha falsch oder abgelehnt. Bitte ein neues lösen.");
	const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM leaf_requests WHERE ca_id = ?1").bind(ca.id).first<{ n: number }>();
	if ((count?.n ?? 0) >= MAX_REQUESTS_PER_CA) return badRequest("Für diese Zwischenzertifizierungsstelle sind keine weiteren Anfragen möglich.", 409);
}

const cleanText = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// OU und E-Mail sind Pflicht, damit der Inhaber die Antragsteller identifizieren kann.
function requireIdentity(ouRaw: unknown, emailRaw: unknown): { error: string } | { ou: string; email: string } {
	const ou = cleanText(ouRaw, 64);
	const email = cleanText(emailRaw, 120);
	if (!ou) return { error: "Bitte die Abteilung/Klasse (OU) angeben – sie dient zur Identifizierung des Antragstellers." };
	if (!email || !EMAIL_RE.test(email)) return { error: "Bitte eine gültige E-Mail-Adresse angeben – sie dient zur Identifizierung des Antragstellers." };
	return { ou, email };
}

// Zulässige Laufzeit für Endzertifikate: höchstens 825 Tage, nie länger als die Restlaufzeit der Zwischen-CA.
function validityLimits(ca: CaRow) {
	const max = Math.min(MAX_LEAF_VALIDITY_DAYS, remainingDays(ca.ca_cert_pem));
	return { maxValidityDays: max, defaultValidityDays: Math.min(365, max) };
}

// Eigenen CSR einreichen.
caRouter.post("/:token/requests", async (request: IRequest, env: Env) => {
	const ca = await loadCa(env, request.params.token);
	if (!ca) return notFound();
	const body = await readJson<{ captchaToken?: string; captchaAnswer?: string; requester?: string; csrPem?: string; ou?: string; email?: string }>(request);
	const denied = await guardPublicSubmit(request, env, ca, body);
	if (denied) return denied;
	const identity = requireIdentity(body?.ou, body?.email);
	if ("error" in identity) return badRequest(identity.error);
	const csrPem = body?.csrPem?.trim();
	if (!csrPem) return badRequest("Bitte einen CSR einfügen oder hochladen.");
	if (csrPem.length > MAX_CSR_BYTES) return badRequest("Der CSR ist zu groß.");
	if (/PRIVATE KEY/.test(csrPem)) return badRequest("Das ist ein Private Key! Bitte nur den CSR einreichen.");
	try {
		const info = await analyzeCsr(csrPem);
		const row = await env.DB.prepare(
			`INSERT INTO leaf_requests (ca_id, kind, requester, csr_pem, key_info, subject_cn, subject_ou, subject_email, san)
			 VALUES (?1, 'csr', ?2, ?3, ?4, ?5, ?6, ?7, ?8) RETURNING id`,
		)
			.bind(ca.id, cleanText(body?.requester, 80), csrPem, info.keyInfo, (info.cn ?? "").slice(0, 64), identity.ou, identity.email, sanToString(info.sans))
			.first<{ id: number }>();
		return Response.json({ id: row!.id, subject: info.subject }, { status: 201 });
	} catch (e) {
		if (e instanceof PkiError) return badRequest(e.message, 422);
		throw e;
	}
});

// Quick-Zertifikat: Schlüssel + CSR werden hier erzeugt. Der Private Key steht
// ausschließlich in dieser Antwort und wird nicht gespeichert.
caRouter.post("/:token/quick", async (request: IRequest, env: Env) => {
	const ca = await loadCa(env, request.params.token);
	if (!ca) return notFound();
	const body = await readJson<{ captchaToken?: string; captchaAnswer?: string; requester?: string; cn?: string; ou?: string; san?: string; email?: string }>(request);
	const denied = await guardPublicSubmit(request, env, ca, body);
	if (denied) return denied;
	const cn = cleanText(body?.cn, 64);
	if (!cn) return badRequest("Bitte den Common Name (CN) angeben, z. B. den Hostnamen.");
	const identity = requireIdentity(body?.ou, body?.email);
	if ("error" in identity) return badRequest(identity.error);
	const { ou, email } = identity;
	try {
		const sans = parseSanList(body?.san);
		if (!sans.length) return badRequest("Bitte mindestens einen SAN-Eintrag angeben (DNS-Name, IP oder E-Mail), z. B. den Hostnamen.");
		const quick = await generateQuickRequest({ cn, ou, email, sans });
		const row = await env.DB.prepare(
			`INSERT INTO leaf_requests (ca_id, kind, requester, csr_pem, key_info, subject_cn, subject_ou, subject_email, san)
			 VALUES (?1, 'quick', ?2, ?3, ?4, ?5, ?6, ?7, ?8) RETURNING id`,
		)
			.bind(ca.id, cleanText(body?.requester, 80), quick.csrPem, quick.keyInfo, cn, ou, email, sanToString(sans))
			.first<{ id: number }>();
		return Response.json(
			{ id: row!.id, privateKeyPem: quick.privateKeyPem, keyInfo: quick.keyInfo, san: sanToString(sans) },
			{ status: 201, headers: { "Cache-Control": "no-store" } },
		);
	} catch (e) {
		if (e instanceof PkiError) return badRequest(e.message, 422);
		throw e;
	}
});

// ---- Inhaber (Abruf-Sitzung) --------------------------------------------------------

// Inhaber-Anmeldung auf der Klassen-Seite: Abruf-Code + Captcha -> Abruf-Sitzung.
caRouter.post("/:token/owner/login", async (request: IRequest, env: Env) => {
	const ca = await loadCa(env, request.params.token);
	if (!ca) return notFound();
	if (!(await rateLimitOk(env, `ca-owner-login:${clientIp(request)}`, 15, 900))) return badRequest("Zu viele Anmeldeversuche. Bitte in einigen Minuten erneut versuchen.", 429);
	const body = await readJson<{ code?: string; captchaToken?: string; captchaAnswer?: string }>(request);
	if (!(await verifyCaptcha(env, body?.captchaToken, body?.captchaAnswer))) return badRequest("Captcha falsch oder abgelaufen. Bitte ein neues lösen.");
	const code = normalizeCode(body?.code);
	if (!code || !constantTimeEqual(await hashCode(code), ca.code_hash)) return badRequest("Abruf-Code ungültig.", 401);
	return Response.json({ ownerToken: await createPickupToken(env, ca.csr_id) });
});

caRouter.get("/:token/owner", async (request: IRequest, env: Env) => {
	const ca = await loadCa(env, request.params.token);
	if (!ca) return notFound();
	const denied = await requireOwner(request, env, ca);
	if (denied) return denied;
	const { results } = await env.DB.prepare(`SELECT ${LEAF_COLUMNS} FROM leaf_requests WHERE ca_id = ?1 ORDER BY submitted_at DESC LIMIT 500`).bind(ca.id).all<LeafRow>();
	return Response.json({
		keyStored: Boolean(ca.key_encrypted),
		...validityLimits(ca),
		defaults: locationFieldsOfCert(ca.ca_cert_pem), // C, ST, L, O aus dem Zwischenzertifikat
		requests: results.map((r) => serializeLeaf(r, true)),
	});
});

// Private Key der Zwischen-CA dauerhaft hinterlegen (verschlüsselt).
caRouter.put("/:token/owner/key", async (request: IRequest, env: Env) => {
	const ca = await loadCa(env, request.params.token);
	if (!ca) return notFound();
	const denied = await requireOwner(request, env, ca);
	if (denied) return denied;
	const body = await readJson<{ keyPem?: string }>(request);
	if (!body?.keyPem || body.keyPem.length > MAX_KEY_BYTES) return badRequest("Bitte den Private Key (PKCS#8, PEM) angeben.");
	try {
		const pkcs8 = await validateCaKey(ca.ca_cert_pem, body.keyPem);
		await env.DB.prepare("UPDATE ca_resources SET key_encrypted = ?1 WHERE id = ?2").bind(await encryptSecret(env.MASTER_SECRET, pkcs8, "ca-key"), ca.id).run();
		return Response.json({ ok: true, keyStored: true });
	} catch (e) {
		if (e instanceof PkiError) return badRequest(e.message, 422);
		throw e;
	}
});

caRouter.delete("/:token/owner/key", async (request: IRequest, env: Env) => {
	const ca = await loadCa(env, request.params.token);
	if (!ca) return notFound();
	const denied = await requireOwner(request, env, ca);
	if (denied) return denied;
	await env.DB.prepare("UPDATE ca_resources SET key_encrypted = NULL WHERE id = ?1").bind(ca.id).run();
	return Response.json({ ok: true, keyStored: false });
});

// Freigeben = Zertifikat ausstellen. Mit hinterlegtem Key sofort; sonst muss der
// Key mitgeschickt werden (wird nur im Request verwendet, nicht gespeichert).
caRouter.post("/:token/owner/requests/:id/approve", async (request: IRequest, env: Env) => {
	const ca = await loadCa(env, request.params.token);
	if (!ca) return notFound();
	const denied = await requireOwner(request, env, ca);
	if (denied) return denied;
	const req = await env.DB.prepare("SELECT id, csr_pem, status FROM leaf_requests WHERE id = ?1 AND ca_id = ?2")
		.bind(Number(request.params.id), ca.id)
		.first<{ id: number; csr_pem: string; status: string }>();
	if (!req) return badRequest("Anfrage nicht gefunden.", 404);
	if (req.status === "issued") return badRequest("Für diese Anfrage wurde bereits ein Zertifikat ausgestellt.", 409);

	const body = await readJson<{
		cn?: string;
		ou?: string;
		email?: string;
		san?: string;
		validityDays?: number;
		keyPem?: string;
		subject?: { C?: string; ST?: string; L?: string; O?: string };
	}>(request);
	const cn = cleanText(body?.cn, 64);
	if (!cn) return badRequest("Common Name (CN) ist erforderlich.");
	const identity = requireIdentity(body?.ou, body?.email);
	if ("error" in identity) return badRequest(identity.error);
	const { ou, email } = identity;

	// C/ST/L/O: Vorbelegung aus dem Zwischenzertifikat, vom Inhaber anpassbar (leer = weglassen).
	const defaults = locationFieldsOfCert(ca.ca_cert_pem);
	const loc = { ...defaults };
	for (const k of ["C", "ST", "L", "O"] as const) {
		const v = body?.subject?.[k];
		if (typeof v === "string") loc[k] = v.trim().slice(0, 64);
	}
	loc.C = loc.C.toUpperCase();
	if (loc.C && !/^[A-Z]{2}$/.test(loc.C)) return badRequest("Land (C): zweistelliger ISO-Code, z. B. DE.");

	const limits = validityLimits(ca);
	const validityDays = Number(body?.validityDays ?? limits.defaultValidityDays);
	if (!Number.isInteger(validityDays) || validityDays < 1) return badRequest("Ungültige Gültigkeitsdauer.");
	if (validityDays > limits.maxValidityDays) {
		return badRequest(`Die Laufzeit darf höchstens ${limits.maxValidityDays} Tage betragen (Restlaufzeit der Zwischenzertifizierungsstelle bzw. Maximum ${MAX_LEAF_VALIDITY_DAYS} Tage).`);
	}

	try {
		const sans = parseSanList(body?.san);
		let pkcs8: Uint8Array;
		if (ca.key_encrypted) {
			try {
				pkcs8 = await decryptSecret(env.MASTER_SECRET, ca.key_encrypted, "ca-key");
			} catch {
				return badRequest("Der hinterlegte Schlüssel kann nicht entschlüsselt werden. Bitte neu hinterlegen oder beim Freigeben hochladen.", 500);
			}
		} else {
			if (!body?.keyPem || body.keyPem.length > MAX_KEY_BYTES) return badRequest("Es ist kein Schlüssel hinterlegt. Bitte den Private Key der Zwischen-CA beim Freigeben angeben.");
			pkcs8 = await validateCaKey(ca.ca_cert_pem, body.keyPem);
		}
		const issued = await issueLeaf({
			caCertPem: ca.ca_cert_pem,
			caPkcs8: pkcs8,
			csrPem: req.csr_pem,
			subject: { C: loc.C || undefined, ST: loc.ST || undefined, L: loc.L || undefined, O: loc.O || undefined, OU: ou, CN: cn, E: email },
			sans,
			validityDays,
		});
		await env.DB.prepare(
			`UPDATE leaf_requests SET status = 'issued', cert_pem = ?1, serial_number = ?2, not_before = ?3, not_after = ?4,
			 subject_cn = ?5, subject_ou = ?6, subject_email = ?7, san = ?8, reject_reason = NULL, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
			 WHERE id = ?9 AND status != 'issued'`,
		)
			.bind(issued.certPem, issued.serialNumber, issued.notBefore, issued.notAfter, cn, ou, email, sanToString(sans), req.id)
			.run();
		return Response.json({ ok: true, truncated: issued.truncated, notAfter: issued.notAfter });
	} catch (e) {
		if (e instanceof PkiError) return badRequest(e.message, 422);
		throw e;
	}
});

caRouter.post("/:token/owner/requests/:id/reject", async (request: IRequest, env: Env) => {
	const ca = await loadCa(env, request.params.token);
	if (!ca) return notFound();
	const denied = await requireOwner(request, env, ca);
	if (denied) return denied;
	const body = await readJson<{ reason?: string }>(request);
	const result = await env.DB.prepare(
		"UPDATE leaf_requests SET status = 'rejected', reject_reason = ?1, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?2 AND ca_id = ?3 AND status != 'issued'",
	)
		.bind(cleanText(body?.reason, 300) || null, Number(request.params.id), ca.id)
		.run();
	if (!result.meta.changes) return badRequest("Anfrage nicht gefunden oder bereits ausgestellt.", 409);
	return Response.json({ ok: true });
});

caRouter.delete("/:token/owner/requests/:id", async (request: IRequest, env: Env) => {
	const ca = await loadCa(env, request.params.token);
	if (!ca) return notFound();
	const denied = await requireOwner(request, env, ca);
	if (denied) return denied;
	await env.DB.prepare("DELETE FROM leaf_requests WHERE id = ?1 AND ca_id = ?2").bind(Number(request.params.id), ca.id).run();
	return Response.json({ ok: true });
});
