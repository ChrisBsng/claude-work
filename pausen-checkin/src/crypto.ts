function base64UrlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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
