export interface CheckinEventRow {
	event_type: "check_in" | "check_out";
	occurred_at: string;
}

export interface BreakBudgetResult {
	usedMinutesToday: number;
	remainingMinutesToday: number;
	overMinutesToday: number;
	isOnBreakNow: boolean;
	// Kein einziges Event heute -> Anwesenheit ist unbekannt (weder
	// "anwesend" noch "in der Pause" kann angenommen werden), betrifft nur
	// die Live-Ansicht des aktuellen Tages, nicht historische Tage.
	hasActivityToday: boolean;
}

export function localDateString(date: Date, timeZone: string): string {
	return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

// Ein check_out während einer bereits laufenden Pause desselben lokalen
// Tages darf deren Startzeit NICHT überschreiben – sonst würde die bis dahin
// angefallene Pausenzeit verworfen (Doppelklick, parallele Requests oder
// gezielt wiederholtes {"status":"on_break"} → Pausenbudget "füllt sich
// wieder auf"). Liegt die offene Pause an einem anderen Tag (vergessener
// Check-in), startet der neue check_out wie bisher eine frische Pause; die
// alte bleibt unberechnet bei ihrem Ursprungstag.
function startsNewBreak(openBreakStart: Date | null, occurredAt: Date, timezone: string): boolean {
	if (!openBreakStart) return true;
	return localDateString(openBreakStart, timezone) !== localDateString(occurredAt, timezone);
}

// events müssen chronologisch aufsteigend sortiert sein (älteste zuerst).
// Eine Pause zählt vollständig zu dem Tag, an dem sie BEGONNEN hat
// (lokales Datum in timezone) – unabhängig davon, wann/ob sie endet.
// Das ist eindeutig (keine Doppel- oder Teilzählung über Tagesgrenzen)
// und verhindert, dass eine vergessene Pause (check_out ohne folgenden
// check_in) den nächsten Tag verfälscht: Sie bleibt beim Ursprungstag,
// der neue Tag startet automatisch wieder "anwesend". Eine offene Pause
// zählt nur dann bis "jetzt" weiter, wenn sie an targetDate begonnen hat
// UND targetDate der heutige Tag ist.
export function computeUsedMinutesForDate(
	events: CheckinEventRow[],
	timezone: string,
	targetDate: string,
): { usedMinutes: number; isOnBreakNow: boolean } {
	let usedMs = 0;
	let openBreakStart: Date | null = null;

	for (const event of events) {
		const occurredAt = new Date(event.occurred_at);
		if (event.event_type === "check_out") {
			if (startsNewBreak(openBreakStart, occurredAt, timezone)) openBreakStart = occurredAt;
		} else if (event.event_type === "check_in" && openBreakStart) {
			if (localDateString(openBreakStart, timezone) === targetDate) {
				usedMs += occurredAt.getTime() - openBreakStart.getTime();
			}
			openBreakStart = null;
		}
	}

	const openBreakStartedOnTarget = openBreakStart !== null && localDateString(openBreakStart, timezone) === targetDate;
	const targetIsToday = targetDate === localDateString(new Date(), timezone);
	const isOnBreakNow = openBreakStartedOnTarget && targetIsToday;
	if (isOnBreakNow && openBreakStart) {
		usedMs += Date.now() - openBreakStart.getTime();
	}

	return { usedMinutes: Math.max(0, Math.round(usedMs / 60000)), isOnBreakNow };
}

// Wie computeUsedMinutesForDate, aber für ALLE Tage in einem Durchgang statt
// die komplette Event-Liste pro Tag erneut zu scannen. Ohne das skaliert der
// Excel-Export quadratisch (Teilnehmer × Tage × Events) und reißt bei
// größeren/länger laufenden Kursen das Cloudflare-Workers-CPU-Zeit-Limit
// (führte zu "exceededCpu"/503). Ergebnis in Millisekunden je Kalendertag,
// identische Rundung wie computeUsedMinutesForDate erfolgt erst beim Lesen.
export function computeUsedMinutesByDate(events: CheckinEventRow[], timezone: string): Map<string, number> {
	const msByDate = new Map<string, number>();
	let openBreakStart: Date | null = null;

	for (const event of events) {
		const occurredAt = new Date(event.occurred_at);
		if (event.event_type === "check_out") {
			if (startsNewBreak(openBreakStart, occurredAt, timezone)) openBreakStart = occurredAt;
		} else if (event.event_type === "check_in" && openBreakStart) {
			const day = localDateString(openBreakStart, timezone);
			msByDate.set(day, (msByDate.get(day) ?? 0) + (occurredAt.getTime() - openBreakStart.getTime()));
			openBreakStart = null;
		}
	}

	// Offene Pause (kein folgender Check-in) zählt nur für den heutigen Tag
	// bis jetzt weiter – identisch zur Logik in computeUsedMinutesForDate.
	if (openBreakStart) {
		const day = localDateString(openBreakStart, timezone);
		if (day === localDateString(new Date(), timezone)) {
			msByDate.set(day, (msByDate.get(day) ?? 0) + (Date.now() - openBreakStart.getTime()));
		}
	}

	return msByDate;
}

export function computeBreakBudgetFromEvents(
	events: CheckinEventRow[],
	dailyBudgetMinutes: number,
	timezone: string,
): BreakBudgetResult {
	const today = localDateString(new Date(), timezone);
	const { usedMinutes, isOnBreakNow } = computeUsedMinutesForDate(events, timezone, today);
	const hasActivityToday = events.some((event) => localDateString(new Date(event.occurred_at), timezone) === today);
	return {
		usedMinutesToday: usedMinutes,
		remainingMinutesToday: Math.max(0, dailyBudgetMinutes - usedMinutes),
		overMinutesToday: Math.max(0, usedMinutes - dailyBudgetMinutes),
		isOnBreakNow,
		hasActivityToday,
	};
}

// Gesamte Pausenzeit über die komplette Event-Historie hinweg, ohne
// Tagesgrenze – für einfache "Gesamtsumme bisher"-Statistiken. timezone wird
// nur benötigt, um doppelte check_outs wie in den Tagesfunktionen zu behandeln.
export function computeTotalBreakMinutes(events: CheckinEventRow[], timezone: string): number {
	let usedMs = 0;
	let openBreakStart: Date | null = null;
	for (const event of events) {
		const occurredAt = new Date(event.occurred_at);
		if (event.event_type === "check_out") {
			if (startsNewBreak(openBreakStart, occurredAt, timezone)) openBreakStart = occurredAt;
		} else if (event.event_type === "check_in" && openBreakStart) {
			usedMs += occurredAt.getTime() - openBreakStart.getTime();
			openBreakStart = null;
		}
	}
	if (openBreakStart) {
		usedMs += Date.now() - openBreakStart.getTime();
	}
	return Math.max(0, Math.round(usedMs / 60000));
}

export function addDaysToDateString(dateStr: string, days: number): string {
	const [year, month, day] = dateStr.split("-").map(Number);
	const date = new Date(Date.UTC(year, month - 1, day));
	date.setUTCDate(date.getUTCDate() + days);
	return date.toISOString().slice(0, 10);
}

// Nur Events der letzten 2 Tage (UTC) sind für den heutigen Live-Status
// relevant (siehe computeUsedMinutesForDate: eine Pause zählt nur zu dem
// Tag, an dem sie begann, und eine offene Pause nur dann bis "jetzt", wenn
// sie heute begann). 2 Tage statt 1 sind eine großzügige, zeitzonenfeste
// Marge (deckt auch extreme UTC-Offsets ab), ohne das Verhalten zu ändern.
// Diese Grenze erlaubt einen indexgestützten Range-Scan über
// idx_checkin_events_*_occurred statt eines vollen Tabellen-Scans der
// kompletten Historie – entscheidend, da diese Abfragen alle 5s von jedem
// offenen Tab aufgerufen werden.
//
// Bewusst KEIN Limit auf "die letzten N Events": Früher wurden nur die
// letzten 20 Events gelesen. Wer genug (auch wirkungslose) Events erzeugte,
// schob damit seine echten Pausen des Tages aus dem Fenster und das
// Pausenbudget war wieder voll. Das Zeitfenster ist manipulationssicher;
// die Eventmenge pro Teilnehmer und Tag begrenzt das Toggle-Throttling
// (siehe routes/checkin.ts).
function recentCutoffIso(): string {
	return new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
}

export async function fetchRecentParticipantEvents(db: D1Database, participantId: number): Promise<CheckinEventRow[]> {
	const { results } = await db
		.prepare(
			`SELECT event_type, occurred_at FROM checkin_events
			 WHERE participant_id = ?1 AND occurred_at >= ?2
			 ORDER BY occurred_at ASC`,
		)
		.bind(participantId, recentCutoffIso())
		.all<CheckinEventRow>();
	return results;
}

// Eine Abfrage für den gesamten Kurs (statt einer Query pro Teilnehmer).
// Für die häufig gepollte Live-Ansicht (aktueller Status/heutiges Budget).
export async function fetchRecentCourseEventsByParticipant(
	db: D1Database,
	courseId: number,
): Promise<Map<number, CheckinEventRow[]>> {
	const { results } = await db
		.prepare(
			`SELECT participant_id, event_type, occurred_at FROM checkin_events
			 WHERE course_id = ?1 AND occurred_at >= ?2
			 ORDER BY participant_id ASC, occurred_at ASC`,
		)
		.bind(courseId, recentCutoffIso())
		.all<CheckinEventRow & { participant_id: number }>();

	return groupByParticipant(results);
}

// Vollständige Event-Historie eines Kurses (kein LIMIT) für seltener
// aufgerufene Auswertungen: Kalender-Tagesdetail und Excel-Export.
export async function fetchAllCourseEventsByParticipant(db: D1Database, courseId: number): Promise<Map<number, CheckinEventRow[]>> {
	const { results } = await db
		.prepare(
			`SELECT participant_id, event_type, occurred_at FROM checkin_events
			 WHERE course_id = ?1
			 ORDER BY participant_id ASC, occurred_at ASC`,
		)
		.bind(courseId)
		.all<CheckinEventRow & { participant_id: number }>();

	return groupByParticipant(results);
}

// Lokale (UTC-genäherte) Kalendertage, an denen im Kurs mindestens ein
// Event aufgezeichnet wurde – als leichte Grundlage für die
// Kalender-Anzeige im Dashboard (Indikator, welche Tage Daten haben).
export async function fetchCourseEventDates(db: D1Database, courseId: number): Promise<string[]> {
	const { results } = await db
		.prepare(`SELECT DISTINCT date(occurred_at) AS d FROM checkin_events WHERE course_id = ?1 ORDER BY d ASC`)
		.bind(courseId)
		.all<{ d: string }>();
	return results.map((row) => row.d);
}

function groupByParticipant(rows: (CheckinEventRow & { participant_id: number })[]): Map<number, CheckinEventRow[]> {
	const eventsByParticipant = new Map<number, CheckinEventRow[]>();
	for (const row of rows) {
		const list = eventsByParticipant.get(row.participant_id) ?? [];
		list.push({ event_type: row.event_type, occurred_at: row.occurred_at });
		eventsByParticipant.set(row.participant_id, list);
	}
	return eventsByParticipant;
}
