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
import { generateRoot } from "../src/pki";

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

// Abruf mit Abruf-Code + Captcha – bewusst OHNE Schülerpasswort/-Session.
const lookup = async (c: string) => req("/api/student/csrs/lookup", { body: { code: c, ...(await captcha("LOOKP")) } });

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
const offline = await generateRoot({ commonName: "Schule Muster Root CA", org: "Schule Muster", country: "DE", years: 10, keyType: "ec-p384" });
const keyPem = x509.PemConverter.encode(offline.pkcs8 as any, "PRIVATE KEY");
assert.equal((await req("/api/admin/roots/generate", { token: admin, body: {} })).status, 404, "Erzeugen im Worker entfernt");
r = await req("/api/admin/roots/import", { token: admin, body: { name: "Schul-Root 2025", certPem: offline.info.certPem, keyPem } });
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
assert.equal((await req("/api/student/session")).status, 401);
assert.equal((await req("/api/student/session", { token: admin })).status, 401, "Admin-Token ist kein Schüler-Token");
assert.equal((await req("/api/student/csrs", { body: {} })).status, 401, "Upload nur angemeldet");
step("Schüler-Login mit Captcha (einmalig) + Passwort");

// 6. Root-Download (öffentlich, ohne Login)
r = await req("/api/student/roots");
assert.equal(r.data.roots.length, 1);
assert.ok(!JSON.stringify(r.data).includes("PRIVATE"));
const dl = (await req(`/api/student/roots/${rootId}/download?format=pem`, { raw: true })) as Response;
const rootPem = await dl.text();
assert.match(rootPem, /BEGIN CERTIFICATE/);
const der = new Uint8Array(await (await req(`/api/student/roots/${rootId}/download?format=der`, { raw: true }) as Response).arrayBuffer());
assert.equal(der[0], 0x30);
step("Root-Download PEM/DER");

