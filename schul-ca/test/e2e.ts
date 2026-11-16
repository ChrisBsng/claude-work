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
assert.deepEqual([r.data.csr.contactPerson, r.data.csr.contactMethod, r.data.csr.contactDetail], ["Max Mustermann", "email", "max@schule.example"]);
assert.ok(!JSON.stringify((await req("/api/student/csrs/lookup", { token: student, body: { code } })).data).includes("max@schule"), "Kontaktdaten nicht für Schüler abrufbar");
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

// 10b. Zwischen-CA verwalten: Klassen-URL, Quick-Zertifikat, Inhaber-Freigabe
r = await req("/api/student/csrs/lookup", { token: student, body: { code } });
assert.deepEqual(r.data.management, { enabled: false, token: null, keyStored: false });
assert.equal((await req("/api/student/csrs/manage", { token: student, body: { code: "AAAA-BBBB-CCCC-DDDD", enable: true } })).status, 404);
assert.equal((await req("/api/student/csrs/manage", { body: { code, enable: true } })).status, 401);
r = await req("/api/student/csrs/manage", { token: student, body: { code, enable: true } });
assert.equal(r.status, 201);
const caToken = r.data.token as string;
assert.match(caToken, /^[A-Za-z0-9_-]{22}$/);
assert.equal((await req("/api/student/csrs/manage", { token: student, body: { code, enable: true } })).data.token, caToken, "idempotent");
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
r = await req(`/api/ca/${caToken}/requests`, { body: { requester: "Bob", csrPem: csr3.toString("pem"), ...(await captcha("QQQQ4")) } });
assert.equal(r.status, 201);
const evilId = r.data.id as number;
r = await req(`/api/ca/${caToken}/requests`, { body: { csrPem: "kein csr", ...(await captcha("QQQQ5")) } });
assert.equal(r.status, 422);

// öffentliche Tabelle: sichtbar, aber ohne Schlüssel/Kontaktdaten
r = await req(`/api/ca/${caToken}`);
assert.equal(r.data.certificates.length, 2);
assert.ok(!JSON.stringify(r.data).includes("PRIVATE") && !JSON.stringify(r.data).includes("anna@schule"));
assert.equal(r.data.certificates.find((c: any) => c.id === quickId).san, "web.schule.example, 192.0.2.7");

// Inhaber: nur mit Abruf-Code
assert.equal((await req(`/api/ca/${caToken}/owner`)).status, 401);
const ownerReq = async (path: string, method: string, body?: unknown, ownerCode = code) =>
	(await fetch(`${BASE}/api/ca/${caToken}/owner${path}`, { method, headers: { "X-Owner-Code": ownerCode, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }).then(async (res) => ({ status: res.status, data: (await res.json().catch(() => null)) as any })));
assert.equal((await ownerReq("", "GET", undefined, "AAAA-BBBB-CCCC-DDDD")).status, 401);
r = await ownerReq("", "GET");
assert.equal(r.status, 200);
assert.equal(r.data.keyStored, false);
assert.equal(r.data.requests.find((x: any) => x.id === quickId).email, "anna@schule.example");

// Ausstellen ohne hinterlegten Key: Key muss mitkommen
const caKeyPem = x509.PemConverter.encode((await crypto.subtle.exportKey("pkcs8", keys.privateKey)) as ArrayBuffer, "PRIVATE KEY");
const approve = { cn: "web.schule.example", ou: "FI-25a", email: "anna@schule.example", san: "web.schule.example, 192.0.2.7", validityDays: 90 };
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
r = await ownerReq(`/requests/${evilId}/approve`, "POST", { cn: "evil.example", san: "evil.example", validityDays: 30 });
assert.equal(r.status, 422, "Constraint-Verstoß auch mit hinterlegtem Key");
r = await ownerReq(`/requests/${evilId}/approve`, "POST", { cn: "ok.klasse.example", san: "ok.klasse.example", validityDays: 30 });
assert.equal(r.status, 200, JSON.stringify(r.data));
assert.equal((await ownerReq(`/requests/${evilId}/approve`, "POST", { cn: "ok.klasse.example", san: "ok.klasse.example" })).status, 409, "bereits ausgestellt");

// Ablehnen
r = await req(`/api/ca/${caToken}/quick`, { body: { cn: "reject.schule.example", san: "reject.schule.example", ...(await captcha("QQQQ6")) } });
const rejId = r.data.id as number;
assert.equal((await ownerReq(`/requests/${rejId}/reject`, "POST", { reason: "Nicht benötigt" })).status, 200);

// Öffentliche Tabelle + Downloads, OpenSSL-Verifikation der Endzertifikate
r = await req(`/api/ca/${caToken}`);
const byId = (id: number) => r.data.certificates.find((c: any) => c.id === id);
assert.equal(byId(quickId).status, "issued");
assert.equal(byId(evilId).status, "issued");
assert.deepEqual([byId(rejId).status, byId(rejId).rejectReason], ["rejected", "Nicht benötigt"]);
assert.equal((await req(`/api/ca/${caToken}/certificates/${rejId}`, { raw: true }) as Response).status, 404, "abgelehnte nicht ladbar");
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
assert.equal((await req(`/api/admin/csrs/${csrId}/management`, { method: "DELETE", token: admin })).status, 200);
assert.equal((await req(`/api/ca/${caToken}`)).status, 404, "Klassen-URL nach Deaktivierung weg");
assert.equal((await req("/api/student/csrs/lookup", { token: student, body: { code } })).data.management.enabled, false);
step("Key löschen, Admin deaktiviert Verwaltung");

// 11. Ablehnen-Flow, Löschschutz
const keys2 = (await crypto.subtle.generateKey(alg, true, ["sign", "verify"])) as CryptoKeyPair;
const csr2 = await x509.Pkcs10CertificateRequestGenerator.create({ name: "CN=FI-25b", keys: keys2, signingAlgorithm: alg });
r = await req("/api/student/csrs", { token: student, body: { rootId, label: "FI-25b", csrPem: csr2.toString("pem"), contactPerson: "Erika Beispiel", contactMethod: "phone", contactDetail: "+49 123 456789" } });
const code2 = r.data.code;
const id2 = (await req("/api/admin/csrs?status=pending", { token: admin })).data.csrs[0].id;
assert.equal((await req(`/api/admin/csrs/${id2}/reject`, { token: admin, body: { reason: "Bitte Klassenbezeichnung im CN" } })).status, 200);
r = await req("/api/student/csrs/lookup", { token: student, body: { code: code2 } });
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
