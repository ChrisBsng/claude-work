// PKI-Logik auf Basis von WebCrypto + @peculiar/x509 (reines JS, läuft im
// Worker – OpenSSL steht in Cloudflare Workers nicht zur Verfügung).
import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { AsnConvert } from "@peculiar/asn1-schema";
import { GeneralName, GeneralSubtree, GeneralSubtrees, NameConstraints, id_ce_nameConstraints } from "@peculiar/asn1-x509";
import { sha256Hex } from "./crypto";

export class PkiError extends Error {}

export interface SubjectFields {
	C?: string;
	ST?: string;
	L?: string;
	O?: string;
	OU?: string;
	CN: string;
}

export interface CsrInfo {
	sans: SanEntry[];
	subject: string;
	cn: string | null;
	fields: Partial<SubjectFields>;
	keyInfo: string;
}

export type KeyType = "ec-p256" | "ec-p384" | "rsa-3072" | "rsa-4096";

const MIN_RSA_BITS = 2048;
const EC_HASH: Record<string, string> = { "P-256": "SHA-256", "P-384": "SHA-384", "P-521": "SHA-512" };

function pem(der: ArrayBuffer | Uint8Array, label: string): string {
	return x509.PemConverter.encode(der as ArrayBuffer, label);
}

function describeKey(alg: any): string {
	if (alg.name === "RSASSA-PKCS1-v1_5") return `RSA ${alg.modulusLength} Bit`;
	if (alg.name === "ECDSA") return `EC ${alg.namedCurve}`;
	return String(alg.name);
}

