import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";

// Index-Signatur nötig, damit der Typ als McpAgent-Props-Parameter
// (Record<string, unknown>) durchgereicht werden kann (siehe mcp-agent.ts).
export interface EdupageCredentials {
	domain: string;
	username: string;
	password: string;
	[key: string]: unknown;
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
	/** Interne Edupage-Klassen-IDs zu `classes` (gleiche Reihenfolge) - z. B. für edupage_get_attendance's classId. */
	classIds?: string[];
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
	students: Record<string, string>;
}

/** Rohe Antwortform von mainDBIAccessor (nur die hier genutzten Felder). */
interface RawDbiRow {
	id: string;
	name?: string;
	short?: string;
	firstname?: string;
	lastname?: string;
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

interface RawAttendanceCell {
	note?: string;
	presence?: string;
	studentabsent_typeid?: string;
	subjectid?: string;
	teacherids?: string[];
}

export interface AttendanceItem {
	date: string;
	period: string;
	student: string;
	/** "anwesend" | "abwesend" | "verspätet" | "entschuldigt" | roher Code, falls unbekannt */
	presence: string;
	absentType?: string;
	subject?: string;
	teachers?: string[];
	note?: string;
}

// Presence-Codes aus dem Kontextmenü der Anwesenheits-Ansicht (P/A/L/E-Buttons
// in dochadzka.js). Die Labels für P/A/L sind aus der Button-Reihenfolge und
// gängiger Attendance-Semantik abgeleitet; "E" (ls(9255), Text nicht direkt
// eingesehen) ist die unsicherste Zuordnung.
function presenceLabel(code: string | undefined): string {
	switch (code) {
		case "P":
			return "anwesend";
		case "A":
			return "abwesend";
		case "L":
			return "verspätet";
		case "E":
			return "entschuldigt";
		case undefined:
		case "":
			return "anwesend";
		default:
			return code;
	}
}

/**
 * Dekodiert Edupages proprietäres `ASC.json_dc([struktur, dict])`-Kompaktformat
 * (verwendet u. a. von /gcall-Antworten wie der Anwesenheits-Ansicht). Portiert
 * 1:1 aus der `json_dc`-Funktion in Edupages eigenem `bundle_main.min.js`
 * (gegen echte Antworten verifiziert):
 *
 * - Token -1: Array, gefolgt von Länge, dann so viele dekodierte Elemente.
 * - Token -2: Objekt, gefolgt von Länge, dann so viele Keys (dekodiert),
 *   dann so viele Values (dekodiert). Das Key-Set wird für spätere
 *   Objekte mit denselben Keys gemerkt (siehe unten).
 * - Token -3/-4/-5: leeres/1-/2-elementiges Array (Kurzform).
 * - Andere negative Tokens < -9: Verweis auf ein früher gesehenes Key-Set
 *   (Index `-token-10`), gefolgt von so vielen Values wie Keys im Set -
 *   spart wiederholte Key-Strings bei vielen gleich geformten Objekten
 *   (z. B. eine Zelle pro Schüler/Datum/Stunde).
 * - Token >= 0: Index ins Dictionary-Array (Literalwert; Arrays werden
 *   kopiert, damit spätere Mutation den Dictionary-Eintrag nicht verändert).
 */
function decodeJsonDc(payload: [unknown[], unknown[]]): unknown {
	const structure = payload[0] as number[];
	const dict = payload[1] as unknown[];
	const keySets: string[][] = [];
	let pos = 0;

	function decode(): unknown {
		const token = structure[pos++];
		switch (token) {
			case -1: {
				const len = structure[pos++] as number;
				const arr: unknown[] = [];
				for (let i = 0; i < len; i++) arr.push(decode());
				return arr;
			}
			case -2: {
				const len = structure[pos++] as number;
				const keys: string[] = [];
				for (let i = 0; i < len; i++) keys.push(decode() as string);
				keySets.push(keys);
				const obj: Record<string, unknown> = {};
				for (let i = 0; i < len; i++) obj[keys[i]] = decode();
				return obj;
			}
			case -3:
				return [];
			case -4:
				return [decode()];
			case -5:
				return [decode(), decode()];
		}
		if (token < 0) {
			const keys = keySets[-token - 10] ?? [];
			const obj: Record<string, unknown> = {};
			for (const key of keys) obj[key] = decode();
			return obj;
		}
		const value = dict[token as number];
		return Array.isArray(value) ? value.slice() : value;
	}

	return decode();
}

/**
 * Findet alle `ASC.json_dc([...])`-Aufrufe in einem rohen `"JS:"`-/gcall-
 * Antworttext und liefert ihre (noch unkodierten) Argument-Arrays. Sucht
 * klammertief- und string-bewusst nach dem Ende jedes Arrays, statt naiv
 * nach der nächsten `])`-Zeichenkette (die auch in einem String-Wert
 * vorkommen könnte).
 */
function extractJsonDcPayloads(js: string): Array<[unknown[], unknown[]]> {
	const marker = "ASC.json_dc(";
	const payloads: Array<[unknown[], unknown[]]> = [];
	let searchFrom = 0;

	while (true) {
		const markerIdx = js.indexOf(marker, searchFrom);
		if (markerIdx === -1) break;
		const argStart = markerIdx + marker.length;

		let i = argStart;
		let depth = 0;
		let inString = false;
		for (; i < js.length; i++) {
			const ch = js[i];
			if (inString) {
				if (ch === "\\") {
					i++;
					continue;
				}
				if (ch === '"') inString = false;
				continue;
			}
			if (ch === '"') {
				inString = true;
				continue;
			}
			if (ch === "[") depth++;
			else if (ch === "]") {
				depth--;
				if (depth === 0) {
					i++;
					break;
				}
			}
		}

		const argText = js.slice(argStart, i);
		try {
			payloads.push(JSON.parse(argText));
		} catch {
			// Unerwartetes/kaputtes Payload - überspringen statt den ganzen Aufruf scheitern zu lassen.
		}
		searchFrom = Math.max(i, markerIdx + marker.length);
	}

	return payloads;
}

/**
 * Prüft strukturell, ob ein dekodiertes json_dc-Payload die Anwesenheits-
 * Zellen (students[id][datum][stunde] = {...}) trägt, statt z. B. der
 * (unter demselben "students"-Schlüssel liegenden!) flachen Schülerstamm-
 * daten students[id] = {classid, firstname, id, lastname, short, ...}, die
 * Edupage je nach Klasse als zusätzlichen/letzten json_dc-Block mitschickt.
 * Erkennungsmerkmal: bei Zelldaten sind die Schlüssel der zweiten Ebene
 * YYYY-MM-DD-Datumsstrings: bei Stammdaten sind es Feldnamen wie "classid".
 */
function isAttendanceCellData(
	value: unknown,
): value is { students: Record<string, Record<string, Record<string, RawAttendanceCell>>> } {
	if (!value || typeof value !== "object") return false;
	const students = (value as Record<string, unknown>).students;
	if (!students || typeof students !== "object") return false;
	for (const byDate of Object.values(students)) {
		if (!byDate || typeof byDate !== "object") return false;
		return Object.keys(byDate).every((key) => /^\d{4}-\d{2}-\d{2}$/.test(key));
	}
	// Leeres students-Objekt (z. B. echte Fehlanzeige für die Woche) - nichts
	// dagegen einzuwenden, kann nicht als falsch erkannt werden.
	return true;
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
		classIds: raw.classids && raw.classids.length > 0 ? raw.classids : undefined,
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
	async getNameLookup(
		credentials: EdupageCredentials,
		datefrom: string,
		dateto: string,
		options: { includeStudents?: boolean } = {},
	): Promise<NameLookup> {
		const year = Number(datefrom.slice(0, 4));
		const neededPart: Record<string, string[]> = {
			teachers: ["short"],
			subjects: ["name", "short"],
			classes: ["name", "short"],
			classrooms: ["name", "short"],
		};
		if (options.includeStudents) neededPart.students = ["firstname", "lastname"];

		const data = (await this.ascCall(credentials, "/rpr/server/maindbi.js", "mainDBIAccessor", [
			year,
			{ vt_filter: { datefrom, dateto } },
			{ op: "fetch", needed_part: neededPart, needed_combos: {} },
		])) as { r?: { tables?: RawDbiTable[] } };

		const lookup: NameLookup = { teachers: {}, subjects: {}, classes: {}, classrooms: {}, students: {} };
		for (const table of data.r?.tables ?? []) {
			const target = (lookup as unknown as Record<string, Record<string, string> | undefined>)[table.id];
			if (!target) continue;
			for (const row of table.data_rows ?? []) {
				const fullName = [row.firstname, row.lastname].filter(Boolean).join(" ");
				target[row.id] = fullName || row.name || row.short || row.id;
			}
		}
		return lookup;
	}

	/**
	 * Generischer POST an `/gcall`, das Legacy-AJAX-Postback-System hinter
	 * z. B. der Anwesenheits-Ansicht. `gpid` adressiert eine zuvor per Seiten-
	 * abruf erzeugte Server-Instanz eines UI-Widgets (siehe getGpid), die
	 * ihren eigenen Zustand (z. B. gewählte Klasse) hält - anders als das
	 * __func/__args-Muster ist das hier zustandsbehaftet.
	 */
	private async gcall(
		credentials: EdupageCredentials,
		gpid: string,
		action: string,
		extraParams: Record<string, string> = {},
	): Promise<string> {
		const baseUrl = this.buildBaseUrl(credentials.domain);
		const session = await this.ensureSession(credentials);
		const params = new URLSearchParams({ gpid, gsh: session.gsechash, action, _LJSL: "0" });
		for (const [key, value] of Object.entries(extraParams)) params.set(key, value);

		const response = await fetch(`${baseUrl}/gcall`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: session.cookie },
			body: params.toString(),
		});
		if (!response.ok) {
			throw new Error(`Edupage-gcall fehlgeschlagen: ${response.status} ${response.statusText}`);
		}
		return response.text();
	}

	/**
	 * Lädt eine Dashboard-Seite und liest die `gpid` (Gadget-Instanz-ID, z. B.
	 * aus `<div id="gip19737901" ...>`) heraus, die für nachfolgende
	 * `gcall`-Aufrufe an dieses Widget gebraucht wird. Dashboard-Seiten
	 * verschachteln oft einen generischen "DashboardDiv"-Wrapper-Gadget
	 * (äußere gpid) um das eigentliche Modul-Widget (innere gpid) - nur die
	 * innerste/letzte gpid im HTML reagiert auf die modulspezifischen
	 * Aktionen (z. B. "refresh" mit einem Datum), die äußere liefert nur
	 * einen generischen Fehler.
	 */
	private async getGpid(credentials: EdupageCredentials, path: string): Promise<string> {
		const baseUrl = this.buildBaseUrl(credentials.domain);
		const session = await this.ensureSession(credentials);
		const response = await fetch(`${baseUrl}${path}`, { headers: { Cookie: session.cookie } });
		const html = await response.text();
		const matches = [...html.matchAll(/id=["']gip(\d+)["']/g)];
		if (matches.length === 0) {
			throw new Error(
				`Konnte keine Gadget-ID (gpid) auf "${path}" finden. Entweder hat Edupage das Seitenlayout ` +
					"geändert, oder dieses Modul ist für den Account nicht verfügbar/aktiviert.",
			);
		}
		return matches[matches.length - 1][1];
	}

	/**
	 * Schüler-Anwesenheit für eine Woche (und optional eine bestimmte Klasse -
	 * ohne Angabe bleibt die zuletzt/serverseitig vorausgewählte Klasse
	 * aktiv, i. d. R. die eigene Klasse). Anders als der Stundenplan läuft
	 * das nicht über __func/__args, sondern über das ältere /gcall-
	 * Postback-System: Seite laden -> gpid auslesen -> ggf. Klasse wechseln
	 * -> Woche anfragen -> Antwort ist ein `"JS:"`-Skript, das u. a. zwei
	 * `ASC.json_dc(...)`-kodierte Datenblöcke enthält (Namens-Cache + die
	 * eigentlichen Zellen). Namen (Schüler/Fach/Lehrkraft) werden separat
	 * über getNameLookup aufgelöst statt aus dem Namens-Cache, da dieser
	 * unklarer strukturiert ist.
	 */
	async getAttendance(
		credentials: EdupageCredentials,
		weekDate: string,
		classId?: string,
	): Promise<{ items: AttendanceItem[] }> {
		const gpid = await this.getGpid(credentials, "/dashboard/eb.php?mode=attendance");

		if (classId) {
			await this.gcall(credentials, gpid, "refresh", { table: "classes", id: classId });
		}
		const responseText = await this.gcall(credentials, gpid, "refresh", { date: weekDate });

		const payloads = extractJsonDcPayloads(responseText);
		if (payloads.length === 0) {
			throw new Error(
				"Die Antwort der Anwesenheits-Ansicht enthielt keine erkennbaren Daten. Möglich: Edupage hat das " +
					"Antwortformat geändert, oder für diese Woche/Klasse ist nichts hinterlegt.",
			);
		}

		// Wie viele json_dc-Blöcke die Antwort enthält und in welcher
		// Reihenfolge (Zelldaten vs. Referenz-/Stammdaten-Blöcke) variiert
		// je nach Klasse - bei manchen Klassen kommt z. B. zusätzlich ein
		// Schülerstammdaten-Block, der ebenfalls unter "students" liegt.
		// Daher nicht mehr nach fester Position greifen, sondern jedes
		// Payload dekodieren und strukturell erkennen, was es ist.
		const decoded = payloads.map((p) => {
			try {
				return decodeJsonDc(p);
			} catch {
				return undefined;
			}
		});

		const cellData = decoded.find(isAttendanceCellData);
		if (!cellData) {
			throw new Error(
				"Die Antwort der Anwesenheits-Ansicht enthielt keine auswertbaren Stundeneinträge (nur " +
					"Referenz-/Schülerstammdaten). Möglich: für diese Woche/Klasse liegt nichts vor, oder Edupage hat " +
					"das Antwortformat geändert.",
			);
		}

		// Der Referenz-/Namens-Cache dieser Ansicht enthält u. a. die
		// Klartexte für studentabsent_typeid (z. B. "-9" -> "Entschuldigte
		// Stunden") - kann in jedem der Blöcke stecken, daher alle absuchen.
		let absentTypes: Record<string, string> = {};
		for (const entry of decoded) {
			const types = (entry as { studentabsent_types?: Record<string, { name?: string; short?: string }> } | undefined)
				?.studentabsent_types;
			if (types) {
				for (const [id, info] of Object.entries(types)) {
					absentTypes[id] = info.name || info.short || id;
				}
				break;
			}
		}

		const lookup = await this.getNameLookup(credentials, weekDate, weekDate, { includeStudents: true });

		const items: AttendanceItem[] = [];
		for (const [studentId, byDate] of Object.entries(cellData.students ?? {})) {
			for (const [date, byPeriod] of Object.entries(byDate)) {
				for (const [period, cell] of Object.entries(byPeriod)) {
					items.push({
						date,
						period,
						student: lookup.students[studentId] ?? studentId,
						presence: presenceLabel(cell.presence),
						absentType: cell.studentabsent_typeid ? (absentTypes[cell.studentabsent_typeid] ?? cell.studentabsent_typeid) : undefined,
						subject: cell.subjectid ? (lookup.subjects[cell.subjectid] ?? cell.subjectid) : undefined,
						teachers: resolveNames(cell.teacherids, lookup.teachers),
						note: cell.note || undefined,
					});
				}
			}
		}
		items.sort((a, b) => (a.date + a.period).localeCompare(b.date + b.period));
		return { items };
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
