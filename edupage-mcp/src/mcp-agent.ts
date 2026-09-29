import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "./env";
import type { EdupageCredentials, EdupageSessionDO } from "./edupage/session-do";
import { sessionKeyFor } from "./edupage/session-key";

export class EdupageMcpAgent extends McpAgent<Env, unknown, EdupageCredentials> {
	server = new McpServer({ name: "edupage-mcp", version: "0.3.0" });

	/**
	 * Die Edupage-Zugangsdaten kommen nicht mehr pro Tool-Aufruf, sondern aus
	 * this.props - gesetzt einmalig beim OAuth-Authorize-Flow (siehe
	 * app-handler.ts) und für die Dauer der MCP-Verbindung von der Agents-SDK
	 * persistiert. Das zugehörige Session-DO wird über denselben Hash wie
	 * beim Login adressiert, damit dieselbe (gecachte) Edupage-Session
	 * wiederverwendet wird.
	 */
	private async session(): Promise<{ stub: DurableObjectStub<EdupageSessionDO>; credentials: EdupageCredentials }> {
		const credentials = this.props;
		if (!credentials) {
			throw new Error(
				"Keine Edupage-Zugangsdaten hinterlegt. Bitte den Connector über /authorize (neu) verbinden.",
			);
		}
		const key = await sessionKeyFor(credentials.domain, credentials.username);
		return { stub: this.env.EDUPAGE_SESSION.getByName(key), credentials };
	}

	async init() {
		this.server.tool(
			"edupage_get_timetable",
			"Liefert den Stundenplan für einen Datumsbereich (YYYY-MM-DD). Ohne Angabe wird heute verwendet. Jeder " +
				"Eintrag enthält neben den Klarnamen (classes) auch die internen Klassen-IDs (classIds, gleiche " +
				"Reihenfolge) - damit lassen sich z. B. alle in einer Woche unterrichteten Klassen ermitteln, um sie " +
				"einzeln mit edupage_get_attendance abzufragen.",
			{
				dateFrom: z.string().optional().describe("Startdatum YYYY-MM-DD, Standard: heute"),
				dateTo: z.string().optional().describe("Enddatum YYYY-MM-DD, Standard: dateFrom"),
			},
			async ({ dateFrom, dateTo }: { dateFrom?: string; dateTo?: string }) => {
				const today = new Date().toISOString().slice(0, 10);
				const from = dateFrom ?? today;
				const to = dateTo ?? from;
				const { stub, credentials } = await this.session();
				const data = await stub.getTimetable(credentials, from, to);
				return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
			},
		);

		this.server.tool(
			"edupage_get_attendance",
			"Liefert die Schüler-Anwesenheit (anwesend/abwesend/verspätet/entschuldigt je Schüler, Datum und " +
				"Stunde) für eine Woche - der Bereich 'Unterricht -> Schüler-Abwesenheit'. Liefert immer nur EINE " +
				"Klasse pro Aufruf: mit classId die angegebene, ohne classId die zuletzt/serverseitig " +
				"vorausgewählte Klasse (meist die eigene). Um alle Klassen einer Woche abzudecken, zuerst " +
				"edupage_get_timetable für den Zeitraum aufrufen, die eindeutigen classIds daraus sammeln und " +
				"edupage_get_attendance einmal je classId aufrufen.",
			{
				date: z.string().describe("Ein beliebiges Datum (YYYY-MM-DD) innerhalb der gewünschten Woche"),
				classId: z
					.string()
					.optional()
					.describe(
						"Interne Edupage-Klassen-ID (z. B. \"-461\"), aus edupage_get_timetable's classIds-Feld. Ohne " +
							"Angabe: zuletzt gewählte/eigene Klasse.",
					),
			},
			async ({ date, classId }: { date: string; classId?: string }) => {
				const { stub, credentials } = await this.session();
				const data = await stub.getAttendance(credentials, date, classId);
				return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
			},
		);

		// TEMPORÄR: Debug-Werkzeug zur Fehlersuche, warum manche Klassen bei
		// edupage_get_attendance keine Zelldaten liefern. Wieder entfernen,
		// sobald die Ursache gefunden/behoben ist.
		this.server.tool(
			"edupage_debug_attendance_raw",
			"TEMP DEBUG: rohe gcall-Antworten + decodierte json_dc-Block-Zusammenfassungen für die Anwesenheits-Ansicht.",
			{
				date: z.string(),
				classId: z.string().optional(),
			},
			async ({ date, classId }: { date: string; classId?: string }) => {
				const { stub, credentials } = await this.session();
				const data = await stub.debugAttendanceRaw(credentials, date, classId);
				return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
			},
		);

		this.server.tool(
			"edupage_logout",
			"Löscht die für die aktuell verbundenen Edupage-Zugangsdaten gespeicherte Session, sodass sich der " +
				"nächste Aufruf neu einloggt.",
			{},
			async () => {
				const { stub } = await this.session();
				await stub.logout();
				return { content: [{ type: "text" as const, text: "Ausgeloggt." }] };
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
			async ({ path, func, args }: { path: string; func: string; args?: unknown[] }) => {
				const { stub, credentials } = await this.session();
				const data = await stub.ascCall(credentials, path, func, args ?? []);
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
			async ({ path, method, body }: { path: string; method: "GET" | "POST"; body?: string }) => {
				const { stub, credentials } = await this.session();
				const result = await stub.rawFetch(credentials, path, { method, body });
				return {
					content: [{ type: "text" as const, text: `HTTP ${result.status}\n\n${result.body.slice(0, 20000)}` }],
				};
			},
		);

		this.server.tool(
			"edupage_find_in_page",
			"Escape-Hatch: lädt eine Edupage-Seite (GET) und sucht serverseitig nach einem Textausschnitt, statt " +
				"die komplette (oft >1MB große) Seite zu übertragen. Liefert den Kontext um die ersten Treffer " +
				"zurück. Nützlich, um im HTML/Inline-JS einer Dashboard-Seite zu finden, mit welchen Parametern " +
				"das echte Edupage-Frontend eine bestimmte RPC-Funktion aufruft.",
			{
				path: z.string().describe("Pfad auf dem Edupage-Host, z. B. /dashboard/eb.php?mode=timetable"),
				find: z.string().min(1).describe('Zu suchender Textausschnitt, z. B. "curentttGetData"'),
			},
			async ({ path, find }: { path: string; find: string }) => {
				const { stub, credentials } = await this.session();
				const result = await stub.findInPage(credentials, path, find);
				const text =
					result.matches.length === 0
						? `HTTP ${result.status} - kein Treffer für "${find}" gefunden.`
						: `HTTP ${result.status} - ${result.matches.length} Treffer:\n\n` +
							result.matches.map((m, i) => `--- Treffer ${i + 1} ---\n${m}`).join("\n\n");
				return { content: [{ type: "text" as const, text }] };
			},
		);
	}
}
