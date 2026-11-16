// Passwort-Hashing und Token-Signierung – bewusst dieselbe Technik wie im
// Pausen-Tool (pausen-checkin/src/crypto.ts): PBKDF2-SHA256, 100.000
// Iterationen (Workers-Maximum), selbstbeschreibendes Format
// "pbkdf2:<iterationen>:<salt>:<hash>", Vergleich in konstanter Zeit,
// HMAC-signierte Session-Tokens.

export function base64UrlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(value: string): Uint8Array {
	const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
	const binary = atob(padded);
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function randomToken(byteLength: number): string {
	const bytes = new Uint8Array(byteLength);
	crypto.getRandomValues(bytes);
	return base64UrlEncode(bytes);
}

export function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let mismatch = 0;
	for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return mismatch === 0;
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
	const data = typeof value === "string" ? new TextEncoder().encode(value) : value;
	const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Vergleich über Hash-Digests statt Rohwerten (Länge verrät nichts per Timing).
export async function verifyPlainPassword(expected: string, provided: string): Promise<boolean> {
	const [a, b] = await Promise.all([sha256Hex(expected), sha256Hex(provided)]);
	return constantTimeEqual(a, b);
}

const PBKDF2_ITERATIONS = 100_000;

async function derivePasswordBits(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
	const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
	return crypto.subtle.deriveBits({ name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" }, keyMaterial, 256);
}

export async function hashPassword(password: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const bits = await derivePasswordBits(password, salt, PBKDF2_ITERATIONS);
	return `pbkdf2:${PBKDF2_ITERATIONS}:${base64UrlEncode(salt)}:${base64UrlEncode(new Uint8Array(bits))}`;
}

export async function verifyPasswordHash(stored: string, provided: string): Promise<boolean> {
	const [scheme, iterationsRaw, saltB64, hashB64] = stored.split(":");
	if (scheme !== "pbkdf2" || !iterationsRaw || !saltB64 || !hashB64) return false;
	const iterations = Number(iterationsRaw);
	if (!Number.isFinite(iterations) || iterations <= 0) return false;
	const bits = await derivePasswordBits(provided, base64UrlDecode(saltB64), iterations);
	return constantTimeEqual(base64UrlEncode(new Uint8Array(bits)), hashB64);
}

// ---- Schlüsselableitung aus MASTER_SECRET --------------------------------

async function hkdf(master: string, info: string, usages: ("sign" | "encrypt" | "decrypt")[], algorithm: any, extractable = false) {
	const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(master), "HKDF", false, ["deriveKey"]);
	return crypto.subtle.deriveKey(
		{ name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("schul-ca/v1"), info: new TextEncoder().encode(info) },
		base,
		algorithm,
		extractable,
		usages,
	);
}

const hmacKeyCache = new Map<string, Promise<CryptoKey>>();
function hmacKey(master: string, purpose: string): Promise<CryptoKey> {
	const cacheKey = `${purpose}:${master.length}:${master.slice(0, 4)}`;
	let key = hmacKeyCache.get(cacheKey);
	if (!key) {
		key = hkdf(master, `hmac:${purpose}`, ["sign"], { name: "HMAC", hash: "SHA-256" });
		hmacKeyCache.set(cacheKey, key);
	}
	return key;
}

export async function hmacSign(master: string, purpose: string, payload: string): Promise<string> {
	const key = await hmacKey(master, purpose);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
	return base64UrlEncode(new Uint8Array(sig));
}

// ---- Session-Tokens --------------------------------------------------------

export type Role = "admin" | "student";
const SESSION_TTL_SECONDS: Record<Role, number> = { admin: 60 * 60 * 8, student: 60 * 60 * 12 };

// Token: <exp>.<role>.<fingerprint>.<sig>. Der Fingerprint ist an den
// aktuell gespeicherten Passwort-Hash gebunden: Wird ein Passwort geändert,
// werden alle bisherigen Sessions dieser Rolle ungültig.
export async function createSessionToken(master: string, role: Role, fingerprint: string): Promise<string> {
	const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS[role];
	const payload = `${exp}.${role}.${fingerprint}`;
	return `${payload}.${await hmacSign(master, "session", payload)}`;
}

export async function verifySessionToken(master: string, token: string | null, role: Role, fingerprint: string): Promise<boolean> {
	if (!token) return false;
	const parts = token.split(".");
	if (parts.length !== 4) return false;
	const [expRaw, tokenRole, tokenFp, sig] = parts;
	if (tokenRole !== role || !constantTimeEqual(tokenFp, fingerprint)) return false;
	const exp = Number(expRaw);
	if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
	return constantTimeEqual(await hmacSign(master, "session", `${expRaw}.${tokenRole}.${tokenFp}`), sig);
}

export async function fingerprintOf(value: string): Promise<string> {
	return (await sha256Hex(`fp:${value}`)).slice(0, 16);
}

// ---- Verschlüsselung der Root-Keys ----------------------------------------

async function aesKey(master: string): Promise<CryptoKey> {
	return hkdf(master, "aes:root-key-store", ["encrypt", "decrypt"], { name: "AES-GCM", length: 256 });
}

const AAD = new TextEncoder().encode("schul-ca:root-key");

// Format: v1:<iv>:<ciphertext> (Base64URL)
export async function encryptSecret(master: string, plaintext: Uint8Array): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: AAD }, await aesKey(master), plaintext as BufferSource);
	return `v1:${base64UrlEncode(iv)}:${base64UrlEncode(new Uint8Array(ct))}`;
}

export async function decryptSecret(master: string, stored: string): Promise<Uint8Array> {
	const [version, ivB64, ctB64] = stored.split(":");
	if (version !== "v1" || !ivB64 || !ctB64) throw new Error("Unbekanntes Key-Format");
	const pt = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: base64UrlDecode(ivB64) as BufferSource, additionalData: AAD },
		await aesKey(master),
		base64UrlDecode(ctB64) as BufferSource,
	);
	return new Uint8Array(pt);
}
