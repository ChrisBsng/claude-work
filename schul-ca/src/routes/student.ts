import { Router, type IRequest } from "itty-router";
import { checkPassword, getSetting, issueToken, requireStudent } from "../auth";
import { createCaptcha, verifyCaptcha } from "../captcha";
import { generateCode, hashCode, normalizeCode } from "../codes";
import type { Env } from "../env";
import { badRequest, fileResponse, MIME, readJson, safeName } from "../http";
import { analyzeCsr, certPemToDer, PkiError } from "../pki";
import { randomToken } from "../crypto";
import { createPickupToken, pickupCsrId } from "../pickup";
import { validateContact } from "../contact";
import { clientIp, rateLimitOk } from "../rateLimit";

export const studentRouter = Router({ base: "/api/student" });

const MAX_CSR_BYTES = 16 * 1024;
const MAX_LABEL_LENGTH = 80;


// Öffentlich: Stammzertifikate (nur das Zertifikat, nie der Key) und Passworthinweis.
// Öffentlich: Passworthinweis + ob die Schüleroberfläche überhaupt freigeschaltet ist.
studentRouter.get("/public", async (_request: IRequest, env: Env) => {
	const [hint, hash] = await Promise.all([getSetting(env.DB, "password_hint"), getSetting(env.DB, "student_password_hash")]);
	return Response.json({ passwordHint: hint ?? "", enabled: Boolean(hash) });
});

studentRouter.get("/captcha", async (request: IRequest, env: Env) => {
	if (!(await rateLimitOk(env, `captcha:${clientIp(request)}`, 60, 600))) return badRequest("Zu viele Anfragen.", 429);
	return Response.json(await createCaptcha(env), { headers: { "Cache-Control": "no-store" } });
});

studentRouter.post("/login", async (request: IRequest, env: Env) => {
	const ip = clientIp(request);
	if (!(await rateLimitOk(env, `student-login:${ip}`, 10, 900))) {
		return badRequest("Zu viele Anmeldeversuche. Bitte in einigen Minuten erneut versuchen.", 429);
	}
	const body = await readJson<{ password?: string; captchaToken?: string; captchaAnswer?: string }>(request);
	if (!body?.password) return badRequest("Passwort fehlt.");
	// Captcha zuerst: kostet bei Bots nichts, spart uns den PBKDF2-Lauf.
	if (!(await verifyCaptcha(env, body.captchaToken, body.captchaAnswer))) {
		return badRequest("Captcha falsch oder abgelaufen. Bitte ein neues lösen.", 400);
	}
	if (!(await checkPassword(env, "student", body.password))) return badRequest("Falsches Passwort.", 401);
	return Response.json({ token: await issueToken(env, "student") });
});

studentRouter.get("/session", requireStudent, () => Response.json({ ok: true }));

studentRouter.get("/roots", async (_request: IRequest, env: Env) => {
	const { results } = await env.DB.prepare(
		"SELECT id, name, subject, fingerprint_sha256, key_algorithm, not_before, not_after FROM root_cas WHERE is_active = 1 AND not_after > ?1 ORDER BY name",
	)
		.bind(new Date().toISOString())
		.all<{ id: number; name: string; subject: string; fingerprint_sha256: string; key_algorithm: string; not_before: string; not_after: string }>();
	return Response.json({
		roots: results.map((r) => ({
			id: r.id,
			name: r.name,
			subject: r.subject,
			fingerprint: r.fingerprint_sha256,
			keyAlgorithm: r.key_algorithm,
			notBefore: r.not_before,
			notAfter: r.not_after,
		})),
	});
});

studentRouter.get("/roots/:id/download", async (request: IRequest, env: Env) => {
	const root = await env.DB.prepare("SELECT name, cert_pem FROM root_cas WHERE id = ?1 AND is_active = 1")
		.bind(Number(request.params.id))
		.first<{ name: string; cert_pem: string }>();
	if (!root) return badRequest("Stammzertifikat nicht gefunden.", 404);
	const base = safeName(root.name);
	const format = new URL(request.url).searchParams.get("format");
	if (format === "der") return fileResponse(certPemToDer(root.cert_pem) as BodyInit, `${base}.cer`, MIME.crt);
	if (format === "pem") return fileResponse(root.cert_pem + "\n", `${base}.pem`, MIME.pem);
	return fileResponse(root.cert_pem + "\n", `${base}.crt`, MIME.crt);
});

