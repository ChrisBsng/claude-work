import { Router, type IRequest } from "itty-router";
import type { Env } from "../env";
import { computeBreakBudgetFromEvents, fetchRecentParticipantEvents, type BreakBudgetResult } from "../breakBudget";
import { randomToken } from "../crypto";
import { renderQrCodeSvg } from "../qrcode";

const PARTICIPANT_TOKEN_BYTES = 20;

interface CourseRow {
	id: number;
	name: string;
	daily_break_budget_minutes: number;
	timezone: string;
	is_active: number;
}

interface ParticipantRow {
	id: number;
	name: string;
	status: "present" | "on_break";
}

async function getActiveCourseByCheckinCode(db: D1Database, checkinCode: string): Promise<CourseRow | null> {
	const course = await db
		.prepare("SELECT id, name, daily_break_budget_minutes, timezone, is_active FROM courses WHERE checkin_code = ?1")
		.bind(checkinCode)
		.first<CourseRow>();
	return course && course.is_active ? course : null;
}

async function getParticipantByToken(db: D1Database, courseId: number, accessToken: string): Promise<ParticipantRow | null> {
	return db
		.prepare("SELECT id, name, status FROM participants WHERE course_id = ?1 AND access_token = ?2")
		.bind(courseId, accessToken)
		.first<ParticipantRow>();
}

// Der tatsächlich angezeigte Status kommt immer frisch aus dem Event-Log
// (tagesbezogen), nicht aus der ggf. seit gestern veralteten Spalte
// participants.status – so ist eine vergessene Pause am nächsten Tag
// automatisch wieder "anwesend" statt hängenzubleiben.
async function loadParticipantView(
	db: D1Database,
	participant: ParticipantRow,
	course: CourseRow,
): Promise<{ participant: ParticipantRow; budget: BreakBudgetResult }> {
	const events = await fetchRecentParticipantEvents(db, participant.id);
	const budget = computeBreakBudgetFromEvents(events, course.daily_break_budget_minutes, course.timezone);
	const status: ParticipantRow["status"] = budget.isOnBreakNow ? "on_break" : "present";
	return { participant: { ...participant, status }, budget };
}

export const checkinRouter = Router({ base: "/api/checkin" });

checkinRouter.get("/:checkinCode", async (request: IRequest, env: Env) => {
	const course = await getActiveCourseByCheckinCode(env.DB, request.params.checkinCode);
	if (!course) {
		return Response.json({ error: "Kurs nicht gefunden" }, { status: 404 });
	}
	return Response.json({ course: { name: course.name, dailyBreakBudgetMinutes: course.daily_break_budget_minutes } });
});

checkinRouter.get("/:checkinCode/qrcode.svg", async (request: IRequest, env: Env) => {
	const course = await getActiveCourseByCheckinCode(env.DB, request.params.checkinCode);
	if (!course) {
		return Response.json({ error: "Kurs nicht gefunden" }, { status: 404 });
	}

	const checkinUrl = new URL(`/k/${request.params.checkinCode}`, request.url).toString();
	const svg = renderQrCodeSvg(checkinUrl);
	return new Response(svg, {
		headers: {
			"Content-Type": "image/svg+xml",
			"Cache-Control": "public, max-age=3600",
		},
	});
});

checkinRouter.post("/:checkinCode/register", async (request: IRequest, env: Env) => {
	const course = await getActiveCourseByCheckinCode(env.DB, request.params.checkinCode);
	if (!course) {
		return Response.json({ error: "Kurs nicht gefunden" }, { status: 404 });
	}

	const body = (await request.json().catch(() => null)) as { name?: string } | null;
	const name = body?.name?.trim();
	if (!name) {
		return Response.json({ error: "Name ist erforderlich" }, { status: 400 });
	}

	const accessToken = randomToken(PARTICIPANT_TOKEN_BYTES);
	const participant = await env.DB.prepare(
		"INSERT INTO participants (course_id, name, access_token) VALUES (?1, ?2, ?3) RETURNING id, name, status",
	)
		.bind(course.id, name, accessToken)
		.first<ParticipantRow>();

	await env.DB.prepare("INSERT INTO checkin_events (participant_id, course_id, event_type) VALUES (?1, ?2, 'check_in')")
		.bind(participant!.id, course.id)
		.run();

	return Response.json({ accessToken, ...(await loadParticipantView(env.DB, participant!, course)) });
});

checkinRouter.get("/:checkinCode/me", async (request: IRequest, env: Env) => {
	const course = await getActiveCourseByCheckinCode(env.DB, request.params.checkinCode);
	if (!course) {
		return Response.json({ error: "Kurs nicht gefunden" }, { status: 404 });
	}

	const accessToken = request.headers.get("X-Access-Token");
	if (!accessToken) {
		return Response.json({ error: "Kein Zugriffs-Token" }, { status: 401 });
	}

	const participant = await getParticipantByToken(env.DB, course.id, accessToken);
	if (!participant) {
		return Response.json({ error: "Teilnehmer nicht gefunden" }, { status: 404 });
	}

	return Response.json(await loadParticipantView(env.DB, participant, course));
});

checkinRouter.post("/:checkinCode/toggle", async (request: IRequest, env: Env) => {
	const course = await getActiveCourseByCheckinCode(env.DB, request.params.checkinCode);
	if (!course) {
		return Response.json({ error: "Kurs nicht gefunden" }, { status: 404 });
	}

	const accessToken = request.headers.get("X-Access-Token");
	if (!accessToken) {
		return Response.json({ error: "Kein Zugriffs-Token" }, { status: 401 });
	}

	const participant = await getParticipantByToken(env.DB, course.id, accessToken);
	if (!participant) {
		return Response.json({ error: "Teilnehmer nicht gefunden" }, { status: 404 });
	}

	// Richtung des Toggles anhand des tagesbezogenen, aus dem Event-Log
	// abgeleiteten Status bestimmen – nicht anhand der möglicherweise
	// seit gestern veralteten participants.status-Spalte.
	const before = await loadParticipantView(env.DB, participant, course);
	const newStatus = before.participant.status === "present" ? "on_break" : "present";
	const eventType = newStatus === "on_break" ? "check_out" : "check_in";

	await env.DB.batch([
		env.DB.prepare("UPDATE participants SET status = ?1, status_changed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?2").bind(
			newStatus,
			participant.id,
		),
		env.DB.prepare("INSERT INTO checkin_events (participant_id, course_id, event_type) VALUES (?1, ?2, ?3)").bind(
			participant.id,
			course.id,
			eventType,
		),
	]);

	return Response.json(await loadParticipantView(env.DB, participant, course));
});
