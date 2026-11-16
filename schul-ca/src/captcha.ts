import { constantTimeEqual, hmacSign, randomToken } from "./crypto";
import type { Env } from "./env";

// Einfaches, selbst gehostetes Bild-Captcha (SVG, 5 Zeichen ohne verwechselbare
// Buchstaben). Zustandslos: Das Token enthält nur Ablaufzeit, Nonce und einen
// HMAC über die Lösung – die Lösung selbst steht nirgends im Klartext.
// Jede Nonce ist einmalig einlösbar (Tabelle used_captchas).

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const TTL_SECONDS = 300;

function randomInt(max: number): number {
	const buf = new Uint32Array(1);
	crypto.getRandomValues(buf);
	return buf[0] % max;
}

// 5x7-Punktmatrix-Font. Die Zeichen werden als Pfade (nicht als <text>)
// ausgegeben, damit die Lösung nicht per einfachem SVG-Parsing auslesbar ist.
const FONT: Record<string, string> = {
	A: ".###.#...##...#######...##...##...#",
	B: "####.#...##...#####.#...##...#####.",
	C: ".#####....#....#....#....#.....####",
	D: "####.#...##...##...##...##...#####.",
	E: "######....#....####.#....#....#####",
	F: "######....#....####.#....#....#....",
	G: ".#####....#....#..###...##...#.####",
	H: "#...##...##...#######...##...##...#",
	J: "..###...#....#....#....#.#..#..##..",
	K: "#...##..#.#.#..##...#.#..#..#.#...#",
	L: "#....#....#....#....#....#....#####",
	M: "#...###.###.#.##.#.##...##...##...#",
	N: "#...###..##.#.##..###...##...##...#",
	P: "####.#...##...#####.#....#....#....",
	Q: ".###.#...##...##...##.#.##..#..##.#",
	R: "####.#...##...#####.#.#..#..#.#...#",
	S: ".#####....#.....###.....#....#####.",
	T: "#####..#....#....#....#....#....#..",
	U: "#...##...##...##...##...##...#.###.",
	V: "#...##...##...##...##...#.#.#...#..",
	W: "#...##...##...##.#.##.#.###.###...#",
	X: "#...##...#.#.#...#...#.#.#...##...#",
	Y: "#...##...#.#.#...#....#....#....#..",
	Z: "#####....#...#...#...#...#....#####",
	"2": ".###.#...#....#...#...#...#...#####",
	"3": "####.....#....#.###.....#....#####.",
	"4": "...#...##..#.#.#..#.#####...#....#.",
	"5": "######....####.....#....##...#.###.",
	"6": ".###.#....#....####.#...##...#.###.",
	"7": "#####....#...#...#...#....#....#...",
	"8": ".###.#...##...#.###.#...##...#.###.",
	"9": ".###.#...##...#.####....#....#.###.",
};

function glyphPath(ch: string, ox: number, oy: number, cell: number): string {
	const bits = FONT[ch] ?? "";
	let d = "";
	for (let i = 0; i < 35; i++) {
		if (bits[i] !== "#") continue;
		const x = ox + (i % 5) * cell;
		const y = oy + Math.floor(i / 5) * cell;
		d += `M${x} ${y}h${cell}v${cell}h-${cell}z`;
	}
	return d;
}

function renderSvg(text: string): string {
	const width = 180;
	const height = 60;
	const cell = 4;
	let body = `<rect width="${width}" height="${height}" fill="#f1f3f6"/>`;
	for (let i = 0; i < 5; i++) {
		body += `<line x1="${randomInt(width)}" y1="${randomInt(height)}" x2="${randomInt(width)}" y2="${randomInt(height)}" stroke="#a5adba" stroke-width="${1 + randomInt(2)}"/>`;
	}
	[...text].forEach((ch, i) => {
		const x = 12 + i * 31 + randomInt(5);
		const y = 14 + randomInt(10);
		const rot = randomInt(31) - 15;
		body += `<path d="${glyphPath(ch, x, y, cell)}" fill="#1f2937" transform="rotate(${rot} ${x + 10} ${y + 14})"/>`;
	});
	for (let i = 0; i < 4; i++) {
		body += `<line x1="0" y1="${5 + randomInt(height - 10)}" x2="${width}" y2="${5 + randomInt(height - 10)}" stroke="#4b5563" stroke-width="1.2" opacity="0.7"/>`;
	}
	for (let i = 0; i < 30; i++) {
		body += `<circle cx="${randomInt(width)}" cy="${randomInt(height)}" r="1" fill="#6b7280"/>`;
	}
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Captcha">${body}</svg>`;
}

export async function createCaptcha(env: Env): Promise<{ token: string; svg: string }> {
	let text = "";
	for (let i = 0; i < 5; i++) text += ALPHABET[randomInt(ALPHABET.length)];
	const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
	const nonce = randomToken(12);
	const sig = await hmacSign(env.MASTER_SECRET, "captcha", `${exp}.${nonce}.${text}`);
	return { token: `${exp}.${nonce}.${sig}`, svg: renderSvg(text) };
}

export async function verifyCaptcha(env: Env, token: unknown, answer: unknown): Promise<boolean> {
	if (typeof token !== "string" || typeof answer !== "string") return false;
	const parts = token.split(".");
	if (parts.length !== 3) return false;
	const [expRaw, nonce, sig] = parts;
	const now = Math.floor(Date.now() / 1000);
	if (!(Number(expRaw) >= now)) return false;

	const normalized = answer.trim().toUpperCase().replace(/\s+/g, "");
	const expected = await hmacSign(env.MASTER_SECRET, "captcha", `${expRaw}.${nonce}.${normalized}`);
	if (!constantTimeEqual(expected, sig)) return false;

	// Einmalig einlösbar; abgelaufene Nonces nebenbei aufräumen.
	await env.DB.prepare("DELETE FROM used_captchas WHERE expires_at < ?1").bind(now).run();
	const insert = await env.DB.prepare("INSERT OR IGNORE INTO used_captchas (nonce, expires_at) VALUES (?1, ?2)")
		.bind(nonce, Number(expRaw))
		.run();
	return (insert.meta.changes ?? 0) > 0;
}
