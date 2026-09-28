import { Router, type IRequest } from "itty-router";
import type { Env } from "../env";
import { computeBreakBudgetFromEvents, fetchRecentCourseEventsByParticipant } from "../breakBudget";

interface CourseRow {
	id: number;
	name: string;
	start_date: string;
	duration_days: number;
	daily_break_budget_minutes: number;
	timezone: string;
	checkin_code: string;
	is_active: number;
}

interface ParticipantRow {
	id: number;
	name: string;
	status: "present" | "on_break";
}

export const dashboardRouter = Router({ base: "/api/dashboard" });

dashboardRouter.get("/:dashboardToken", async (request: IRequest, env: Env) => {
	const course = await env.DB.prepare(
		`SELECT id, name, start_date, duration_days, daily_break_budget_minutes, timezone, checkin_code, is_active
		 FROM courses WHERE dashboard_token = ?1`,
	)
		.bind(request.params.dashboardToken)
		.first<CourseRow>();

	if (!course) {
		return Response.json({ error: "Dashboard nicht gefunden" }, { status: 404 });
	}

	const { results: participants } = await env.DB.prepare(
		"SELECT id, name, status FROM participants WHERE course_id = ?1 ORDER BY name COLLATE NOCASE ASC",
	)
		.bind(course.id)
		.all<ParticipantRow>();

	const eventsByParticipant = await fetchRecentCourseEventsByParticipant(env.DB, course.id);

	const participantsWithBudget = participants.map((participant) => ({
		...participant,
		...computeBreakBudgetFromEvents(
			eventsByParticipant.get(participant.id) ?? [],
			course.daily_break_budget_minutes,
			course.timezone,
		),
	}));

	return Response.json({
		course: {
			name: course.name,
			startDate: course.start_date,
			durationDays: course.duration_days,
			dailyBreakBudgetMinutes: course.daily_break_budget_minutes,
			checkinCode: course.checkin_code,
			isActive: Boolean(course.is_active),
		},
		participants: participantsWithBudget,
	});
});
