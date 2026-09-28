import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";

export interface EdupageCredentials {
	domain: string;
	username: string;
	password: string;
}

interface EdupageSession {
	cookie: string;
	gsechash: string;
	userId?: string;
	loggedInAt: number;
}

interface RawRequestInit {
	method?: "GET" | "POST";
	body?: string;
	headers?: Record<string, string>;
}

const SUBDOMAIN_PATTERN = /^[a-z0-9-]{1,63}$/i;

/**
 * Hält die eingeloggte Edupage-Session (Cookie + CSRF-Token) für *eine*
 * Kombination aus Domain+Benutzername am Leben, über mehrere MCP-Aufrufe
 * hinweg. Der Server ist mandantenfähig/generisch: Zugangsdaten werden bei
 * jedem Tool-Aufruf mitgegeben (siehe `mcp-agent.ts`), das Durable Object
 * wird dafür per Hash aus Domain+Benutzername adressiert, sodass derselbe
 * Nutzer immer auf dieselbe (gecachte) Session trifft, ohne dass Zugangsdaten
 * im DO-Namen im Klartext auftauchen. Das Passwort selbst wird nur zum
 * Login verwendet und nie persistiert.
 *
 * Edupage hat keine offizielle/dokumentierte API. Login-Flow und das
 * __func/__args/__gsh-RPC-Muster unten basieren auf reverse-engineerten
 * Endpunkten (wie sie auch inoffizielle Edupage-Clients nutzen) und können
 * brechen, wenn Edupage sein Seitenlayout ändert.
 */
export class EdupageSessionDO extends DurableObject<Env> {
	private session: EdupageSession | null = null;

	private buildBaseUrl(domain: string): string {
		if (!SUBDOMAIN_PATTERN.test(domain)) {
			throw new Error(
				`Ungültige Edupage-Domain "${domain}": erwartet wird nur die Subdomain (z. B. "musterschule" ` +
					`bei musterschule.edupage.org), ohne Punkte, Slashes oder Protokoll.`,
			);
		}
		return `https://${domain}.edupage.org`;
	}

	private async loadSession(): Promise<EdupageSession | null> {
		if (this.session) return this.session;
		const stored = await this.ctx.storage.get<EdupageSession>("session");
		if (stored) this.session = stored;
		return this.session;
	}

	private async ensureSession(credentials: EdupageCredentials): Promise<EdupageSession> {
		return (await this.loadSession()) ?? this.login(credentials).then(() => this.session as EdupageSession);
	}

	/** Loggt sich mit den übergebenen Zugangsdaten ein. */
	async login(credentials: EdupageCredentials): Promise<{ ok: true; userId?: string }> {
		const baseUrl = this.buildBaseUrl(credentials.domain);

		const loginResponse = await fetch(`${baseUrl}/login/edubarLogin.php`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				username: credentials.username,
				password: credentials.password,
			}),
			redirect: "manual",
		});

		const cookie = extractCookieHeader(loginResponse.headers);
		if (!cookie) {
			throw new Error(
				`Edupage-Login fehlgeschlagen: keine Session-Cookie erhalten (HTTP ${loginResponse.status}, ` +
					`Location: ${loginResponse.headers.get("location")}). domain/username/password prüfen.`,
			);
		}

		const dashboardResponse = await fetch(`${baseUrl}/dashboard/eb.php`, {
			headers: { Cookie: cookie },
			redirect: "manual",
		});
		const html = await dashboardResponse.text();

		const match = html.match(/\.userhome\((\{[\s\S]*?\})\);/);
		if (!match) {
			// TEMPORÄR: Diagnose-Ausgabe zum Herausfinden des tatsächlichen
			// Edupage-Seitenformats. Wird entfernt, sobald das Pattern feststeht.
			throw new Error(
				"DEBUG login=" +
					loginResponse.status +
					" loc=" +
					(loginResponse.headers.get("location") ?? "none") +
					" dash=" +
					dashboardResponse.status +
					" dashLoc=" +
					(dashboardResponse.headers.get("location") ?? "none") +
					" hasGsechash=" +
					html.includes("gsechash") +
					" htmlLen=" +
					html.length +
					" snippet=" +
					html.slice(0, 1200).replace(/\s+/g, " "),
			);
		}

		let data: Record<string, unknown>;
		try {
			data = JSON.parse(match[1]);
		} catch {
			throw new Error("Eingebettete Edupage-Dashboard-Daten konnten nicht als JSON geparst werden.");
		}

		const gsechash = data.gsechash as string | undefined;
		if (!gsechash) {
			throw new Error("Eingeloggt, aber kein `gsechash` (CSRF-Token) in den Dashboard-Daten gefunden.");
		}

		const session: EdupageSession = {
			cookie,
			gsechash,
			userId: data.userid as string | undefined,
			loggedInAt: Date.now(),
		};
		this.session = session;
		await this.ctx.storage.put("session", session);
		return { ok: true, userId: session.userId };
	}

	async logout(): Promise<{ ok: true }> {
		this.session = null;
		await this.ctx.storage.delete("session");
		return { ok: true };
	}

	/**
	 * Ruft eine der internen Edupage-RPC-Funktionen auf (__func/__args/__gsh-
	 * Muster, z. B. für den Stundenplan). Loggt sich bei einer abgelaufenen
	 * Session automatisch einmalig neu ein und wiederholt den Aufruf.
	 */
	async ascCall(credentials: EdupageCredentials, path: string, func: string, args: unknown[] = []): Promise<unknown> {
		const baseUrl = this.buildBaseUrl(credentials.domain);
		let session = await this.ensureSession(credentials);

		const call = (s: EdupageSession) =>
			fetch(`${baseUrl}${path}?__func=${encodeURIComponent(func)}`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Cookie: s.cookie },
				body: JSON.stringify({ __args: [null, ...args], __gsh: s.gsechash }),
			});

		let response = await call(session);
		if (response.status === 401 || response.status === 403) {
			await this.login(credentials);
			session = await this.loadSession().then((s) => s as EdupageSession);
			response = await call(session);
		}
		if (!response.ok) {
			throw new Error(`Edupage-Request fehlgeschlagen: ${response.status} ${response.statusText}`);
		}
		return response.json();
	}

	/** Escape-Hatch für Edupage-Endpunkte außerhalb des __func/__args-Musters. */
	async rawFetch(
		credentials: EdupageCredentials,
		path: string,
		init: RawRequestInit = {},
	): Promise<{ status: number; body: string }> {
		const baseUrl = this.buildBaseUrl(credentials.domain);
		const session = await this.ensureSession(credentials);
		const response = await fetch(`${baseUrl}${path}`, {
			method: init.method ?? "GET",
			headers: { Cookie: session.cookie, ...init.headers },
			body: init.body,
		});
		return { status: response.status, body: await response.text() };
	}
}

function extractCookieHeader(headers: Headers): string | null {
	const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
	const setCookies = getSetCookie ? getSetCookie.call(headers) : [headers.get("set-cookie") ?? ""].filter(Boolean);
	if (setCookies.length === 0) return null;
	return setCookies.map((c) => c.split(";")[0]).join("; ");
}
