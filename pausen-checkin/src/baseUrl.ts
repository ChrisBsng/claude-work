import type { Env } from "./env";

// Wenn CUSTOM_DOMAIN gesetzt ist, nutzen alle erzeugten URLs (Dashboard-
// /Check-in-Links, QR-Codes) diese feste Domain statt der Domain, über
// die die jeweilige Anfrage tatsächlich einging (workers.dev, Custom
// Domain, Vorschau-URL, ...).
export function resolveBaseUrl(env: Env, request: Request): string {
	const customDomain = env.CUSTOM_DOMAIN?.trim();
	if (customDomain) {
		return `https://${customDomain}`;
	}
	return new URL(request.url).origin;
}
