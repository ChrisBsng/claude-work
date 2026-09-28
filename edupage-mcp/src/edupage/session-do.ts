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
	/**
	 * Interne Kennung des eingeloggten Nutzers, z. B. "Ucitel-184" für eine
	 * Lehrkraft mit interner ID -184 (Slovak: Ucitel = Lehrer, Ziak =
	 * Schüler - Edupage stammt aus der Slowakei und nutzt diese Rollen-
	 * Präfixe intern unabhängig von der UI-Sprache). Wird u. a. gebraucht,
	 * um beim Stundenplan-Abruf table/id für "meine eigenen Stunden" zu
	 * bilden (siehe getTimetable).
	 */
	loggedUser?: string;
	loggedInAt: number;
}

// Bekannte Edupage-Rollenpräfixe -> Tabellenname für curentttGetData.
// Nur "Ucitel" (Lehrkraft) ist gegen eine echte Instanz verifiziert; die
// übrigen sind plausible Vermutungen (gleiches Namensschema) und werden
// nicht garantiert korrekt sein.
const ROLE_TABLE_MAP: Record<string, string> = {
	ucitel: "teachers",
	ziak: "students",
	student: "students",
};

interface RawRequestInit {
	method?: "GET" | "POST";
	body?: string;
	headers?: Record<string, string>;
}

// Grobe, unvollständige Typen für die rohe curentttGetData-Antwort - Edupage
// dokumentiert das Format nicht, jedes Feld hier ist aus echten Responses
// abgeleitet. Nur das, was simplifyTimetableItem tatsächlich liest.
interface RawTimetableHeaderEntry {
	text?: string;
	item?: { text?: string };
}
interface RawTimetableItem {
	name?: string;
	date?: string;
	starttime?: string;
	endtime?: string;
	subjectid?: string;
	classids?: string[];
	teacherids?: string[];
	classroomids?: string[];
	uniperiod?: string;
	dpRow?: {
		type?: string;
		header?: RawTimetableHeaderEntry[];
		flags?: { dp0?: { period?: string; allday?: boolean; cancelled?: boolean } };
	};
}

export interface TimetableItem {
	date: string;
	type: "lesson" | "event";
	title: string;
	start: string;
	end: string;
	period?: string;
	subject?: string;
	classes?: string[];
	teachers?: string[];
	rooms?: string[];
	allDay?: boolean;
	cancelled?: boolean;
}

/** id -> Name/Abkürzung, je eine Tabelle pro Kategorie (siehe getNameLookup). */
export interface NameLookup {
	teachers: Record<string, string>;
	subjects: Record<string, string>;
	classes: Record<string, string>;
	classrooms: Record<string, string>;
}

/** Rohe Antwortform von mainDBIAccessor (nur die hier genutzten Felder). */
interface RawDbiRow {
	id: string;
	name?: string;
	short?: string;
}
interface RawDbiTable {
	id: string;
	data_rows?: RawDbiRow[];
}

/** Erste lesbare Kopfzeile aus dpRow.header, z. B. "BEE32A · EEA" für eine Stunde. */
function headerText(header?: RawTimetableHeaderEntry[]): string | undefined {
	for (const entry of header ?? []) {
		const text = entry.text ?? entry.item?.text;
		if (text) return text;
	}
	return undefined;
}

function resolveNames(ids: string[] | undefined, table: Record<string, string>): string[] | undefined {
	if (!ids || ids.length === 0) return undefined;
	return ids.map((id) => table[id] ?? id);
}

/**
 * Reduziert einen rohen curentttGetData-Eintrag auf die für Menschen (bzw.
 * ein LLM) relevanten Felder und löst Fach-/Klassen-/Lehrkraft-/Raum-IDs
 * über `lookup` in Klarnamen auf. Die Rohantwort trägt pro Eintrag komplette
 * UI-Menüs, Schülerlisten, Feld-Definitionen usw. mit - unnötig groß für
 * den normalen "was steht heute an"-Anwendungsfall.
 */
