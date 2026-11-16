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