// 7. CSR hochladen
const alg = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
const keys = (await crypto.subtle.generateKey(alg, true, ["sign", "verify"])) as CryptoKeyPair;
const csr = await x509.Pkcs10CertificateRequestGenerator.create({ name: "CN=FI-25a <script>", keys, signingAlgorithm: alg });
r = await req("/api/student/csrs", { token: student, body: { rootId, label: "FI-25a", csrPem: "kein csr", contactPerson: "Max Mustermann", contactMethod: "email", contactDetail: "max@schule.example" } });
assert.equal(r.status, 422);
const noCn = await x509.Pkcs10CertificateRequestGenerator.create({ name: "O=Nur Org", keys, signingAlgorithm: alg });
r = await req("/api/student/csrs", { token: student, body: { rootId, label: "x", csrPem: noCn.toString("pem"), contactPerson: "Max Mustermann", contactMethod: "email", contactDetail: "max@schule.example" } });
assert.equal(r.status, 422);
assert.match(r.data.error, /Common Name/);
r = await req("/api/student/csrs", { token: student, body: { rootId: 999, label: "FI-25a", csrPem: csr.toString("pem"), contactPerson: "Max Mustermann", contactMethod: "email", contactDetail: "max@schule.example" } });
assert.equal(r.status, 400);
const validCsr = csr.toString("pem");
const bad = (extra: Record<string, unknown>) => req("/api/student/csrs", { token: student, body: { rootId, label: "FI-25a", csrPem: validCsr, contactPerson: "Max Mustermann", contactMethod: "email", contactDetail: "max@schule.example", ...extra } });
for (const extra of [{ contactPerson: "" }, { contactPerson: "M" }, { contactMethod: "" }, { contactMethod: "fax" }, { contactDetail: "" }, { contactDetail: "keine-mail" }, { contactMethod: "phone", contactDetail: "abc" }]) {
	r = await bad(extra);
	assert.equal(r.status, 400, JSON.stringify(extra) + " muss abgelehnt werden");
}
r = await req("/api/student/csrs", { token: student, body: { rootId, label: "FI-25a", csrPem: validCsr } });
assert.equal(r.status, 400, "ohne Kontaktangaben kein Upload");
r = await req("/api/student/csrs", { token: student, body: { rootId, label: "FI-25a", csrPem: validCsr, contactPerson: "Max Mustermann", contactMethod: "email", contactDetail: "max@schule.example" } });
assert.equal(r.status, 201, JSON.stringify(r.data));
let code = r.data.code as string;
assert.match(code, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
step(`CSR hochgeladen, Code ${code}`);

// 8. Status vor Freigabe
assert.equal((await req("/api/student/csrs/lookup", { body: { code } })).status, 400, "Abruf ohne Captcha abgelehnt");
assert.equal((await req("/api/student/csrs/lookup", { body: { code, ...(await captcha("AAAAA")), captchaAnswer: "FALSCH" } })).status, 400, "Abruf mit falschem Captcha abgelehnt");
r = await lookup(code.toLowerCase().replace(/-/g, " "));
assert.equal(r.status, 200, "Abruf nur mit Code + Captcha, ohne Schülerpasswort");
assert.equal(r.data.status, "pending");
const pickup = r.data.pickupToken as string;
assert.ok(pickup);
assert.equal((await lookup("AAAA-BBBB-CCCC-DDDD")).status, 404);
assert.equal((await req("/api/student/csrs/certificate", { body: { format: "pem" } })).status, 401, "Download ohne Abruf-Sitzung");
assert.equal((await req("/api/student/csrs/certificate", { token: student, body: { format: "pem" } })).status, 401, "Schüler-Session ersetzt keine Abruf-Sitzung");
assert.equal((await req("/api/student/csrs/certificate", { token: pickup.slice(0, -2) + "xx", body: { format: "pem" } })).status, 401, "manipuliertes Token");
assert.equal((await req("/api/student/csrs/certificate", { token: pickup, body: { format: "pem" } })).status, 409);

// 9. Admin: Queue, freigeben + ausstellen
r = await req("/api/admin/csrs?status=pending", { token: admin });
assert.equal(r.data.csrs.length, 1);
const csrId = r.data.csrs[0].id;
r = await req(`/api/admin/csrs/${csrId}`, { token: admin });
assert.equal(r.data.csr.csrFields.CN, "FI-25a <script>");
assert.deepEqual([r.data.csr.contactPerson, r.data.csr.contactMethod, r.data.csr.contactDetail], ["Max Mustermann", "email", "max@schule.example"]);
assert.ok(!JSON.stringify((await lookup(code)).data).includes("max@schule"), "Kontaktdaten nicht für Schüler abrufbar");
assert.equal((await req(`/api/admin/csrs/${csrId}/issue`, { method: "POST", token: admin, body: {} })).status, 409, "ohne Freigabe kein Ausstellen");
r = await req(`/api/admin/csrs/${csrId}/approve`, {
	token: admin,
	body: { templateId, subject: { CN: "FI-25a", O: "Schule Muster", OU: "Klassen", C: "de" }, validityDays: 180, issue: true },
});
assert.equal(r.status, 200, JSON.stringify(r.data));
assert.equal(r.data.status, "issued");
step("Admin: freigegeben + ausgestellt");

// 10. Schüler holt Kette ab und OpenSSL verifiziert
r = await lookup(code);
assert.equal(r.data.status, "issued");
const chain = await (await req("/api/student/csrs/certificate", { token: r.data.pickupToken, body: { format: "chain" }, raw: true }) as Response).text();
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

// 10b. Zwischen-CA verwalten: Klassen-URL, Quick-Zertifikat, Inhaber-Freigabe
r = await lookup(code);
assert.deepEqual(r.data.management, { enabled: false, token: null, keyStored: false });
const pk = r.data.pickupToken as string;
assert.equal((await req("/api/student/csrs/manage", { token: "1.2.x", body: { enable: true } })).status, 401);
assert.equal((await req("/api/student/csrs/manage", { body: { enable: true } })).status, 401);
assert.equal((await req("/api/student/csrs/manage", { token: student, body: { enable: true } })).status, 401, "Schüler-Session reicht nicht für Verwaltung");
r = await req("/api/student/csrs/manage", { token: pk, body: { enable: true } });
assert.equal(r.status, 201);
const caToken = r.data.token as string;
assert.match(caToken, /^[A-Za-z0-9_-]{22}$/);
assert.equal((await req("/api/student/csrs/manage", { token: pk, body: { enable: true } })).data.token, caToken, "idempotent");
step("Verwaltung aktiviert, Klassen-URL /ca/" + caToken.slice(0, 6) + "…");

// öffentliche Ressource ohne Login
assert.equal((await req("/api/ca/gibtesnicht0123456789")).status, 404);
r = await req(`/api/ca/${caToken}`);
assert.equal(r.status, 200);
assert.equal(r.data.name, "FI-25a");
assert.deepEqual(r.data.permittedDns, ["schule.example", ".klasse.example"]);
assert.deepEqual(r.data.certificates, []);
const caPem = await (await req(`/api/ca/${caToken}/ca-certificate`, { raw: true }) as Response).text();
assert.equal(caPem.trim(), certs[0].trim());

// Quick-Zertifikat
const quickBody = { requester: "Anna", cn: "web.schule.example", ou: "FI-25a", san: "web.schule.example, 192.0.2.7", email: "anna@schule.example" };
assert.equal((await req(`/api/ca/${caToken}/quick`, { body: quickBody })).status, 400, "ohne Captcha abgelehnt");
r = await req(`/api/ca/${caToken}/quick`, { body: { ...quickBody, san: "", ...(await captcha("QQQQ2")) } });
assert.equal(r.status, 400, "SAN Pflicht");
for (const email of ["", "keine-mail"]) {
	r = await req(`/api/ca/${caToken}/quick`, { body: { ...quickBody, email, ...(await captcha("Q" + Math.random().toString(36).slice(2, 6).toUpperCase())) } });
	assert.equal(r.status, 400, `Quick: E-Mail="${email}" muss abgelehnt werden`);
	assert.match(r.data.error, /E-Mail/);
}
r = await req(`/api/ca/${caToken}/requests`, { body: { csrPem: csr.toString("pem"), ...(await captcha("QQQQ7")) } });
assert.equal(r.status, 400, "CSR-Upload ohne E-Mail abgelehnt");
// Ein mitgeschicktes OU wird ignoriert (OU kommt fest aus dem Zwischenzertifikat)
assert.equal((await req(`/api/ca/${caToken}`)).data.fixedOu, "Klassen");
r = await req(`/api/ca/${caToken}/quick`, { body: { ...quickBody, ...(await captcha("QQQQ3")) } });
assert.equal(r.status, 201, JSON.stringify(r.data));
assert.match(r.data.privateKeyPem, /BEGIN PRIVATE KEY/);
const quickId = r.data.id as number;
const quickKey = r.data.privateKeyPem as string;

// eigener CSR (außerhalb der Constraints, wird erst beim Ausstellen abgelehnt)
const k3 = (await crypto.subtle.generateKey(alg, true, ["sign", "verify"])) as CryptoKeyPair;
const csr3 = await x509.Pkcs10CertificateRequestGenerator.create({
	name: "CN=evil.example", keys: k3, signingAlgorithm: alg,
	extensions: [new x509.SubjectAlternativeNameExtension([{ type: "dns", value: "evil.example" }])],
});
r = await req(`/api/ca/${caToken}/requests`, { body: { requester: "Bob", ou: "FI-25a", email: "bob@schule.example", csrPem: csr3.toString("pem"), ...(await captcha("QQQQ4")) } });
assert.equal(r.status, 201);
const evilId = r.data.id as number;
r = await req(`/api/ca/${caToken}/requests`, { body: { csrPem: "kein csr", ou: "FI-25a", email: "anna@schule.example", ...(await captcha("QQQQ5")) } });
assert.equal(r.status, 422);

// öffentliche Tabelle: sichtbar, aber ohne Schlüssel/Kontaktdaten
r = await req(`/api/ca/${caToken}`);
assert.equal(r.data.certificates.length, 2);
assert.ok(!JSON.stringify(r.data).includes("PRIVATE") && !JSON.stringify(r.data).includes("anna@schule"));
assert.equal(r.data.certificates.find((c: any) => c.id === quickId).san, "web.schule.example, 192.0.2.7");

// Inhaber: nur mit Abruf-Code
assert.equal((await req(`/api/ca/${caToken}/owner`)).status, 401);
// Anmeldung: Abruf-Code + Captcha -> Inhaber-Token
assert.equal((await req(`/api/ca/${caToken}/owner/login`, { body: { code } })).status, 400, "Inhaber-Login ohne Captcha");
assert.equal((await req(`/api/ca/${caToken}/owner/login`, { body: { code: "AAAA-BBBB-CCCC-DDDD", ...(await captcha("OWNER")) } })).status, 401, "falscher Code");
r = await req(`/api/ca/${caToken}/owner/login`, { body: { code, ...(await captcha("OWNER")) } });
assert.equal(r.status, 200);
const ownerToken = r.data.ownerToken as string;
const ownerReq = async (path: string, method: string, body?: unknown, tokenOverride = ownerToken) =>
	(await fetch(`${BASE}/api/ca/${caToken}/owner${path}`, { method, headers: { Authorization: `Bearer ${tokenOverride}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }).then(async (res) => ({ status: res.status, data: (await res.json().catch(() => null)) as any })));
assert.equal((await ownerReq("", "GET", undefined, "garbage")).status, 401);
assert.equal((await ownerReq("", "GET", undefined, student)).status, 401, "Schüler-Token ist kein Inhaber-Token");
assert.equal((await ownerReq("", "GET", undefined, ownerToken.slice(0, -2) + "xx")).status, 401, "manipuliertes Inhaber-Token");
assert.equal((await ownerReq("", "GET", undefined, pk)).status, 200, "Abruf-Sitzung aus dem Schülerportal öffnet den Inhaber-Bereich");
r = await ownerReq("", "GET");
assert.equal(r.status, 200);
assert.equal(r.data.keyStored, false);
assert.equal(r.data.requests.find((x: any) => x.id === quickId).email, "anna@schule.example");

// Ausstellen ohne hinterlegten Key: Key muss mitkommen
const caKeyPem = x509.PemConverter.encode((await crypto.subtle.exportKey("pkcs8", keys.privateKey)) as ArrayBuffer, "PRIVATE KEY");
const approve = { cn: "web.schule.example", ou: "FI-25a", email: "anna@schule.example", san: "web.schule.example, 192.0.2.7", validityDays: 90 };
assert.deepEqual(r.data.defaults, { C: "DE", ST: "", L: "", O: "Schule Muster", OU: "Klassen" }, "C/ST/L/O/OU aus dem Zwischenzertifikat");
assert.equal(r.data.requests.find((x: any) => x.id === quickId).ou, "Klassen", "OU der Anfrage = fester Text aus dem Zwischenzertifikat (mitgeschickte OU ignoriert)");
assert.ok(r.data.maxValidityDays >= 179 && r.data.maxValidityDays <= 180, "Maximum = Restlaufzeit der Zwischen-CA (180 Tage)");
assert.equal((await ownerReq(`/requests/${quickId}/approve`, "POST", { ...approve, email: "", keyPem: caKeyPem })).status, 400, "E-Mail Pflicht bei Freigabe");
assert.equal((await ownerReq(`/requests/${quickId}/approve`, "POST", { ...approve, validityDays: 400, keyPem: caKeyPem })).status, 400, "Laufzeit über Restlaufzeit der Zwischen-CA");
assert.equal((await ownerReq(`/requests/${quickId}/approve`, "POST", approve)).status, 400, "ohne Key");
assert.equal((await ownerReq(`/requests/${quickId}/approve`, "POST", { ...approve, keyPem: x509.PemConverter.encode((await crypto.subtle.exportKey("pkcs8", k3.privateKey)) as ArrayBuffer, "PRIVATE KEY") })).status, 422, "falscher Key");
assert.equal((await ownerReq(`/requests/${quickId}/approve`, "POST", { ...approve, keyPem: caKeyPem, san: "evil.example" })).status, 422, "SAN außerhalb Constraints");
r = await ownerReq(`/requests/${quickId}/approve`, "POST", { ...approve, keyPem: caKeyPem });
assert.equal(r.status, 200, JSON.stringify(r.data));
assert.equal((await ownerReq("", "GET")).data.keyStored, false, "Upload-Key wird nicht gespeichert");

// Key dauerhaft hinterlegen; danach Freigabe ohne Key (SAN korrigiert)
assert.equal((await ownerReq("/key", "PUT", { keyPem: "kaputt" })).status, 422);
assert.equal((await ownerReq("/key", "PUT", { keyPem: caKeyPem })).status, 200);
assert.equal((await req(`/api/ca/${caToken}`)).data.keyStored, true);
r = await ownerReq(`/requests/${evilId}/approve`, "POST", { cn: "evil.example", san: "evil.example", validityDays: 30, ou: "FI-25a", email: "anna@schule.example" });
assert.equal(r.status, 422, "Constraint-Verstoß auch mit hinterlegtem Key");
r = await ownerReq(`/requests/${evilId}/approve`, "POST", { cn: "ok.klasse.example", san: "ok.klasse.example", validityDays: 30, email: "bob@schule.example", subject: { O: "Andere Organisation", L: "Köln" } });
assert.equal(r.status, 200, JSON.stringify(r.data));
assert.equal((await ownerReq(`/requests/${evilId}/approve`, "POST", { cn: "ok.klasse.example", san: "ok.klasse.example", ou: "FI-25a", email: "anna@schule.example" })).status, 409, "bereits ausgestellt");

// Ablehnen
r = await req(`/api/ca/${caToken}/quick`, { body: { cn: "reject.schule.example", san: "reject.schule.example", ou: "FI-25a", email: "r@schule.example", ...(await captcha("QQQQ6")) } });
const rejId = r.data.id as number;
assert.equal((await ownerReq(`/requests/${rejId}/reject`, "POST", { reason: "Nicht benötigt" })).status, 200);

// Öffentliche Tabelle + Downloads, OpenSSL-Verifikation der Endzertifikate
r = await req(`/api/ca/${caToken}`);
const byId = (id: number) => r.data.certificates.find((c: any) => c.id === id);
assert.equal(byId(quickId).status, "issued");
assert.equal(byId(evilId).status, "issued");
assert.deepEqual([byId(rejId).status, byId(rejId).rejectReason], ["rejected", "Nicht benötigt"]);
assert.equal((await req(`/api/ca/${caToken}/certificates/${rejId}`, { raw: true }) as Response).status, 404, "abgelehnte nicht ladbar");
const evilPem = await (await req(`/api/ca/${caToken}/certificates/${evilId}`, { raw: true }) as Response).text();
writeFileSync(join(dir, "evil.pem"), evilPem);
try {
	const sub = execFileSync("openssl", ["x509", "-in", join(dir, "evil.pem"), "-noout", "-subject", "-nameopt", "multiline,utf8"]).toString();
	assert.match(sub, /organizationName\s*=\s*Andere Organisation/, "Inhaber hat O überschrieben");
	assert.match(sub, /localityName\s*=\s*(Köln|K\\C3\\B6ln)/, "Inhaber hat L ergänzt (UTF-8)");
	assert.match(sub, /countryName\s*=\s*DE/, "C bleibt aus dem Zwischenzertifikat");
	assert.match(sub, /organizationalUnitName\s*=\s*Klassen/, "OU ohne Angabe = fester Text aus dem Zwischenzertifikat");
} catch (e: any) {
	if (e.code !== "ENOENT") throw e;
}
const leafFull = await (await req(`/api/ca/${caToken}/certificates/${quickId}?format=fullchain`, { raw: true }) as Response).text();
const leafPem = await (await req(`/api/ca/${caToken}/certificates/${quickId}`, { raw: true }) as Response).text();
assert.equal(leafFull.match(/BEGIN CERTIFICATE/g)!.length, 3);
writeFileSync(join(dir, "leaf.pem"), leafPem);
writeFileSync(join(dir, "int2.pem"), caPem);
try {
	const out = execFileSync("openssl", ["verify", "-CAfile", join(dir, "root.pem"), "-untrusted", join(dir, "int2.pem"), join(dir, "leaf.pem")]).toString();
	assert.match(out, /OK/);
	const txt = execFileSync("openssl", ["x509", "-in", join(dir, "leaf.pem"), "-noout", "-subject", "-ext", "subjectAltName,basicConstraints"]).toString();
	console.log(txt.trim().split("\n").map((l) => "    " + l).join("\n"));
	assert.match(txt, /C\s*=\s*DE/, "C aus Zwischenzertifikat");
	assert.match(txt, /O\s*=\s*Schule Muster/, "O aus Zwischenzertifikat");
	assert.match(txt, /OU\s*=\s*FI-25a/);
	assert.match(txt, /emailAddress\s*=\s*anna@schule\.example/);
	// Der Private Key aus der Quick-Anfrage passt zum Zertifikat
	writeFileSync(join(dir, "quick.key"), quickKey);
	const pubFromKey = execFileSync("openssl", ["pkey", "-in", join(dir, "quick.key"), "-pubout"]).toString();
	const pubFromCert = execFileSync("openssl", ["x509", "-in", join(dir, "leaf.pem"), "-noout", "-pubkey"]).toString();
	assert.equal(pubFromKey, pubFromCert, "Quick-Private-Key gehört zum ausgestellten Zertifikat");
} catch (e: any) {
	if (e.code !== "ENOENT") throw e;
}
step("Klassen-URL: Quick-Zertifikat, eigener CSR, Freigabe mit/ohne hinterlegten Key, Ablehnung, Downloads");

// Key wieder löschen; Admin sieht Verwaltung und kann sie deaktivieren
assert.equal((await ownerReq("/key", "DELETE")).status, 200);
assert.equal((await req(`/api/ca/${caToken}`)).data.keyStored, false);
r = await req(`/api/admin/csrs/${csrId}`, { token: admin });
assert.equal(r.data.csr.management.token, caToken);
assert.equal(r.data.csr.management.requests, 3);
r = await req(`/api/admin/csrs/${csrId}/leaves`, { token: admin });
assert.equal(r.data.leaves.length, 3);
assert.deepEqual(r.data.leaves.map((l: any) => l.status).sort(), ["issued", "issued", "rejected"]);
assert.ok(r.data.leaves.every((l: any) => l.ou && l.email), "OU und E-Mail zu jedem verwalteten Zertifikat");
assert.equal((await req(`/api/admin/csrs/${csrId}/leaves`)).status, 401);

// Admin: Kontakt bearbeiten
const goodContact = { contactPerson: "Erika Neu", contactMethod: "teams", contactDetail: "erika.neu" };
assert.equal((await req(`/api/admin/csrs/${csrId}/contact`, { method: "PATCH", body: goodContact })).status, 401);
assert.equal((await req(`/api/admin/csrs/${csrId}/contact`, { method: "PATCH", token: admin, body: { ...goodContact, contactMethod: "email", contactDetail: "keine-mail" } })).status, 400);
assert.equal((await req(`/api/admin/csrs/${csrId}/contact`, { method: "PATCH", token: admin, body: { ...goodContact, contactPerson: "" } })).status, 400);
assert.equal((await req(`/api/admin/csrs/99999/contact`, { method: "PATCH", token: admin, body: goodContact })).status, 404);
assert.equal((await req(`/api/admin/csrs/${csrId}/contact`, { method: "PATCH", token: admin, body: goodContact })).status, 200);
r = await req(`/api/admin/csrs/${csrId}`, { token: admin });
assert.deepEqual([r.data.csr.contactPerson, r.data.csr.contactMethod, r.data.csr.contactDetail], ["Erika Neu", "teams", "erika.neu"]);

// Admin: Abruf-Code zurücksetzen – alter Code und laufende Abruf-Sitzungen werden ungültig
assert.equal((await req(`/api/admin/csrs/${csrId}/reset-code`, { method: "POST" })).status, 401);
assert.equal((await req(`/api/admin/csrs/99999/reset-code`, { method: "POST", token: admin })).status, 404);
assert.equal((await ownerReq("", "GET")).status, 200, "Inhaber-Sitzung vor dem Zurücksetzen gültig");
r = await req(`/api/admin/csrs/${csrId}/reset-code`, { method: "POST", token: admin });
assert.equal(r.status, 200);
const newCode = r.data.code as string;
assert.match(newCode, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
assert.notEqual(newCode, code);
assert.equal((await lookup(code)).status, 404, "alter Abruf-Code ungültig");
assert.equal((await ownerReq("", "GET")).status, 401, "alte Inhaber-Sitzung ungültig");
assert.equal((await req("/api/student/csrs/certificate", { token: pk, body: { format: "pem" } })).status, 401, "alte Abruf-Sitzung ungültig");
assert.equal((await req(`/api/ca/${caToken}/owner/login`, { body: { code, ...(await captcha("OWNER")) } })).status, 401, "alter Code für Inhaber-Login ungültig");
r = await lookup(newCode);
assert.equal(r.status, 200, "neuer Code funktioniert");
assert.equal(r.data.management.token, caToken, "Klassen-URL bleibt unverändert");
assert.equal((await req(`/api/ca/${caToken}/owner/login`, { body: { code: newCode, ...(await captcha("OWNER")) } })).status, 200);
code = newCode;
assert.equal((await req(`/api/admin/csrs/${csrId}/management`, { method: "DELETE", token: admin })).status, 200);
assert.equal((await req(`/api/ca/${caToken}`)).status, 404, "Klassen-URL nach Deaktivierung weg");
assert.equal((await lookup(code)).data.management.enabled, false);
step("Key löschen, Admin: Kontakt bearbeiten, Code zurücksetzen, Verwaltung deaktivieren");

// Zwischenzertifikat löschen: mit Klassen-Seite, Anfragen und gespeichertem Schlüssel
r = await lookup(code);
r = await req("/api/student/csrs/manage", { token: r.data.pickupToken, body: { enable: true } });
const caToken2 = r.data.token as string;
assert.notEqual(caToken2, caToken, "neue Klassen-URL nach erneutem Aktivieren");
r = await req(`/api/ca/${caToken2}/quick`, { body: { cn: "weg.schule.example", san: "weg.schule.example", email: "x@schule.example", ...(await captcha("QQQQ9")) } });
assert.equal(r.status, 201);
assert.equal((await req(`/api/ca/${caToken2}`)).data.certificates.length, 1);
assert.equal((await req(`/api/admin/csrs/${csrId}`, { method: "DELETE" })).status, 401);
r = await req(`/api/admin/csrs/${csrId}`, { method: "DELETE", token: admin });
assert.equal(r.status, 200);
assert.deepEqual([r.data.deletedLeafRequests, r.data.hadManagement], [1, true]);
assert.equal((await req(`/api/ca/${caToken2}`)).status, 404, "Klassen-Seite weg");
assert.equal((await lookup(code)).status, 404, "Abruf-Code weg");
assert.equal((await req(`/api/admin/csrs/${csrId}`, { token: admin })).status, 404, "CSR weg");
assert.equal((await req(`/api/admin/csrs/${csrId}/leaves`, { token: admin })).data.leaves.length, 0, "Klassen-Anfragen weg");
assert.equal((await req(`/api/admin/csrs/${csrId}`, { method: "DELETE", token: admin })).status, 200, "Löschen ist idempotent");
step("Zwischenzertifikat samt Klassen-Daten gelöscht");

// 11. Ablehnen-Flow, Löschschutz
const keys2 = (await crypto.subtle.generateKey(alg, true, ["sign", "verify"])) as CryptoKeyPair;
const csr2 = await x509.Pkcs10CertificateRequestGenerator.create({ name: "CN=FI-25b", keys: keys2, signingAlgorithm: alg });
r = await req("/api/student/csrs", { token: student, body: { rootId, label: "FI-25b", csrPem: csr2.toString("pem"), contactPerson: "Erika Beispiel", contactMethod: "phone", contactDetail: "+49 123 456789" } });
const code2 = r.data.code;
const id2 = (await req("/api/admin/csrs?status=pending", { token: admin })).data.csrs[0].id;
assert.equal((await req(`/api/admin/csrs/${id2}/reject`, { token: admin, body: { reason: "Bitte Klassenbezeichnung im CN" } })).status, 200);
r = await lookup(code2);
assert.deepEqual([r.data.status, r.data.rejectReason], ["rejected", "Bitte Klassenbezeichnung im CN"]);
assert.equal((await req(`/api/admin/roots/${rootId}`, { method: "DELETE", token: admin })).status, 409);
assert.equal((await req(`/api/admin/roots/${rootId}`, { method: "PATCH", token: admin, body: { isActive: false } })).status, 200);
assert.equal((await req("/api/student/roots")).data.roots.length, 0);
step("Ablehnen, Löschschutz, Deaktivieren");

// 12. Rate-Limit Login
let limited = false;
for (let i = 0; i < 12 && !limited; i++) limited = (await req("/api/student/login", { body: { password: "x", ...(await captcha("AAAAA")) } })).status === 429;
assert.ok(limited, "Rate-Limit greift");
step("Rate-Limit Login");
console.log("\nAlle E2E-Prüfungen bestanden");