function simplifyTimetableItem(raw: RawTimetableItem, lookup: NameLookup): TimetableItem {
	const isLesson = raw.dpRow?.type === "lesson";
	const flags = raw.dpRow?.flags?.dp0;
	const subjectId = raw.subjectid || undefined;
	return {
		date: raw.date ?? "",
		type: isLesson ? "lesson" : "event",
		title: (isLesson ? headerText(raw.dpRow?.header) : raw.name) ?? headerText(raw.dpRow?.header) ?? raw.name ?? "",
		start: raw.starttime ?? "",
		end: raw.endtime ?? "",
		period: flags?.period || raw.uniperiod || undefined,
		subject: subjectId ? (lookup.subjects[subjectId] ?? subjectId) : undefined,
		classes: resolveNames(raw.classids, lookup.classes),
		teachers: resolveNames(raw.teacherids, lookup.teachers),
		rooms: resolveNames(raw.classroomids, lookup.classrooms),
		allDay: flags?.allday,
		cancelled: flags?.cancelled,
	};
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

		// Das Dashboard bettet seinen Zustand nicht als JSON ein, sondern als
		// eine Reihe von `ASC.<feld> = <wert>;`-Zuweisungen in einem
		// <script>-Tag (z. B. `ASC.gsechash="6e94790d";`, `ASC.edupage="bktm";`).
		const gsechashMatch = html.match(/ASC\.gsechash\s*=\s*"([^"]*)"/);
		if (!gsechashMatch || !gsechashMatch[1]) {
			throw new Error(
				"Login schien zu funktionieren, aber `ASC.gsechash` (CSRF-Token) wurde nicht in der " +
					"Dashboard-Seite gefunden. Entweder hat Edupage sein Seitenlayout geändert, oder " +
					"domain/username/password sind falsch.",
			);
		}
		const userIdMatch = html.match(/ASC\.userid\s*=\s*"([^"]*)"/);
		const loggedUserMatch = html.match(/"loggedUser"\s*:\s*"([^"]*)"/);

		const session: EdupageSession = {
			cookie,
			gsechash: gsechashMatch[1],
			userId: userIdMatch?.[1],
			loggedUser: loggedUserMatch?.[1],
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

	/**
	 * Stundenplan für einen Datumsbereich. `curentttGetData` liefert ohne
	 * `table`/`id` nur schulweite Termine (Feiertage, Ferien, ...), nicht
	 * die persönlichen Unterrichtsstunden - dafür müssen table/id explizit
	 * die eigene Rolle+ID tragen (z. B. `table:"teachers", id:"-184"` für
	 * die Lehrkraft mit interner ID -184, aus `loggedUser:"Ucitel-184"`
	 * abgeleitet). Für unbekannte Rollenpräfixe werden table/id weggelassen
	 * (liefert dann nur die schulweiten Termine).
	 */
	async getTimetable(
		credentials: EdupageCredentials,
		datefrom: string,
		dateto: string,
	): Promise<{ items: TimetableItem[] }> {
		const session = await this.ensureSession(credentials);
		const args: Record<string, unknown> = {
			year: Number(datefrom.slice(0, 4)),
			datefrom,
			dateto,
			showColors: true,
			showIgroupsInClasses: false,
			showOrig: true,
			log_module: "CurrentTTView",
		};

		const roleMatch = session.loggedUser?.match(/^([A-Za-z]+)(-?\d+)$/);
		const table = roleMatch && ROLE_TABLE_MAP[roleMatch[1].toLowerCase()];
		if (roleMatch && table) {
			args.table = table;
			args.id = roleMatch[2];
		}

		const [data, lookup] = await Promise.all([
			this.ascCall(credentials, "/timetable/server/currenttt.js", "curentttGetData", [args]) as Promise<{
				r?: { ttitems?: RawTimetableItem[] };
			}>,
			this.getNameLookup(credentials, datefrom, dateto),
		]);
		return { items: (data.r?.ttitems ?? []).map((raw) => simplifyTimetableItem(raw, lookup)) };
	}

	/**
	 * Löst Lehrkraft-/Fach-/Klassen-/Raum-IDs in Klarnamen auf, über die
	 * interne `mainDBIAccessor`-RPC (Pfad `/rpr/server/maindbi.js`) -
	 * dieselbe Datenquelle, aus der Edupages eigenes Frontend die Namen für
	 * die Stundenplan-Ansicht zieht. Für Lehrkräfte wird nur `short`
	 * (Kürzel) angefragt, nicht der volle Name - das ist bereits die
	 * Darstellung, die Edupage selbst im Stundenplan verwendet.
	 */
	async getNameLookup(credentials: EdupageCredentials, datefrom: string, dateto: string): Promise<NameLookup> {
		const year = Number(datefrom.slice(0, 4));
		const data = (await this.ascCall(credentials, "/rpr/server/maindbi.js", "mainDBIAccessor", [
			year,
			{ vt_filter: { datefrom, dateto } },
			{
				op: "fetch",
				needed_part: {
					teachers: ["short"],
					subjects: ["name", "short"],
					classes: ["name", "short"],
					classrooms: ["name", "short"],
				},
				needed_combos: {},
			},
		])) as { r?: { tables?: RawDbiTable[] } };

		const lookup: NameLookup = { teachers: {}, subjects: {}, classes: {}, classrooms: {} };
		for (const table of data.r?.tables ?? []) {
			const target = (lookup as unknown as Record<string, Record<string, string> | undefined>)[table.id];
			if (!target) continue;
			for (const row of table.data_rows ?? []) {
				target[row.id] = row.name || row.short || row.id;
			}
		}
		return lookup;
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

	/**
	 * Escape-Hatch zum Erkunden großer Edupage-Seiten (Dashboard-Seiten sind
	 * oft >1MB): sucht serverseitig nach einem Textausschnitt und liefert
	 * die Umgebung der ersten Treffer zurück, statt die ganze (abgeschnittene)
	 * Seite zu übertragen. Nützlich, um z. B. herauszufinden, mit welchen
	 * genauen Parametern das echte Edupage-Frontend eine RPC-Funktion aufruft.
	 */
	async findInPage(
		credentials: EdupageCredentials,
		path: string,
		needle: string,
		contextChars = 400,
		maxMatches = 5,
	): Promise<{ status: number; matches: string[] }> {
		const baseUrl = this.buildBaseUrl(credentials.domain);
		const session = await this.ensureSession(credentials);
		const response = await fetch(`${baseUrl}${path}`, {
			headers: { Cookie: session.cookie },
		});
		const text = await response.text();

		const matches: string[] = [];
		let searchFrom = 0;
		while (matches.length < maxMatches) {
			const idx = text.indexOf(needle, searchFrom);
			if (idx === -1) break;
			matches.push(text.slice(Math.max(0, idx - contextChars), idx + needle.length + contextChars).replace(/\s+/g, " "));
			searchFrom = idx + needle.length;
		}
		return { status: response.status, matches };
	}
}

function extractCookieHeader(headers: Headers): string | null {
	const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
	const setCookies = getSetCookie ? getSetCookie.call(headers) : [headers.get("set-cookie") ?? ""].filter(Boolean);
	if (setCookies.length === 0) return null;
	return setCookies.map((c) => c.split(";")[0]).join("; ");
}
