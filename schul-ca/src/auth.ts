import type { IRequest } from "itty-router";
import {
	createSessionToken,
	fingerprintOf,
	hashPassword,
	verifyPasswordHash,
	verifyPlainPassword,
	verifySessionToken,
	type Role,
} from "./crypto";
import type { Env } from "./env";

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
	const row = await db.prepare("SELECT value FROM app_settings WHERE key = ?1").bind(key).first<{ value: string | null }>();
	return row?.value ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string | null): Promise<void> {
	await db
		.prepare("INSERT INTO app_settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
		.bind(key, value)
		.run();
}

// Admin: DB-Hash hat Vorrang, solange keiner gesetzt ist gilt das Secret
// ADMIN_PASSWORD (Erst-Einrichtung).
export async function checkPassword(env: Env, role: Role, provided: string): Promise<boolean> {
	if (role === "admin") {
		const stored = await getSetting(env.DB, "admin_password_hash");
		return stored ? verifyPasswordHash(stored, provided) : verifyPlainPassword(env.ADMIN_PASSWORD, provided);
	}
	const stored = await getSetting(env.DB, "student_password_hash");
	return stored ? verifyPasswordHash(stored, provided) : false;
}

async function fingerprintFor(env: Env, role: Role): Promise<string | null> {
	if (role === "admin") {
		const stored = await getSetting(env.DB, "admin_password_hash");
		return fingerprintOf(stored ?? `env:${env.ADMIN_PASSWORD}`);
	}
	const stored = await getSetting(env.DB, "student_password_hash");
	return stored ? fingerprintOf(stored) : null;
}

export async function issueToken(env: Env, role: Role): Promise<string> {
	const fp = await fingerprintFor(env, role);
	if (!fp) throw new Error("Kein Passwort gesetzt");
	return createSessionToken(env.MASTER_SECRET, role, fp);
}

export function requireRole(role: Role) {
	return async (request: IRequest, env: Env): Promise<Response | void> => {
		const header = request.headers.get("Authorization") ?? "";
		const token = header.startsWith("Bearer ") ? header.slice(7) : null;
		const fp = await fingerprintFor(env, role);
		if (!fp || !(await verifySessionToken(env.MASTER_SECRET, token, role, fp))) {
			return Response.json({ error: "Nicht angemeldet oder Sitzung abgelaufen" }, { status: 401 });
		}
	};
}

export const requireAdmin = requireRole("admin");
export const requireStudent = requireRole("student");

export const MIN_PASSWORD_LENGTH = 8;

export async function storePassword(env: Env, role: Role, password: string): Promise<void> {
	await setSetting(env.DB, role === "admin" ? "admin_password_hash" : "student_password_hash", await hashPassword(password));
}
