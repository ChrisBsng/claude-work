import { sha256Hex } from "./crypto";

// Abruf-Code: 16 Zeichen aus eindeutigem Alphabet (80 Bit), z. B. K7QM-4TXD-9WPB-2HNC
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateCode(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	const chars = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]);
	return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join("")).join("-");
}

export function normalizeCode(input: unknown): string | null {
	if (typeof input !== "string") return null;
	const c = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
	return c.length === 16 ? c : null;
}

export const hashCode = (normalized: string) => sha256Hex(`csr-code:${normalized}`);
