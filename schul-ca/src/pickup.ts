import type { IRequest } from "itty-router";
import { constantTimeEqual, hmacSign } from "./crypto";
import type { Env } from "./env";

// Abruf-Sitzung: Wer den Abruf-Code (+ Captcha) eingegeben hat, bekommt für kurze Zeit
// ein signiertes Token, das an genau diesen CSR gebunden ist. Es berechtigt zum
// Zertifikats-Download, zum Aktivieren/Deaktivieren der Verwaltung und zum
// Inhaber-Bereich der Klassen-Seite – ohne bei jedem Schritt ein neues Captcha zu verlangen.
// Unabhängig vom Schülerpasswort (das nur für das Beantragen gilt).
//
// Das Token enthält einen Fingerabdruck des aktuellen Abruf-Codes: Setzt die Administration den
// Code zurück, werden alle laufenden Abruf-Sitzungen sofort ungültig.

const PICKUP_TTL_SECONDS = 2 * 60 * 60;
const fingerprint = (codeHash: string) => codeHash.slice(0, 16);

export async function createPickupToken(env: Env, csrId: number, codeHash: string): Promise<string> {
	const exp = Math.floor(Date.now() / 1000) + PICKUP_TTL_SECONDS;
	const payload = `${exp}.${csrId}.${fingerprint(codeHash)}`;
	return `${payload}.${await hmacSign(env.MASTER_SECRET, "pickup", payload)}`;
}

export async function pickupCsrId(env: Env, request: IRequest): Promise<number | null> {
	const header = request.headers.get("Authorization") ?? "";
	const token = header.startsWith("Bearer ") ? header.slice(7) : "";
	const parts = token.split(".");
	if (parts.length !== 4) return null;
	const [expRaw, idRaw, fp, sig] = parts;
	const exp = Number(expRaw);
	const csrId = Number(idRaw);
	if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000) || !Number.isInteger(csrId)) return null;
	const expected = await hmacSign(env.MASTER_SECRET, "pickup", `${expRaw}.${idRaw}.${fp}`);
	if (!constantTimeEqual(expected, sig)) return null;
	const row = await env.DB.prepare("SELECT code_hash FROM csrs WHERE id = ?1").bind(csrId).first<{ code_hash: string }>();
	return row && constantTimeEqual(fingerprint(row.code_hash), fp) ? csrId : null;
}
