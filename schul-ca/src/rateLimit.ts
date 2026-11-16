import type { Env } from "./env";

export function clientIp(request: Request): string {
	return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

// Zählt einen Versuch und liefert false, sobald das Limit im aktuellen
// Zeitfenster überschritten ist.
export async function rateLimitOk(env: Env, key: string, limit: number, windowSeconds: number): Promise<boolean> {
	const now = Math.floor(Date.now() / 1000);
	const row = await env.DB.prepare(
		`INSERT INTO rate_limits (key, count, reset_at) VALUES (?1, 1, ?2)
		 ON CONFLICT(key) DO UPDATE SET
			count = CASE WHEN rate_limits.reset_at < ?3 THEN 1 ELSE rate_limits.count + 1 END,
			reset_at = CASE WHEN rate_limits.reset_at < ?3 THEN ?2 ELSE rate_limits.reset_at END
		 RETURNING count`,
	)
		.bind(key, now + windowSeconds, now)
		.first<{ count: number }>();
	if (Math.random() < 0.02) await env.DB.prepare("DELETE FROM rate_limits WHERE reset_at < ?1").bind(now).run();
	return (row?.count ?? 1) <= limit;
}
