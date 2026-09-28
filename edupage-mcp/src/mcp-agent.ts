import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "./env";

export class EdupageMcpAgent extends McpAgent<Env> {
	server = new McpServer({ name: "edupage-mcp", version: "0.1.0" });

	private get edupage() {
		return this.env.EDUPAGE_SESSION.getByName("singleton");
	}

	async init() {
		this.server.tool(
			"edupage_login",
			"Loggt sich mit den als Worker-Secrets hinterlegten Zugangsdaten bei Edupage ein bzw. erneuert die Session.",
			async () => {
				const result = await this.edupage.login();
				return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
			},
		);

		this.server.tool(
			"edupage_logout",
			"Löscht die gespeicherte Edupage-Session, sodass sich der nächste Aufruf neu einloggt.",
			async () => {
				await this.edupage.logout();
				return { content: [{ type: "text" as const, text: "Ausgeloggt." }] };
			},
		);

		this.server.tool(
			"edupage_get_timetable",
			"Liefert den Stundenplan für einen Datumsbereich (YYYY-MM-DD). Ohne Angabe wird heute verwendet.",
			{
				dateFrom: z.string().optional().describe("Startdatum YYYY-MM-DD, Standard: heute"),
				dateTo: z.string().optional().describe("Enddatum YYYY-MM-DD, Standard: dateFrom"),
			},
			async ({ dateFrom, dateTo }) => {
				const today = new Date().toISOString().slice(0, 10);
				const from = dateFrom ?? today;
				const to = dateTo ?? from;
				const data = await this.edupage.ascCall("/timetable/server/currenttt.js", "curentttGetData", [
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
				path: z.string().describe("Pfad auf dem Edupage-Host, z. B. /timetable/server/currenttt.js"),
				func: z.string().describe("Der __func-Wert, z. B. curentttGetData"),
				args: z.array(z.unknown()).optional().describe("Zusätzliche Argumente nach dem führenden null in __args"),
			},
			async ({ path, func, args }) => {
				const data = await this.edupage.ascCall(path, func, args ?? []);
				return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
			},
		);

		this.server.tool(
			"edupage_raw_request",
			"Escape-Hatch: führt einen beliebigen authentifizierten HTTP-Request gegen den Edupage-Host aus (mit " +
				"der gespeicherten Session-Cookie). Für Endpunkte außerhalb des __func/__args-Musters.",
			{
				path: z.string().describe("Pfad auf dem Edupage-Host, z. B. /dashboard/eb.php"),
				method: z.enum(["GET", "POST"]).default("GET"),
				body: z.string().optional().describe("Roher Request-Body für POST-Requests"),
			},
			async ({ path, method, body }) => {
				const result = await this.edupage.rawFetch(path, { method, body });
				return {
					content: [{ type: "text" as const, text: `HTTP ${result.status}\n\n${result.body.slice(0, 20000)}` }],
				};
			},
		);
	}
}
