// E2E gegen `wrangler dev` (BASE, Standard http://localhost:8799).
// Das Captcha-Token wird hier mit dem bekannten Test-MASTER_SECRET selbst
// gebildet – im Server gibt es dafür keine Hintertür.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as x509 from "@peculiar/x509";
import { hmacSign, randomToken } from "../src/crypto";

const BASE = process.env.BASE ?? "http://localhost:8799";
const MASTER = process.env.MASTER_SECRET ?? "test-master-secret-0123456789abcdef";

async function req(path: string, opts: { method?: string; body?: unknown; token?: string; raw?: boolean } = {}) {
	const res = await fetch(BASE + path, {
		method: opts.method ?? (opts.body ? "POST" : "GET"),
		headers: { ...(opts.body ? { "Content-Type": "application/json" } : {}), ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
		body: opts.body ? JSON.stringify(opts.body) : undefined,
	});
	if (opts.raw) return res;
	const data = (await res.json().catch(() => null)) as any;
	return { status: res.status, data };
}

async function captcha(answer: string) {
	const exp = Math.floor(Date.now() / 1000) + 300;
	const nonce = randomToken(12);
	return { captchaToken: `${exp}.${nonce}.${await hmacSign(MASTER, "captcha", `${exp}.${nonce}.${answer}`)}`, captchaAnswer: answer };
}

const step = (s: string) => console.log("•", s);

// 1. Schüler gesperrt, solange kein Passwort gesetzt ist
let r = await req("/api/student/public");
assert.equal(r.data.enabled, false);
step("Schülerseite gesperrt ohne Passwort");

// 2. Admin-Login (Start-Passwort aus Secret)
r = await req("/api/admin/login", { body: { password: "falsch" } });
assert.equal(r.status, 401);
r = await req("/api/admin/login", { body: { password: "startpass-123" } });
assert.equal(r.status, 200);
let admin = r.data.token as string;
assert.equal((await req("/api/admin/roots")).status, 401);
step("Admin-Login");

// 3. Einstellungen: Schülerpasswort + Hinweis + Admin-Passwort ändern
r = await req("/api/admin/settings", { method: "PUT", token: admin, body: { studentPassword: "klasse2025", passwordHint: "Der Name unserer Schule + Jahr" } });
assert.equal(r.status, 200);
r = await req("/api/admin/settings", { method: "PUT", token: admin, body: { adminPassword: "neues-admin-pw-1", currentAdminPassword: "falsch" } });
assert.equal(r.status, 403);
r = await req("/api/admin/settings", { method: "PUT", token: admin, body: { adminPassword: "neues-admin-pw-1", currentAdminPassword: "startpass-123" } });
assert.equal(r.status, 200);
assert.equal((await req("/api/admin/roots", { token: admin })).status, 401, "alte Session muss ungültig sein");
admin = r.data.token;
assert.equal((await req("/api/admin/roots", { token: admin })).status, 200);
assert.equal((await req("/api/admin/login", { body: { password: "startpass-123" } })).status, 401);
assert.equal((await req("/api/admin/login", { body: { password: "neues-admin-pw-1" } })).status, 200);
r = await req("/api/student/public");
assert.deepEqual(r.data, { passwordHint: "Der Name unserer Schule + Jahr", enabled: true });
step("Passwörter + Hinweis, Session-Invalidierung nach Passwortwechsel");

// 4. Root erzeugen, Template anlegen
r = await req("/api/admin/roots/generate", { token: admin, body: { name: "Schul-Root 2025", commonName: "Schule Muster Root CA", org: "Schule Muster", country: "DE", years: 10, keyType: "ec-p384" } });
assert.equal(r.status, 201, JSON.stringify(r.data));
const rootId = r.data.root.id as number;
r = await req("/api/admin/templates", { token: admin, body: { name: "Klasse", validityDays: 365, pathLen: 0, subjectOrg: "Schule Muster", subjectOrgUnit: "Klassen", subjectCountry: "de", permittedDns: "schule.example, .klasse.example" } });
assert.equal(r.status, 201, JSON.stringify(r.data));
const templateId = r.data.template.id as number;
step("Root erzeugt, Template angelegt");

// 5. Schüler-Login: Captcha/Passwort
r = await req("/api/student/login", { body: { password: "klasse2025", captchaToken: "x.y.z", captchaAnswer: "ABCDE" } });
assert.equal(r.status, 400);
const cap = await captcha("K7QM2");
r = await req("/api/student/login", { body: { password: "falsch", ...cap } });
assert.equal(r.status, 401);
r = await req("/api/student/login", { body: { password: "klasse2025", ...cap } });
assert.equal(r.status, 400, "Captcha ist einmalig einlösbar");
r = await req("/api/student/login", { body: { password: "klasse2025", ...(await captcha("K7QM2")) } });
assert.equal(r.status, 200);
const student = r.data.token as string;
assert.equal((await req("/api/student/roots")).status, 401);
assert.equal((await req("/api/student/roots", { token: admin })).status, 401, "Admin-Token ist kein Schüler-Token");
step("Schüler-Login mit Captcha (einmalig) + Passwort");

// 6. Root-Download
r = await req("/api/student/roots", { token: student });
assert.equal(r.data.roots.length, 1);
const dl = (await req(`/api/student/roots/${rootId}/download?format=pem`, { token: student, raw: true })) as Response;
const rootPem = await dl.text();
assert.match(rootPem, /BEGIN CERTIFICATE/);
const der = new Uint8Array(await (await req(`/api/student/roots/${rootId}/download?format=der`, { token: student, raw: true }) as Response).arrayBuffer());
assert.equal(der[0], 0x30);
step("Root-Download PEM/DER");

// 7. CSR hochladen
const alg = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
const keys = (await crypto.subtle.generateKey(alg, true, ["sign", "verify"])) as CryptoKeyPair;
const csr = await x509.Pkcs10CertificateRequestGenerator.create({ name: "CN=FI-25a <script>", keys, signingAlgorithm: alg });
r = await req("/api/student/csrs", { token: student, body: { rootId, label: "FI-25a", csrPem: "kein csr" } });
assert.equal(r.status, 422);
r = await req("/api/student/csrs", { token: student, body: { rootId: 999, label: "FI-25a", csrPem: csr.toString("pem") } });
assert.equal(r.status, 400);
r = await req("/api/student/csrs", { token: student, body: { rootId, label: "FI-25a", csrPem: csr.toString("pem") } });
assert.equal(r.status, 201, JSON.stringify(r.data));
const code = r.data.code as string;
assert.match(code, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
step(`CSR hochgeladen, Code ${code}`);

// 8. Status vor Freigabe
r = await req("/api/student/csrs/lookup", { token: student, body: { code: code.toLowerCase().replace(/-/g, " ") } });
assert.equal(r.data.status, "pending");
assert.equal((await req("/api/student/csrs/lookup", { token: student, body: { code: "AAAA-BBBB-CCCC-DDDD" } })).status, 404);
assert.equal((await req("/api/student/csrs/certificate", { token: student, body: { code } })).status, 409);

// 9. Admin: Queue, freigeben + ausstellen
r = await req("/api/admin/csrs?status=pending", { token: admin });
assert.equal(r.data.csrs.length, 1);
const csrId = r.data.csrs[0].id;
r = await req(`/api/admin/csrs/${csrId}`, { token: admin });
assert.equal(r.data.csr.csrFields.CN, "FI-25a <script>");
assert.equal((await req(`/api/admin/csrs/${csrId}/issue`, { method: "POST", token: admin, body: {} })).status, 409, "ohne Freigabe kein Ausstellen");
r = await req(`/api/admin/csrs/${csrId}/approve`, {
	token: admin,
	body: { templateId, subject: { CN: "FI-25a", O: "Schule Muster", OU: "Klassen", C: "de" }, validityDays: 180, issue: true },
});
assert.equal(r.status, 200, JSON.stringify(r.data));
assert.equal(r.data.status, "issued");
step("Admin: freigegeben + ausgestellt");

// 10. Schüler holt Kette ab und OpenSSL verifiziert
r = await req("/api/student/csrs/lookup", { token: student, body: { code } });
assert.equal(r.data.status, "issued");
const chain = await (await req("/api/student/csrs/certificate", { token: student, body: { code, format: "chain" }, raw: true }) as Response).text();
const dir = mkdtempSync(join(tmpdir(), "e2e-"));
writeFileSync(join(dir, "chain.pem"), chain);
writeFileSync(join(dir, "root.pem"), rootPem);
const certs = chain.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)!;
assert.equal(certs.length, 2);
writeFileSync(join(dir, "int.pem"), certs[0]);
try {
	const out = execFileSync("openssl", ["verify", "-CAfile", join(dir, "root.pem"), join(dir, "int.pem")]).toString();
	assert.match(out, /OK/);
	const text = execFileSync("openssl", ["x509", "-in", join(dir, "int.pem"), "-noout", "-subject", "-dates", "-ext", "basicConstraints,nameConstraints"]).toString();
	console.log(text.trim().split("\n").map((l) => "    " + l).join("\n"));
	assert.match(text, /CN\s*=\s*FI-25a/);
	assert.match(text, /pathlen:0/);
	assert.match(text, /DNS:schule\.example/);
} catch (e: any) {
	if (e.code === "ENOENT") console.log("  (openssl nicht installiert – Verifikation übersprungen)");
	else throw e;
}
step("Zertifikatskette vom Schüler abgerufen, OpenSSL-Verifikation OK");

// 11. Ablehnen-Flow, Löschschutz
const keys2 = (await crypto.subtle.generateKey(alg, true, ["sign", "verify"])) as CryptoKeyPair;
const csr2 = await x509.Pkcs10CertificateRequestGenerator.create({ name: "CN=FI-25b", keys: keys2, signingAlgorithm: alg });
r = await req("/api/student/csrs", { token: student, body: { rootId, label: "FI-25b", csrPem: csr2.toString("pem") } });
const code2 = r.data.code;
const id2 = (await req("/api/admin/csrs?status=pending", { token: admin })).data.csrs[0].id;
assert.equal((await req(`/api/admin/csrs/${id2}/reject`, { token: admin, body: { reason: "Bitte Klassenbezeichnung im CN" } })).status, 200);
r = await req("/api/student/csrs/lookup", { token: student, body: { code: code2 } });
assert.deepEqual([r.data.status, r.data.rejectReason], ["rejected", "Bitte Klassenbezeichnung im CN"]);
assert.equal((await req(`/api/admin/roots/${rootId}`, { method: "DELETE", token: admin })).status, 409);
assert.equal((await req(`/api/admin/roots/${rootId}`, { method: "PATCH", token: admin, body: { isActive: false } })).status, 200);
assert.equal((await req("/api/student/roots", { token: student })).data.roots.length, 0);
step("Ablehnen, Löschschutz, Deaktivieren");

// 12. Rate-Limit Login
let limited = false;
for (let i = 0; i < 12 && !limited; i++) limited = (await req("/api/student/login", { body: { password: "x", ...(await captcha("AAAAA")) } })).status === 429;
assert.ok(limited, "Rate-Limit greift");
step("Rate-Limit Login");
console.log("\nAlle E2E-Prüfungen bestanden");
