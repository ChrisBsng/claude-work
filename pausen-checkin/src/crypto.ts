function base64UrlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
	const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
	const binary = atob(padded);
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function randomToken(byteLength: number): string {
	const bytes = new Uint8Array(byteLength);
	crypto.getRandomValues(bytes);
	return base64UrlEncode(bytes);
}

function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let mismatch = 0;
	for (let i = 0; i < a.length; i++) {
		mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return mismatch === 0;
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Vergleicht Passwörter über Hash-Digests statt der Rohwerte, damit die
// unterschiedliche Länge von falschem Input nicht per Timing verrät, wie
// weit der Vergleich schon abgebrochen ist.
export async function verifyPassword(expected: string, provided: string): Promise<boolean> {
	const [expectedHash, providedHash] = await Promise.all([sha256Hex(expected), sha256Hex(provided)]);
	return constantTimeEqual(expectedHash, providedHash);
}

async function hmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
		"verify",
	]);
}

const ADMIN_SESSION_TTL_SECONDS = 60 * 60 * 12;

export async function createAdminSessionToken(secret: string): Promise<string> {
	const expiresAt = Math.floor(Date.now() / 1000) + ADMIN_SESSION_TTL_SECONDS;
	const key = await hmacKey(secret);
	const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(expiresAt)));
	return `${expiresAt}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export async function verifyAdminSessionToken(secret: string, token: string | null): Promise<boolean> {
	if (!token) return false;
	const [expiresAtRaw, signature] = token.split(".");
	if (!expiresAtRaw || !signature) return false;

	const expiresAt = Number(expiresAtRaw);
	if (!Number.isFinite(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) return false;

	const key = await hmacKey(secret);
	const expectedSignature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(expiresAtRaw));
	return constantTimeEqual(base64UrlEncode(new Uint8Array(expectedSignature)), signature);
}

const PARTICIPANT_PASSWORD_PBKDF2_ITERATIONS = 100_000;

async function deriveParticipantPasswordBits(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
	const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
	return crypto.subtle.deriveBits({ name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" }, keyMaterial, 256);
}

// Format: pbkdf2:<iterations>:<saltBase64Url>:<hashBase64Url> – self-
// beschreibend, damit die Iterationszahl später erhöht werden kann, ohne
// bestehende Hashes ungültig zu machen.
export async function hashParticipantPassword(password: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const hashBits = await deriveParticipantPasswordBits(password, salt, PARTICIPANT_PASSWORD_PBKDF2_ITERATIONS);
	return `pbkdf2:${PARTICIPANT_PASSWORD_PBKDF2_ITERATIONS}:${base64UrlEncode(salt)}:${base64UrlEncode(new Uint8Array(hashBits))}`;
}

export async function verifyParticipantPassword(stored: string, provided: string): Promise<boolean> {
	const [scheme, iterationsRaw, saltB64, hashB64] = stored.split(":");
	if (scheme !== "pbkdf2" || !iterationsRaw || !saltB64 || !hashB64) return false;

	const iterations = Number(iterationsRaw);
	if (!Number.isFinite(iterations) || iterations <= 0) return false;

	const salt = base64UrlDecode(saltB64);
	const hashBits = await deriveParticipantPasswordBits(provided, salt, iterations);
	return constantTimeEqual(base64UrlEncode(new Uint8Array(hashBits)), hashB64);
}
