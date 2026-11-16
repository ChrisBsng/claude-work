import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as x509 from "@peculiar/x509";
import { analyzeCsr, generateRoot, issueIntermediate, validateRootImport, parseDnsList } from "../src/pki";
import { decryptSecret, encryptSecret, hashPassword, verifyPasswordHash } from "../src/crypto";

async function makeCsr(kind: "ec" | "rsa2048" | "rsa1024") {
	const alg: any =
		kind === "ec"
			? { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" }
			: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", modulusLength: kind === "rsa2048" ? 2048 : 1024, publicExponent: new Uint8Array([1, 0, 1]) };
	const keys = (await crypto.subtle.generateKey(alg, true, ["sign", "verify"])) as CryptoKeyPair;
	const csr = await x509.Pkcs10CertificateRequestGenerator.create({ name: "CN=Klasse FI-25, O=Testschule, C=DE", keys, signingAlgorithm: alg });
	return csr.toString("pem");
}

const hasOpenssl = (() => {
	try { execFileSync("openssl", ["version"]); return true; } catch { return false; }
})();

for (const keyType of ["ec-p384", "rsa-3072"] as const) {
	test(`Root ${keyType}: erzeugen, CSR signieren, mit OpenSSL verifizieren`, async () => {
		const root = await generateRoot({ commonName: "Test Root CA", org: "Testschule", country: "DE", years: 10, keyType });
		const reimport = await validateRootImport(root.info.certPem, x509.PemConverter.encode(root.pkcs8 as any, "PRIVATE KEY"));
		assert.equal(reimport.info.fingerprint, root.info.fingerprint);

		const csrPem = await makeCsr("ec");
		const info = await analyzeCsr(csrPem);
		assert.equal(info.cn, "Klasse FI-25");

		const issued = await issueIntermediate({
			rootCertPem: root.info.certPem,
			rootPkcs8: root.pkcs8,
			csrPem,
			subject: { C: "DE", O: "Testschule", OU: "Klassen", CN: "Klasse FI-25" },
			validityDays: 365,
			pathLen: 0,
			permittedDns: parseDnsList("schule.example, .intern"),
			crlUrl: "http://ca.example/crl.pem",
			aiaUrl: "http://ca.example/root.crt",
		});
		const dir = mkdtempSync(join(tmpdir(), "ca-"));
		writeFileSync(join(dir, "root.pem"), root.info.certPem);
		writeFileSync(join(dir, "int.pem"), issued.certPem);
		if (hasOpenssl) {
			const out = execFileSync("openssl", ["verify", "-CAfile", join(dir, "root.pem"), join(dir, "int.pem")]).toString();
			assert.match(out, /OK/);
			const text = execFileSync("openssl", ["x509", "-in", join(dir, "int.pem"), "-noout", "-text"]).toString();
			assert.match(text, /CA:TRUE, pathlen:0/);
			assert.match(text, /Certificate Sign, CRL Sign/);
			assert.match(text, /Permitted:/);
			assert.match(text, /DNS:schule\.example/);
			assert.match(text, /CA Issuers/);
			console.log(text.split("\n").filter((l) => /Subject:|Issuer:|Not After|Signature Algorithm/.test(l)).join("\n"));
		}
	});
}

test("zu kurzer RSA-Key im CSR wird abgelehnt", async () => {
	await assert.rejects(analyzeCsr(await makeCsr("rsa1024")), /zu kurz/);
});

test("manipulierter CSR wird abgelehnt", async () => {
	const pem = await makeCsr("ec");
	const lines = pem.split("\n");
	const i = lines.length - 4;
	lines[i] = lines[i].replace(/[A-Za-z]/, (c) => (c === "A" ? "B" : "A"));
	await assert.rejects(analyzeCsr(lines.join("\n")));
});

test("Key passt nicht zum Zertifikat", async () => {
	const a = await generateRoot({ commonName: "A", years: 1, keyType: "ec-p256" });
	const b = await generateRoot({ commonName: "B", years: 1, keyType: "ec-p256" });
	await assert.rejects(validateRootImport(a.info.certPem, x509.PemConverter.encode(b.pkcs8 as any, "PRIVATE KEY")), /gehört nicht/);
});

test("Key-Verschlüsselung & Passwort-Hash", async () => {
	const data = crypto.getRandomValues(new Uint8Array(64));
	const enc = await encryptSecret("master-secret", data);
	assert.deepEqual(await decryptSecret("master-secret", enc), data);
	await assert.rejects(decryptSecret("other-secret", enc));
	const h = await hashPassword("geheim123");
	assert.ok(await verifyPasswordHash(h, "geheim123"));
	assert.ok(!(await verifyPasswordHash(h, "falsch")));
});

// ---- Endzertifikate ----------------------------------------------------------

import { assertWithinNameConstraints, generateQuickRequest, issueLeaf, parseSanList, permittedDnsOfCert, validateCaKey } from "../src/pki";

async function makeIntermediate(permittedDns: string, keyType: "ec-p384" | "rsa-3072" = "ec-p384") {
	const root = await generateRoot({ commonName: "Root", org: "Schule", country: "DE", years: 10, keyType });
	const caKeyAlg = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
	const caKeys = (await crypto.subtle.generateKey(caKeyAlg, true, ["sign", "verify"])) as CryptoKeyPair;
	const caCsr = await x509.Pkcs10CertificateRequestGenerator.create({ name: "CN=Klasse FI-25a", keys: caKeys, signingAlgorithm: caKeyAlg });
	const issued = await issueIntermediate({
		rootCertPem: root.info.certPem,
		rootPkcs8: root.pkcs8,
		csrPem: caCsr.toString("pem"),
		subject: { C: "DE", O: "Schule", CN: "Klasse FI-25a" },
		validityDays: 365,
		pathLen: 0,
		permittedDns: parseDnsList(permittedDns),
	});
	const caKeyPem = x509.PemConverter.encode((await crypto.subtle.exportKey("pkcs8", caKeys.privateKey)) as ArrayBuffer, "PRIVATE KEY");
	return { root, caCertPem: issued.certPem, caKeyPem };
}

test("SAN-Parsing", () => {
	assert.deepEqual(parseSanList("Web.Schule.example, 10.0.0.5 a@b.example ::1 *.x.example"), [
		{ type: "dns", value: "web.schule.example" },
		{ type: "ip", value: "10.0.0.5" },
		{ type: "email", value: "a@b.example" },
		{ type: "ip", value: "::1" },
		{ type: "dns", value: "*.x.example" },
	]);
	assert.throws(() => parseSanList("foo bar!"), /Ungültiger SAN/);
	assert.throws(() => parseSanList("999.1.1.1"), /Ungültiger SAN/);
	assert.throws(() => parseSanList(Array.from({ length: 21 }, (_, i) => `h${i}.example`).join(",")), /Höchstens/);
});

test("Name-Constraints-Prüfung", () => {
	const p = ["schule.example", ".klasse.example"];
	assertWithinNameConstraints(p, parseSanList("schule.example, www.schule.example, a.klasse.example, *.schule.example"), "x");
	assert.throws(() => assertWithinNameConstraints(p, parseSanList("evil.example"), "x"), /außerhalb/);
	assert.throws(() => assertWithinNameConstraints(p, parseSanList("notschule.example"), "x"), /außerhalb/);
	assert.throws(() => assertWithinNameConstraints(p, parseSanList("klasse.example"), "x"), /außerhalb/, ".klasse.example erlaubt nur Subdomains");
	assertWithinNameConstraints([], parseSanList("irgendwas.example"), "x");
});

for (const keyType of ["ec-p384", "rsa-3072"] as const) {
	test(`Endzertifikat per Quick-Request, ${keyType}: Kette mit OpenSSL verifizieren`, async () => {
		const { root, caCertPem, caKeyPem } = await makeIntermediate("schule.example", keyType);
		assert.deepEqual(permittedDnsOfCert(caCertPem), ["schule.example"]);
		const caPkcs8 = await validateCaKey(caCertPem, caKeyPem);

		const quick = await generateQuickRequest({ cn: "web.schule.example", ou: "FI-25a", email: "max@schule.example", sans: parseSanList("web.schule.example, 192.0.2.7") });
		assert.match(quick.privateKeyPem, /BEGIN PRIVATE KEY/);
		const info = await analyzeCsr(quick.csrPem);
		assert.equal(info.cn, "web.schule.example");
		assert.deepEqual(info.sans.map((s) => s.value), ["web.schule.example", "192.0.2.7"]);

		const leaf = await issueLeaf({
			caCertPem,
			caPkcs8,
			csrPem: quick.csrPem,
			subject: { ...info.fields, CN: "web.schule.example", OU: "FI-25a", E: "max@schule.example" },
			sans: info.sans,
			validityDays: 90,
		});
		if (!hasOpenssl) return;
		const dir = mkdtempSync(join(tmpdir(), "leaf-"));
		writeFileSync(join(dir, "root.pem"), root.info.certPem);
		writeFileSync(join(dir, "int.pem"), caCertPem);
		writeFileSync(join(dir, "leaf.pem"), leaf.certPem);
		const out = execFileSync("openssl", ["verify", "-CAfile", join(dir, "root.pem"), "-untrusted", join(dir, "int.pem"), join(dir, "leaf.pem")]).toString();
		assert.match(out, /OK/);
		const text = execFileSync("openssl", ["x509", "-in", join(dir, "leaf.pem"), "-noout", "-text"]).toString();
		assert.match(text, /CA:FALSE/);
		assert.match(text, /DNS:web\.schule\.example, IP Address:192\.0\.2\.7/);
		assert.match(text, /TLS Web Server Authentication, TLS Web Client Authentication/);
		assert.match(text, /emailAddress\s*=\s*max@schule\.example/);
		assert.match(text, /OU\s*=\s*FI-25a/);
	});
}

test("Endzertifikat: SAN außerhalb der Constraints und falscher CA-Key werden abgelehnt", async () => {
	const a = await makeIntermediate("schule.example");
	const b = await makeIntermediate("schule.example");
	await assert.rejects(validateCaKey(a.caCertPem, b.caKeyPem), /gehört nicht/);
	const pkcs8 = await validateCaKey(a.caCertPem, a.caKeyPem);
	const q = await generateQuickRequest({ cn: "x.evil.example", sans: parseSanList("x.evil.example") });
	await assert.rejects(issueLeaf({ caCertPem: a.caCertPem, caPkcs8: pkcs8, csrPem: q.csrPem, subject: { CN: "x.evil.example" }, sans: parseSanList("x.evil.example"), validityDays: 30 }), /außerhalb/);
	const ok = await generateQuickRequest({ cn: "x.schule.example", sans: parseSanList("x.schule.example") });
	await assert.rejects(issueLeaf({ caCertPem: a.caCertPem, caPkcs8: pkcs8, csrPem: ok.csrPem, subject: { CN: "x.schule.example" }, sans: [], validityDays: 9999 }), /Gültigkeit/);
	const long = await issueLeaf({ caCertPem: a.caCertPem, caPkcs8: pkcs8, csrPem: ok.csrPem, subject: { CN: "x.schule.example" }, sans: parseSanList("x.schule.example"), validityDays: 800 });
	assert.equal(long.truncated, true, "Laufzeit wird auf die der CA gekürzt");
});
