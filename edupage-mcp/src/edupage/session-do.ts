import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";

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

/**
 * Hält die eingeloggte Edupage-Session (Cookie + CSRF-Token) über mehrere
 * MCP-Verbindungen hinweg am Leben. Wird als ein einziges, namentlich
 * adressiertes Durable Object verwendet (siehe `EdupageMcpAgent.edupage`),
 * damit sich nicht jede neue MCP-Verbindung erneut einloggen muss.
 *
 * Edupage hat keine offizielle/dokumentierte API. Login-Flow und das
 * __func/__args/__gsh-RPC-Muster unten basieren auf reverse-engineerten
 * Endpunkten (wie sie auch inoffizielle Edupage-Clients nutzen) und können
 * brechen, wenn Edupage sein Seitenlayout ändert.
 */
export class EdupageSessionDO extends DurableObject<Env> {
	private session: EdupageSession | null = null;

	private get baseUrl(): string {
		return `https://${this.env.EDUPAGE_SUBDOMAIN}.edupage.org`;
	}

	private async loadSession(): Promise<EdupageSession | null> {
		if (this.session) return this.session;
		const stored = await this.ctx.storage.get<EdupageSession>("session");
		if (stored) this.session = stored;
		return this.session;
	}

	private async ensureSession(): Promise<EdupageSession> {
		return (await this.loadSession()) ?? this.login().then(() => this.session as EdupageSession);
	}

	/** Loggt sich mit den in den Worker-Secrets hinterlegten Zugangsdaten ein. */
	async login(): Promise<{ ok: true; userId?: string }> {
		const loginResponse = await fetch(`${this.baseUrl}/login/edubarLogin.php`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				username: this.env.EDUPAGE_USERNAME,
				password: this.env.EDUPAGE_PASSWORD,
			}),
			redirect: "manual",
		});

		const cookie = extractCookieHeader(loginResponse.headers);
		if (!cookie) {
			throw new Error(
				"Edupage-Login fehlgeschlagen: keine Session-Cookie erhalten. " +
					"EDUPAGE_SUBDOMAIN/EDUPAGE_USERNAME/EDUPAGE_PASSWORD prüfen.",
			);
		}

		const dashboardResponse = await fetch(`${this.baseUrl}/dashboard/eb.php`, {
			headers: { Cookie: cookie },
		});
		const html = await dashboardResponse.text();

		const match = html.match(/\.userhome\((\{[\s\S]*?\})\);/);
		if (!match) {
			throw new Error(
				"Login schien zu funktionieren, aber die Dashboard-Seite enthielt nicht die erwarteten " +
					"eingebetteten Daten (.userhome(...)). Entweder hat Edupage sein Seitenlayout geändert, " +
					"oder Benutzername/Passwort/Subdomain sind falsch.",
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
	async ascCall(path: string, func: string, args: unknown[] = []): Promise<unknown> {
		let session = await this.ensureSession();

		const call = (s: EdupageSession) =>
			fetch(`${this.baseUrl}${path}?__func=${encodeURIComponent(func)}`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Cookie: s.cookie },
				body: JSON.stringify({ __args: [null, ...args], __gsh: s.gsechash }),
			});

		let response = await call(session);
		if (response.status === 401 || response.status === 403) {
			await this.login();
			session = await this.loadSession().then((s) => s as EdupageSession);
			response = await call(session);
		}
		if (!response.ok) {
			throw new Error(`Edupage-Request fehlgeschlagen: ${response.status} ${response.statusText}`);
		}
		return response.json();
	}

	/** Escape-Hatch für Edupage-Endpunkte außerhalb des __func/__args-Musters. */
	async rawFetch(path: string, init: RawRequestInit = {}): Promise<{ status: number; body: string }> {
		const session = await this.ensureSession();
		const response = await fetch(`${this.baseUrl}${path}`, {
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