function signingAlgorithmFor(alg: any): { name: string; hash: string } {
	if (alg.name === "RSASSA-PKCS1-v1_5") return { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
	if (alg.name === "ECDSA" && EC_HASH[alg.namedCurve]) return { name: "ECDSA", hash: EC_HASH[alg.namedCurve] };
	throw new PkiError("Nicht unterstützter Schlüsseltyp (erlaubt: RSA ≥ 2048 Bit, EC P-256/P-384/P-521).");
}

function assertSupportedKey(alg: any): void {
	if (alg.name === "RSASSA-PKCS1-v1_5") {
		if (alg.modulusLength < MIN_RSA_BITS) throw new PkiError(`RSA-Schlüssel zu kurz (mindestens ${MIN_RSA_BITS} Bit).`);
		return;
	}
	signingAlgorithmFor(alg);
}

export function normalizeCertPem(input: string): string {
	const trimmed = input.trim();
	if (!trimmed) throw new PkiError("Kein Zertifikat angegeben.");
	return trimmed;
}

// ---- CSR -------------------------------------------------------------------

export async function analyzeCsr(csrPem: string): Promise<CsrInfo> {
	let csr: x509.Pkcs10CertificateRequest;
	try {
		csr = new x509.Pkcs10CertificateRequest(csrPem.trim());
	} catch {
		throw new PkiError("Der CSR konnte nicht gelesen werden (erwartet: PEM mit -----BEGIN CERTIFICATE REQUEST-----).");
	}
	let valid = false;
	try {
		valid = await csr.verify();
	} catch {
		valid = false;
	}
	if (!valid) throw new PkiError("Die Signatur des CSR ist ungültig (Proof of Possession fehlgeschlagen).");

	const alg = csr.publicKey.algorithm as any;
	assertSupportedKey(alg);

	const first = (name: string) => csr.subjectName.getField(name)[0] as string | undefined;
	const fields: Partial<SubjectFields> = {};
	for (const f of ["C", "ST", "L", "O", "OU", "CN"] as const) {
		const v = first(f);
		if (v) fields[f] = v;
	}
	if (!fields.CN) throw new PkiError("Der CSR enthält keinen Common Name (CN). Bitte die Klasse im CN angeben, z. B. -subj \"/CN=FI-25a\".");
	return { subject: csr.subject, cn: fields.CN ?? null, fields, keyInfo: describeKey(alg), sans: sansFromCsr(csr) };
}

// ---- Root-CA ---------------------------------------------------------------

export interface RootInfo {
	subject: string;
	certPem: string;
	fingerprint: string;
	keyAlgorithm: string;
	notBefore: string;
	notAfter: string;
}

export async function describeCert(cert: x509.X509Certificate): Promise<RootInfo> {
	const raw = new Uint8Array(cert.rawData);
	const hex = (await sha256Hex(raw)).toUpperCase().match(/../g)!.join(":");
	return {
		subject: cert.subject,
		certPem: pem(raw, "CERTIFICATE"),
		fingerprint: hex,
		keyAlgorithm: describeKey(cert.publicKey.algorithm),
		notBefore: cert.notBefore.toISOString(),
		notAfter: cert.notAfter.toISOString(),
	};
}

function pkcs8FromPem(keyPem: string): Uint8Array {
	const text = keyPem.trim();
	if (/BEGIN ENCRYPTED PRIVATE KEY/.test(text)) {
		throw new PkiError("Der Private Key ist passwortgeschützt. Bitte vorher entschlüsseln: openssl pkcs8 -in key.pem -out key-plain.pem -nocrypt");
	}
	if (/BEGIN (RSA|EC) PRIVATE KEY/.test(text)) {
		throw new PkiError("Bitte den Key ins PKCS#8-Format umwandeln: openssl pkcs8 -topk8 -nocrypt -in key.pem -out key-pkcs8.pem");
	}
	if (!/BEGIN PRIVATE KEY/.test(text)) throw new PkiError("Kein gültiger Private Key (erwartet: -----BEGIN PRIVATE KEY-----).");
	try {
		return new Uint8Array(x509.PemConverter.decode(text)[0]);
	} catch {
		throw new PkiError("Der Private Key konnte nicht gelesen werden.");
	}
}

export async function importSigningKey(pkcs8: Uint8Array, certPublicAlg: any, extractable = false): Promise<CryptoKey> {
	const sig = signingAlgorithmFor(certPublicAlg);
	const importAlg = sig.name === "ECDSA" ? { name: "ECDSA", namedCurve: certPublicAlg.namedCurve } : { name: sig.name, hash: sig.hash };
	try {
		return await crypto.subtle.importKey("pkcs8", pkcs8 as BufferSource, importAlg, extractable, ["sign"]);
	} catch {
		throw new PkiError("Der Private Key passt nicht zum Typ des Zertifikats oder ist ungültig.");
	}
}

// Prüft, dass der (unverschlüsselte, PKCS#8-)Private Key zum Zertifikat gehört
// (Testsignatur), und liefert die PKCS#8-Bytes.
async function checkKeyMatchesCert(cert: x509.X509Certificate, keyPem: string): Promise<Uint8Array> {
	const alg = cert.publicKey.algorithm as any;
	const pkcs8 = pkcs8FromPem(keyPem);
	const signingKey = await importSigningKey(pkcs8, alg);
	const probe = crypto.getRandomValues(new Uint8Array(32));
	const sigAlg = signingAlgorithmFor(alg);
	const signature = await crypto.subtle.sign(sigAlg, signingKey, probe);
	const pub = await cert.publicKey.export(
		sigAlg.name === "ECDSA" ? { name: "ECDSA", namedCurve: alg.namedCurve } : { name: sigAlg.name, hash: sigAlg.hash },
		["verify"],
	);
	if (!(await crypto.subtle.verify(sigAlg, pub, signature, probe))) {
		throw new PkiError("Der Private Key gehört nicht zu diesem Zertifikat.");
	}
	return pkcs8;
}

// Für Inhaber einer Zwischen-CA: Key prüfen, der zum ausgestellten Zertifikat passen muss.
export async function validateCaKey(certPem: string, keyPem: string): Promise<Uint8Array> {
	let cert: x509.X509Certificate;
	try {
		cert = new x509.X509Certificate(normalizeCertPem(certPem));
	} catch {
		throw new PkiError("Das Zwischenzertifikat konnte nicht gelesen werden.");
	}
	return checkKeyMatchesCert(cert, keyPem);
}

// Prüft Zertifikat + Key (CA-Flag, Key gehört zum Zertifikat) und liefert
// Metadaten sowie die PKCS#8-Bytes zur verschlüsselten Ablage.
export async function validateRootImport(certPem: string, keyPem: string): Promise<{ info: RootInfo; pkcs8: Uint8Array }> {
	let cert: x509.X509Certificate;
	try {
		cert = new x509.X509Certificate(normalizeCertPem(certPem));
	} catch {
		throw new PkiError("Das Zertifikat konnte nicht gelesen werden (erwartet: PEM).");
	}
	const bc = cert.getExtension(x509.BasicConstraintsExtension);
	if (!bc?.ca) throw new PkiError("Das Zertifikat ist kein CA-Zertifikat (BasicConstraints CA:TRUE fehlt).");
	const alg = cert.publicKey.algorithm as any;
	assertSupportedKey(alg);
	if (cert.notAfter.getTime() < Date.now()) throw new PkiError("Das Zertifikat ist bereits abgelaufen.");

	const pkcs8 = await checkKeyMatchesCert(cert, keyPem);
	return { info: await describeCert(cert), pkcs8 };
}

export interface GenerateRootParams {
	commonName: string;
	org?: string;
	country?: string;
	years: number;
	keyType: KeyType;
}

export async function generateRoot(p: GenerateRootParams): Promise<{ info: RootInfo; pkcs8: Uint8Array }> {
	let genAlg: any;
	let signAlg: any;
	switch (p.keyType) {
		case "ec-p256":
			genAlg = { name: "ECDSA", namedCurve: "P-256" };
			signAlg = { name: "ECDSA", hash: "SHA-256" };
			break;
		case "ec-p384":
			genAlg = { name: "ECDSA", namedCurve: "P-384" };
			signAlg = { name: "ECDSA", hash: "SHA-384" };
			break;
		case "rsa-3072":
		case "rsa-4096":
			genAlg = {
				name: "RSASSA-PKCS1-v1_5",
				hash: "SHA-256",
				modulusLength: p.keyType === "rsa-3072" ? 3072 : 4096,
				publicExponent: new Uint8Array([1, 0, 1]),
			};
			signAlg = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
			break;
		default:
			throw new PkiError("Unbekannter Schlüsseltyp.");
	}
	const keys = (await crypto.subtle.generateKey(genAlg, true, ["sign", "verify"])) as CryptoKeyPair;
	const notBefore = new Date(Date.now() - 5 * 60_000);
	const notAfter = new Date(Date.now() + p.years * 365 * 86_400_000);
	const name: x509.JsonName = [];
	if (p.country) name.push({ C: [p.country] });
	if (p.org) name.push({ O: [p.org] });
	name.push({ CN: [p.commonName] });

	const cert = await x509.X509CertificateGenerator.createSelfSigned({
		serialNumber: randomSerial(),
		name,
		notBefore,
		notAfter,
		keys,
		signingAlgorithm: signAlg,
		extensions: [
			new x509.BasicConstraintsExtension(true, undefined, true),
			new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
			await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
		],
	});
	const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", keys.privateKey)) as ArrayBuffer);
	return { info: await describeCert(cert), pkcs8 };
}

// ---- Ausstellen ------------------------------------------------------------

export interface IssueParams {
	rootCertPem: string;
	rootPkcs8: Uint8Array;
	csrPem: string;
	subject: SubjectFields;
	validityDays: number;
	pathLen: number | null;
	permittedDns: string[];
	crlUrl?: string | null;
	aiaUrl?: string | null;
}

export interface IssuedCert {
	certPem: string;
	serialNumber: string;
	notBefore: string;
	notAfter: string;
	truncated: boolean;
}

export function randomSerial(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	bytes[0] = (bytes[0] & 0x7f) | 0x40; // positiv, führendes Byte ≠ 0
	return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const DNS_CONSTRAINT = /^\.?[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;

export function parseDnsList(input: string | null | undefined): string[] {
	const list = (input ?? "")
		.split(/[\s,;]+/)
		.map((s) => s.trim())
		.filter(Boolean);
	for (const d of list) if (!DNS_CONSTRAINT.test(d)) throw new PkiError(`Ungültiger DNS-Name in den Name Constraints: ${d}`);
	return list;
}

function buildName(s: SubjectFields): x509.JsonName {
	const name: x509.JsonName = [];
	for (const f of ["C", "ST", "L", "O", "OU", "CN"] as const) {
		const v = s[f]?.trim();
		if (v) name.push({ [f]: [v] });
	}
	return name;
}

export async function issueIntermediate(p: IssueParams): Promise<IssuedCert> {
	const rootCert = new x509.X509Certificate(p.rootCertPem);
	const rootAlg = rootCert.publicKey.algorithm as any;
	const signAlg = signingAlgorithmFor(rootAlg);
	const signingKey = await importSigningKey(p.rootPkcs8, rootAlg);

	if (!p.subject.CN?.trim()) throw new PkiError("Common Name (CN) fehlt.");
	if (!Number.isInteger(p.validityDays) || p.validityDays < 1) throw new PkiError("Ungültige Gültigkeitsdauer.");

	const csr = new x509.Pkcs10CertificateRequest(p.csrPem);
	if (!(await csr.verify())) throw new PkiError("Die Signatur des CSR ist ungültig.");

	const now = Date.now();
	const notBefore = new Date(now - 5 * 60_000);
	if (rootCert.notAfter.getTime() <= now) throw new PkiError("Das Stammzertifikat ist abgelaufen.");
	let notAfter = new Date(now + p.validityDays * 86_400_000);
	let truncated = false;
	if (notAfter > rootCert.notAfter) {
		notAfter = rootCert.notAfter;
		truncated = true;
	}

	const extensions: x509.Extension[] = [
		new x509.BasicConstraintsExtension(true, p.pathLen ?? undefined, true),
		new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
		await x509.SubjectKeyIdentifierExtension.create(csr.publicKey),
		await x509.AuthorityKeyIdentifierExtension.create(rootCert.publicKey),
	];
	if (p.permittedDns.length) {
		const nc = new NameConstraints({
			permittedSubtrees: new GeneralSubtrees(p.permittedDns.map((d) => new GeneralSubtree({ base: new GeneralName({ dNSName: d }) }))),
		});
		extensions.push(new x509.Extension(id_ce_nameConstraints, true, AsnConvert.serialize(nc)));
	}
	if (p.crlUrl) extensions.push(new x509.CRLDistributionPointsExtension([p.crlUrl]));
	if (p.aiaUrl) extensions.push(new x509.AuthorityInfoAccessExtension({ caIssuers: [p.aiaUrl] }));

	const serialNumber = randomSerial();
	const cert = await x509.X509CertificateGenerator.create({
		serialNumber,
		subject: buildName(p.subject),
		issuer: rootCert.subjectName,
		notBefore,
		notAfter,
		publicKey: csr.publicKey,
		signingKey,
		signingAlgorithm: signAlg,
		extensions,
	});
	return {
		certPem: pem(cert.rawData, "CERTIFICATE"),
		serialNumber,
		notBefore: notBefore.toISOString(),
		notAfter: notAfter.toISOString(),
		truncated,
	};
}

export function certPemToDer(certPem: string): Uint8Array {
	return new Uint8Array(x509.PemConverter.decode(certPem)[0]);
}


// ---- Endzertifikate (Zwischen-CA stellt für Mitschüler aus) ------------------------

export interface SanEntry {
	type: "dns" | "ip" | "email";
	value: string;
}

const DNS_NAME = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^[0-9a-f:.]+$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MAX_SANS = 20;

// Komma-/Leerzeichen-getrennte Eingabe -> typisierte SAN-Einträge.
export function parseSanList(input: string | null | undefined): SanEntry[] {
	const items = (input ?? "")
		.split(/[\s,;]+/)
		.map((x) => x.trim())
		.filter(Boolean);
	if (items.length > MAX_SANS) throw new PkiError(`Höchstens ${MAX_SANS} SAN-Einträge erlaubt.`);
	const seen = new Set<string>();
	const out: SanEntry[] = [];
	for (const raw of items) {
		let entry: SanEntry;
		if (raw.includes("@")) {
			if (!EMAIL.test(raw)) throw new PkiError(`Ungültige E-Mail im SAN: ${raw}`);
			entry = { type: "email", value: raw };
		} else if (IPV4.test(raw) || (raw.includes(":") && IPV6.test(raw))) {
			entry = { type: "ip", value: raw };
		} else if (!/^[\d.]+$/.test(raw) && DNS_NAME.test(raw) && raw.length <= 253) {
			entry = { type: "dns", value: raw.toLowerCase() };
		} else {
			throw new PkiError(`Ungültiger SAN-Eintrag (DNS-Name, IP oder E-Mail erwartet): ${raw}`);
		}
		const key = `${entry.type}:${entry.value}`;
		if (!seen.has(key)) {
			seen.add(key);
			out.push(entry);
		}
	}
	return out;
}

export const sanToString = (sans: SanEntry[]) => sans.map((x) => x.value).join(", ");

function sansFromCsr(csr: x509.Pkcs10CertificateRequest): SanEntry[] {
	const ext = csr.extensions.find((e): e is x509.SubjectAlternativeNameExtension => e instanceof x509.SubjectAlternativeNameExtension);
	const out: SanEntry[] = [];
	for (const n of ext?.names.items ?? []) {
		if (n.type === "dns" || n.type === "ip" || n.type === "email") out.push({ type: n.type, value: n.value });
	}
	return out.slice(0, MAX_SANS);
}

// Erlaubte DNS-Bereiche (Name Constraints) einer Zwischen-CA.
export function permittedDnsOfCert(certPem: string): string[] {
	const cert = new x509.X509Certificate(certPem);
	const ext = cert.extensions.find((e) => e.type === id_ce_nameConstraints);
	if (!ext) return [];
	const nc = AsnConvert.parse(ext.value, NameConstraints);
	return [...(nc.permittedSubtrees ?? [])].map((st) => st.base.dNSName).filter((d): d is string => Boolean(d));
}

function dnsPermitted(name: string, permitted: string[]): boolean {
	const n = name.toLowerCase().replace(/^\*\./, "");
	return permitted.some((p) => {
		const d = p.toLowerCase();
		return d.startsWith(".") ? n.endsWith(d) : n === d || n.endsWith("." + d);
	});
}

// Würde ein SAN außerhalb der Name Constraints der CA liegen, lehnen Clients das
// Zertifikat ab – deshalb schon beim Ausstellen verhindern.
export function assertWithinNameConstraints(permitted: string[], sans: SanEntry[], cn: string): void {
	if (!permitted.length) return;
	for (const s of sans) {
		if (s.type === "dns" && !dnsPermitted(s.value, permitted)) {
			throw new PkiError(`„${s.value}" liegt außerhalb der erlaubten Domains dieser Zwischen-CA (${permitted.join(", ")}).`);
		}
	}
	if (!sans.length && DNS_NAME.test(cn) && !dnsPermitted(cn, permitted)) {
		throw new PkiError(`„${cn}" liegt außerhalb der erlaubten Domains dieser Zwischen-CA (${permitted.join(", ")}).`);
	}
}

export interface LeafSubject {
	C?: string;
	ST?: string;
	L?: string;
	O?: string;
	OU?: string;
	CN: string;
	E?: string;
}

export interface IssueLeafParams {
	caCertPem: string;
	caPkcs8: Uint8Array;
	csrPem: string;
	subject: LeafSubject;
	sans: SanEntry[];
	validityDays: number;
}

export const MAX_LEAF_VALIDITY_DAYS = 825;

export async function issueLeaf(p: IssueLeafParams): Promise<IssuedCert> {
	const caCert = new x509.X509Certificate(p.caCertPem);
	const caAlg = caCert.publicKey.algorithm as any;
	const signAlg = signingAlgorithmFor(caAlg);
	const signingKey = await importSigningKey(p.caPkcs8, caAlg);

	const cn = p.subject.CN?.trim();
	if (!cn || cn.length > 64) throw new PkiError("Common Name (CN) erforderlich (höchstens 64 Zeichen).");
	if (!Number.isInteger(p.validityDays) || p.validityDays < 1 || p.validityDays > MAX_LEAF_VALIDITY_DAYS) {
		throw new PkiError(`Gültigkeit: 1–${MAX_LEAF_VALIDITY_DAYS} Tage.`);
	}
	const csr = new x509.Pkcs10CertificateRequest(p.csrPem);
	if (!(await csr.verify())) throw new PkiError("Die Signatur des CSR ist ungültig.");
	assertSupportedKey(csr.publicKey.algorithm as any);
	assertWithinNameConstraints(permittedDnsOfCert(p.caCertPem), p.sans, cn);

	const now = Date.now();
	if (caCert.notAfter.getTime() <= now) throw new PkiError("Das Zwischenzertifikat ist abgelaufen.");
	const notBefore = new Date(now - 5 * 60_000);
	let notAfter = new Date(now + p.validityDays * 86_400_000);
	let truncated = false;
	if (notAfter > caCert.notAfter) {
		notAfter = caCert.notAfter;
		truncated = true;
	}

	const isRsa = (csr.publicKey.algorithm as any).name === "RSASSA-PKCS1-v1_5";
	const extensions: x509.Extension[] = [
		new x509.BasicConstraintsExtension(false, undefined, true),
		new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature | (isRsa ? x509.KeyUsageFlags.keyEncipherment : 0), true),
		new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth, x509.ExtendedKeyUsage.clientAuth], false),
		await x509.SubjectKeyIdentifierExtension.create(csr.publicKey),
		await x509.AuthorityKeyIdentifierExtension.create(caCert.publicKey),
	];
	if (p.sans.length) extensions.push(new x509.SubjectAlternativeNameExtension(p.sans.map((s) => ({ type: s.type, value: s.value }))));

	const name: x509.JsonName = [];
	for (const f of ["C", "ST", "L", "O", "OU", "CN", "E"] as const) {
		const v = (f === "CN" ? cn : p.subject[f])?.trim();
		if (v) name.push({ [f]: [v] });
	}
	const serialNumber = randomSerial();
	const cert = await x509.X509CertificateGenerator.create({
		serialNumber,
		subject: name,
		issuer: caCert.subjectName,
		notBefore,
		notAfter,
		publicKey: csr.publicKey,
		signingKey,
		signingAlgorithm: signAlg,
		extensions,
	});
	return { certPem: pem(cert.rawData, "CERTIFICATE"), serialNumber, notBefore: notBefore.toISOString(), notAfter: notAfter.toISOString(), truncated };
}