// CSR hochladen. Antwort enthält den Abruf-Code – das ist die einzige
// Gelegenheit, ihn im Klartext zu sehen.
studentRouter.post("/csrs", requireStudent, async (request: IRequest, env: Env) => {
	if (!(await rateLimitOk(env, `csr-upload:${clientIp(request)}`, 20, 3600))) {
		return badRequest("Zu viele Uploads. Bitte später erneut versuchen.", 429);
	}
	const body = await readJson<{ rootId?: number; label?: string; csrPem?: string; contactPerson?: string; contactMethod?: string; contactDetail?: string }>(request);
	const label = body?.label?.trim();
	const csrPem = body?.csrPem?.trim();
	if (!label || label.length > MAX_LABEL_LENGTH) return badRequest(`Bitte die Klasse/Bezeichnung angeben (max. ${MAX_LABEL_LENGTH} Zeichen).`);
	const contact = validateContact(body?.contactPerson, body?.contactMethod, body?.contactDetail);
	if ("error" in contact) return badRequest(contact.error);
	if (!csrPem) return badRequest("Bitte einen CSR einfügen oder hochladen.");
	if (csrPem.length > MAX_CSR_BYTES) return badRequest("Der CSR ist zu groß.");

	const root = await env.DB.prepare("SELECT id FROM root_cas WHERE id = ?1 AND is_active = 1 AND not_after > ?2")
		.bind(Number(body?.rootId), new Date().toISOString())
		.first<{ id: number }>();
	if (!root) return badRequest("Bitte ein gültiges Stammzertifikat auswählen.");

	let info;
	try {
		info = await analyzeCsr(csrPem);
	} catch (e) {
		if (e instanceof PkiError) return badRequest(e.message, 422);
		throw e;
	}

	const code = generateCode();
	await env.DB.prepare(
		"INSERT INTO csrs (root_ca_id, label, csr_pem, csr_subject, key_info, code_hash, contact_person, contact_method, contact_detail) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
	)
		.bind(root.id, label, csrPem, info.subject, info.keyInfo, await hashCode(normalizeCode(code)!), contact.person, contact.method, contact.detail)
		.run();
	return Response.json({ code, subject: info.subject, keyInfo: info.keyInfo }, { status: 201 });
});

interface CsrLookupRow {
	id: number;
	code_hash: string;
	label: string;
	csr_subject: string;
	key_info: string;
	status: string;
	reject_reason: string | null;
	cert_pem: string | null;
	not_before: string | null;
	not_after: string | null;
	submitted_at: string;
	root_name: string;
	root_cert_pem: string;
}

const CSR_LOOKUP_SQL = `SELECT c.id, c.code_hash, c.label, c.csr_subject, c.key_info, c.status, c.reject_reason, c.cert_pem, c.not_before, c.not_after, c.submitted_at,
		        r.name AS root_name, r.cert_pem AS root_cert_pem
		 FROM csrs c JOIN root_cas r ON r.id = c.root_ca_id`;

// Abruf mit Code + Captcha (kein Schülerpasswort nötig).
async function lookupByCode(request: IRequest, env: Env, body: { code?: string; captchaToken?: string; captchaAnswer?: string } | null): Promise<CsrLookupRow | Response> {
	if (!(await rateLimitOk(env, `csr-lookup:${clientIp(request)}`, 30, 900))) {
		return badRequest("Zu viele Abrufe. Bitte in einigen Minuten erneut versuchen.", 429);
	}
	if (!(await verifyCaptcha(env, body?.captchaToken, body?.captchaAnswer))) {
		return badRequest("Captcha falsch oder abgelaufen. Bitte ein neues lösen.", 400);
	}
	const code = normalizeCode(body?.code);
	if (!code) return badRequest("Ungültiger Abruf-Code (16 Zeichen, z. B. K7QM-4TXD-9WPB-2HNC).");
	const row = await env.DB.prepare(`${CSR_LOOKUP_SQL} WHERE c.code_hash = ?1`).bind(await hashCode(code)).first<CsrLookupRow>();
	return row ?? badRequest("Zu diesem Code wurde nichts gefunden.", 404);
}

