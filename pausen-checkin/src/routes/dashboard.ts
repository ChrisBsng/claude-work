import { Router, type IRequest } from "itty-router";
import type { Env } from "../env";
import {
	computeBreakBudgetFromEvents,
	computeUsedMinutesForDate,
	fetchAllCourseEventsByParticipant,
	fetchCourseEventDates,
	fetchRecentCourseEventsByParticipant,
} from "../breakBudget";
import { resolveHeaderImageIds } from "../images";

interface CourseRow {
	id: number;
	name: string;
	start_date: string;
	duration_days: number;
	daily_break_budget_minutes: number;
	timezone: string;
	checkin_code: string;
	is_active: number;
	header_left_image_id: string | null;
	header_right_image_id: string | null;
}

interface ParticipantRow {
	id: number;
	name: string;
}

async function getCourseByDashboardToken(db: D1Database, dashboardToken: string): Promise<CourseRow | null> {
	return db
		.prepare(
			`SELECT id, name, start_date, duration_days, daily_break_budget_minutes, timezone, checkin_code, is_active,
			 header_left_image_id, header_right_image_id
			 FROM courses WHERE dashboard_token = ?1`,
		)
		.bind(dashboardToken)
		.first<CourseRow>();
}

async function serializeCourse(db: D1Database, course: CourseRow) {
	const { leftImageId, rightImageId } = await resolveHeaderImageIds(db, course);
	return {
		name: course.name,
		startDate: course.start_date,
		durationDays: course.duration_days,
		dailyBreakBudgetMinutes: course.daily_break_budget_minutes,
		checkinCode: course.checkin_code,
		isActive: Boolean(course.is_active),
		headerLeftImageId: leftImageId,
		headerRightImageId: rightImageId,
	};
}

export const dashboardRouter = Router({ base: "/api/dashboard" });

dashboardRouter.get("/:dashboardToken", async (request: IRequest, env: Env) => {
	const course = await getCourseByDashboardToken(env.DB, request.params.dashboardToken);
	if (!course) {
		return Response.json({ error: "Dashboard nicht gefunden" }, { status: 404 });
	}

	const { results: participants } = await env.DB.prepare(
		"SELECT id, name FROM participants WHERE course_id = ?1 ORDER BY name COLLATE NOCASE ASC",
	)
		.bind(course.id)
		.all<ParticipantRow>();

	const eventsByParticipant = await fetchRecentCourseEventsByParticipant(env.DB, course.id);

	const participantsWithBudget = participants.map((participant) => {
		const budget = computeBreakBudgetFromEvents(
			eventsByParticipant.get(participant.id) ?? [],
			course.daily_break_budget_minutes,
			course.timezone,
		);
		const status = !budget.hasActivityToday ? "unknown" : budget.isOnBreakNow ? "on_break" : "present";
		return { id: participant.id, name: participant.name, status, ...budget };
	});

	return Response.json({ course: await serializeCourse(env.DB, course), participants: participantsWithBudget });
});

// Welche Kalendertage haben überhaupt aufgezeichnete Check-in/-out-Events?
// Grundlage für die Kalenderanzeige unten im Dashboard.
dashboardRouter.get("/:dashboardToken/days", async (request: IRequest, env: Env) => {
	const course = await getCourseByDashboardToken(env.DB, request.params.dashboardToken);
	if (!course) {
		return Response.json({ error: "Dashboard nicht gefunden" }, { status: 404 });
	}
	const days = await fetchCourseEventDates(env.DB, course.id);
	return Response.json({ days });
});

// Historische Aufschlüsselung für einen einzelnen, vergangenen Kalendertag.
dashboardRouter.get("/:dashboardToken/days/:date", async (request: IRequest, env: Env) => {
	const course = await getCourseByDashboardToken(env.DB, request.params.dashboardToken);
	if (!course) {
		return Response.json({ error: "Dashboard nicht gefunden" }, { status: 404 });
	}

	const date = request.params.date;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
		return Response.json({ error: "Ungültiges Datum" }, { status: 400 });
	}

	const { results: participants } = await env.DB.prepare(
		"SELECT id, name FROM participants WHERE course_id = ?1 ORDER BY name COLLATE NOCASE ASC",
	)
		.bind(course.id)
		.all<{ id: number; name: string }>();

	const eventsByParticipant = await fetchAllCourseEventsByParticipant(env.DB, course.id);

	const participantsWithUsage = participants.map((participant) => {
		const { usedMinutes } = computeUsedMinutesForDate(eventsByParticipant.get(participant.id) ?? [], course.timezone, date);
		return {
			id: participant.id,
			name: participant.name,
			usedMinutes,
			remainingMinutes: Math.max(0, course.daily_break_budget_minutes - usedMinutes),
		};
	});

	return Response.json({
		date,
		course: await serializeCourse(env.DB, course),
		participants: participantsWithUsage,
	});
});
