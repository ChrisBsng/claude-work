export interface CheckinEventRow {
	event_type: "check_in" | "check_out";
	occurred_at: string;
}

export interface BreakBudgetResult {
	usedMinutesToday: number;
	remainingMinutesToday: number;
	isOnBreakNow: boolean;
	// Kein einziges Event heute -> Anwesenheit ist unbekannt (weder
	// "anwesend" noch "in der Pause" kann angenommen werden), betrifft nur
	// die Live-Ansicht des aktuellen Tages, nicht historische Tage.
	hasActivityToday: boolean;
}

export function localDateString(date: Date, timeZone: string): string {
	return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
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
			openBreakStart = occurredAt;
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
		isOnBreakNow,
		hasActivityToday,
	};
}

// Gesamte Pausenzeit über die komplette Event-Historie hinweg, ohne
// Tagesgrenze – für einfache "Gesamtsumme bisher"-Statistiken.
export function computeTotalBreakMinutes(events: CheckinEventRow[]): number {
	let usedMs = 0;
	let openBreakStart: Date | null = null;
	for (const event of events) {
		const occurredAt = new Date(event.occurred_at);
		if (event.event_type === "check_out") {
			openBreakStart = occurredAt;
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

const RECENT_EVENTS_PER_PARTICIPANT = 20;

export async function fetchRecentParticipantEvents(db: D1Database, participantId: number): Promise<CheckinEventRow[]> {
	const { results } = await db
		.prepare(
			`SELECT event_type, occurred_at FROM checkin_events
			 WHERE participant_id = ?1
			 ORDER BY occurred_at DESC
			 LIMIT ?2`,
		)
		.bind(participantId, RECENT_EVENTS_PER_PARTICIPANT)
		.all<CheckinEventRow>();
	return results.reverse();
}

// Eine Abfrage für den gesamten Kurs (statt einer Query pro Teilnehmer),
// gruppiert per Fensterfunktion auf die letzten N Events je Teilnehmer.
// Für die häufig gepollte Live-Ansicht (aktueller Status/heutiges Budget).
export async function fetchRecentCourseEventsByParticipant(
	db: D1Database,
	courseId: number,
): Promise<Map<number, CheckinEventRow[]>> {
	const { results } = await db
		.prepare(
			`SELECT participant_id, event_type, occurred_at FROM (
				SELECT participant_id, event_type, occurred_at,
					ROW_NUMBER() OVER (PARTITION BY participant_id ORDER BY occurred_at DESC) AS rn
				FROM checkin_events
				WHERE course_id = ?1
			) WHERE rn <= ?2
			ORDER BY participant_id ASC, occurred_at ASC`,
		)
		.bind(courseId, RECENT_EVENTS_PER_PARTICIPANT)
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