// Folgeaktionen mit der Abruf-Sitzung (Token aus dem Abruf).
async function rowFromPickup(request: IRequest, env: Env): Promise<CsrLookupRow | Response> {
	const csrId = await pickupCsrId(env, request);
	if (csrId === null) return badRequest("Abruf-Sitzung abgelaufen. Bitte den Abruf-Code erneut eingeben.", 401);
	const row = await env.DB.prepare(`${CSR_LOOKUP_SQL} WHERE c.id = ?1`).bind(csrId).first<CsrLookupRow>();
	return row ?? badRequest("Nicht gefunden.", 404);
}

studentRouter.post("/csrs/lookup", async (request: IRequest, env: Env) => {
	const body = await readJson<{ code?: string; captchaToken?: string; captchaAnswer?: string }>(request);
	const row = await lookupByCode(request, env, body);
	if (row instanceof Response) return row;
	const managed = await env.DB.prepare("SELECT public_token, key_encrypted IS NOT NULL AS has_key FROM ca_resources WHERE csr_id = ?1")
		.bind(row.id)
		.first<{ public_token: string; has_key: number }>();
	return Response.json({
		pickupToken: await createPickupToken(env, row.id, row.code_hash),
		management: row.status === "issued" ? { enabled: Boolean(managed), token: managed?.public_token ?? null, keyStored: Boolean(managed?.has_key) } : null,
		label: row.label,
		subject: row.csr_subject,
		keyInfo: row.key_info,
		status: row.status,
		rejectReason: row.status === "rejected" ? row.reject_reason : null,
		rootName: row.root_name,
		submittedAt: row.submitted_at,
		notBefore: row.not_before,
		notAfter: row.not_after,
	});
});

studentRouter.post("/csrs/certificate", async (request: IRequest, env: Env) => {
	const row = await rowFromPickup(request, env);
	if (row instanceof Response) return row;
	const body = await readJson<{ format?: string }>(request);
	if (row.status !== "issued" || !row.cert_pem) return badRequest("Das Zertifikat ist noch nicht ausgestellt.", 409);
	const base = safeName(row.label);
	switch (body?.format) {
		case "der":
			return fileResponse(certPemToDer(row.cert_pem) as BodyInit, `${base}.cer`, MIME.crt);
		case "chain":
			return fileResponse(`${row.cert_pem}\n${row.root_cert_pem}\n`, `${base}-chain.pem`, MIME.pem);
		default:
			return fileResponse(row.cert_pem + "\n", `${base}.pem`, MIME.pem);
	}
});

// "Ich möchte die Zwischenzertifizierungsstelle hier verwalten": legt die eigene
// Ressource (öffentliche Klassen-URL) an bzw. entfernt sie samt Anfragen und
// hinterlegtem Schlüssel wieder.
studentRouter.post("/csrs/manage", async (request: IRequest, env: Env) => {
	const row = await rowFromPickup(request, env);
	if (row instanceof Response) return row;
	const body = await readJson<{ enable?: boolean }>(request);
	if (row.status !== "issued") return badRequest("Die Verwaltung ist erst nach Ausstellung des Zwischenzertifikats möglich.", 409);

	if (body?.enable === false) {
		await env.DB.prepare("DELETE FROM ca_resources WHERE csr_id = ?1").bind(row.id).run();
		return Response.json({ enabled: false, token: null });
	}
	const existing = await env.DB.prepare("SELECT public_token FROM ca_resources WHERE csr_id = ?1").bind(row.id).first<{ public_token: string }>();
	if (existing) return Response.json({ enabled: true, token: existing.public_token });
	const token = randomToken(16);
	await env.DB.prepare("INSERT INTO ca_resources (csr_id, public_token) VALUES (?1, ?2)").bind(row.id, token).run();
	return Response.json({ enabled: true, token }, { status: 201 });
});
