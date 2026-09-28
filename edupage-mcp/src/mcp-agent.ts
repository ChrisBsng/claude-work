import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "./env";
import type { EdupageCredentials } from "./edupage/session-do";

const domainField = z
	.string()
	.regex(/^[a-z0-9-]{1,63}$/i, "Nur die Subdomain, z. B. \"musterschule\" bei musterschule.edupage.org")
	.describe('Edupage-Subdomain, z. B. "musterschule" bei musterschule.edupage.org (ohne ".edupage.org")');
const usernameField = z.string().min(1).describe("Edupage-Benutzername/Login");
const passwordField = z.string().min(1).describe("Edupage-Passwort. Wird nur für den Login verwendet, nicht gespeichert.");

const credentialsShape = {
	domain: domainField,
	username: usernameField,
	password: passwordField,
};

const identityShape = {
	domain: domainField,
	username: usernameField,
};

export class EdupageMcpAgent extends McpAgent<Env> {
	server = new McpServer({ name: "edupage-mcp", version: "0.2.0" });

	/**
	 * Adressiert das Session-Durable-Object für ein Domain+Benutzername-Paar
	 * über einen SHA-256-Hash, statt Rohdaten in den DO-Namen zu schreiben.
	 * So landen dieselben Zugangsdaten immer auf derselben (gecachten)
	 * Session, ohne dass Cloudflare-Logs/Analytics Klartext-Benutzernamen
	 * als DO-Namen sehen.
	 */
	private async sessionFor(domain: string, username: string) {
		const key = `${domain.toLowerCase()}\u0000${username.toLowerCase()}`;
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
		const hash = Array.from(new Uint8Array(digest))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
		return this.env.EDUPAGE_SESSION.getByName(hash);
	}

	async init() {
		this.server.tool(
			"edupage_login",
			"Loggt sich mit den übergebenen Zugangsdaten bei Edupage ein bzw. erneuert die Session. Optional - " +
				"die anderen Tools loggen sich bei Bedarf automatisch ein.",
			credentialsShape,
			async (credentials: EdupageCredentials) => {
				const session = await this.sessionFor(credentials.domain, credentials.username);
				const result = await session.login(credentials);
				return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
			},
		);

		this.server.tool(
			"edupage_logout",
			"Löscht die für domain+username gespeicherte Edupage-Session, sodass sich der nächste Aufruf neu einloggt.",
			identityShape,
			async ({ domain, username }) => {
				const session = await this.sessionFor(domain, username);
				await session.logout();
				return { content: [{ type: "text" as const, text: "Ausgeloggt." }] };
			},
		);

		this.server.tool(
			"edupage_get_timetable",
			"Liefert den Stundenplan für einen Datumsbereich (YYYY-MM-DD). Ohne Angabe wird heute verwendet.",
			{
				...credentialsShape,
				dateFrom: z.string().optional().describe("Startdatum YYYY-MM-DD, Standard: heute"),
				dateTo: z.string().optional().describe("Enddatum YYYY-MM-DD, Standard: dateFrom"),
			},
			async ({ dateFrom, dateTo, ...credentials }: EdupageCredentials & { dateFrom?: string; dateTo?: string }) => {
				const today = new Date().toISOString().slice(0, 10);
				const from = dateFrom ?? today;
				const to = dateTo ?? from;
				const session = await this.sessionFor(credentials.domain, credentials.username);
				const data = await session.ascCall(credentials, "/timetable/server/currenttt.js", "curentttGetData", [
					{ datefrom: from, dateto: to },
				]);
				return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
			},
		);

		this.server.tool(
			"edupage_raw_call",
			"Escape-Hatch: ruft eine beliebige interne Edupage-RPC-Funktion auf (__func/__args-Muster). Damit " +
				"lassen sich weitere Bereiche (Hausaufgaben, Noten, Nachrichten, ...) anbinden, ohne den Server neu " +
				"zu deployen. path/func/args findet man im Browser über die Entwicklertools -> Netzwerk -> XHR-" +
				"Requests, die __func/__args im JSON-Body tragen.",
			{
				...credentialsShape,
				path: z.string().describe("Pfad auf dem Edupage-Host, z. B. /timetable/server/currenttt.js"),
				func: z.string().describe("Der __func-Wert, z. B. curentttGetData"),
				args: z.array(z.unknown()).optional().describe("Zusätzliche Argumente nach dem führenden null in __args"),
			},
			async ({
				path,
				func,
				args,
				...credentials
			}: EdupageCredentials & { path: string; func: string; args?: unknown[] }) => {
				const session = await this.sessionFor(credentials.domain, credentials.username);
				const data = await session.ascCall(credentials, path, func, args ?? []);
				return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
			},
		);

		this.server.tool(
			"edupage_raw_request",
			"Escape-Hatch: führt einen beliebigen authentifizierten HTTP-Request gegen den Edupage-Host aus (mit " +
				"der gespeicherten Session-Cookie). Für Endpunkte außerhalb des __func/__args-Musters.",
			{
				...credentialsShape,
				path: z.string().describe("Pfad auf dem Edupage-Host, z. B. /dashboard/eb.php"),
				method: z.enum(["GET", "POST"]).default("GET"),
				body: z.string().optional().describe("Roher Request-Body für POST-Requests"),
			},
			async ({
				path,
				method,
				body,
				...credentials
			}: EdupageCredentials & { path: string; method: "GET" | "POST"; body?: string }) => {
				const session = await this.sessionFor(credentials.domain, credentials.username);
				const result = await session.rawFetch(credentials, path, { method, body });
				return {
					content: [{ type: "text" as const, text: `HTTP ${result.status}\n\n${result.body.slice(0, 20000)}` }],
				};
			},
		);
	}
}
