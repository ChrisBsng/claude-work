export interface CheckinEventRow {
	event_type: "check_in" | "check_out";
	occurred_at: string;
}

export interface BreakBudgetResult {
	usedMinutesToday: number;
	remainingMinutesToday: number;
	isOnBreakNow: boolean;
}

function localDateString(date: Date, timeZone: string): string {
	return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

// events müssen chronologisch aufsteigend sortiert sein (älteste zuerst).
// Eine laufende Pause (check_out ohne folgenden check_in) zählt bis "jetzt".
export function computeBreakBudgetFromEvents(
	events: CheckinEventRow[],
	dailyBudgetMinutes: number,
	timezone: string,
): BreakBudgetResult {
	const today = localDateString(new Date(), timezone);
	let usedMs = 0;
	let openBreakStart: Date | null = null;

	for (const event of events) {
		const occurredAt = new Date(event.occurred_at);
		if (event.event_type === "check_out") {
			openBreakStart = occurredAt;
		} else if (event.event_type === "check_in" && openBreakStart) {
			const startedToday = localDateString(openBreakStart, timezone) === today;
			const endedToday = localDateString(occurredAt, timezone) === today;
			if (startedToday || endedToday) {
				usedMs += occurredAt.getTime() - openBreakStart.getTime();
			}
			openBreakStart = null;
		}
	}

	const isOnBreakNow = openBreakStart !== null;
	if (isOnBreakNow && openBreakStart) {
		usedMs += Date.now() - openBreakStart.getTime();
	}

	const usedMinutesToday = Math.max(0, Math.round(usedMs / 60000));
	const remainingMinutesToday = Math.max(0, dailyBudgetMinutes - usedMinutesToday);

	return { usedMinutesToday, remainingMinutesToday, isOnBreakNow };
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

	const eventsByParticipant = new Map<number, CheckinEventRow[]>();
	for (const row of results) {
		const list = eventsByParticipant.get(row.participant_id) ?? [];
		list.push({ event_type: row.event_type, occurred_at: row.occurred_at });
		eventsByParticipant.set(row.participant_id, list);
	}
	return eventsByParticipant;
}