// Quick-Zertifikat: Schlüssel (EC P-256) und CSR erzeugen. Der Private Key wird
// nur zurückgegeben und nirgends gespeichert.
export async function generateQuickRequest(p: { cn: string; ou?: string; email?: string; sans: SanEntry[] }): Promise<{ csrPem: string; privateKeyPem: string; keyInfo: string }> {
	const alg = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
	const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
	const name: x509.JsonName = [];
	if (p.ou) name.push({ OU: [p.ou] });
	name.push({ CN: [p.cn] });
	if (p.email) name.push({ E: [p.email] });
	const csr = await x509.Pkcs10CertificateRequestGenerator.create({
		name,
		keys,
		signingAlgorithm: alg,
		extensions: p.sans.length ? [new x509.SubjectAlternativeNameExtension(p.sans.map((s) => ({ type: s.type, value: s.value })))] : [],
	});
	const pkcs8 = (await crypto.subtle.exportKey("pkcs8", keys.privateKey)) as ArrayBuffer;
	return { csrPem: csr.toString("pem"), privateKeyPem: pem(pkcs8, "PRIVATE KEY"), keyInfo: "EC P-256" };
}

// Standort-/Organisationsfelder (C, ST, L, O) einer Zertifikats-Subject – Vorbelegung für
// die Endzertifikate einer Zwischen-CA.
export function locationFieldsOfCert(certPem: string): { C: string; ST: string; L: string; O: string } {
	const cert = new x509.X509Certificate(certPem);
	const f = (n: string) => (cert.subjectName.getField(n)[0] as string | undefined) ?? "";
	return { C: f("C"), ST: f("ST"), L: f("L"), O: f("O") };
}

export function remainingDays(certPem: string): number {
	const cert = new x509.X509Certificate(certPem);
	return Math.max(0, Math.floor((cert.notAfter.getTime() - Date.now()) / 86_400_000));
}
