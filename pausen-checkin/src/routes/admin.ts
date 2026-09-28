import { Router, type IRequest } from "itty-router";
import type { Env } from "../env";
import { createAdminSessionToken, randomToken, verifyAdminSessionToken, verifyPassword } from "../crypto";

const CHECKIN_CODE_BYTES = 6;
const DASHBOARD_TOKEN_BYTES = 20;

interface CourseRow {
	id: number;
	name: string;
	start_date: string;
	duration_days: number;
	daily_break_budget_minutes: number;
	checkin_code: string;
	dashboard_token: string;
	is_active: number;
	created_at: string;
}

function serializeCourse(course: CourseRow) {
	return {
		id: course.id,
		name: course.name,
		startDate: course.start_date,
		durationDays: course.duration_days,
		dailyBreakBudgetMinutes: course.daily_break_budget_minutes,
		checkinCode: course.checkin_code,
		dashboardToken: course.dashboard_token,
		isActive: Boolean(course.is_active),
		createdAt: course.created_at,
	};
}

async function requireAdmin(request: IRequest, env: Env): Promise<Response | void> {
	const authHeader = request.headers.get("Authorization") ?? "";
	const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;
	if (!(await verifyAdminSessionToken(env.ADMIN_PASSWORD, token))) {
		return Response.json({ error: "Nicht autorisiert" }, { status: 401 });
	}
}

export const adminRouter = Router({ base: "/api/admin" });

adminRouter.post("/login", async (request: IRequest, env: Env) => {
	const body = (await request.json().catch(() => null)) as { password?: string } | null;
	if (!body?.password || !(await verifyPassword(env.ADMIN_PASSWORD, body.password))) {
		return Response.json({ error: "Ungültiges Passwort" }, { status: 401 });
	}
	const token = await createAdminSessionToken(env.ADMIN_PASSWORD);
	return Response.json({ token });
});

adminRouter.get("/courses", requireAdmin, async (_request: IRequest, env: Env) => {
	const { results } = await env.DB.prepare(
		`SELECT id, name, start_date, duration_days, daily_break_budget_minutes, checkin_code, dashboard_token, is_active, created_at
		 FROM courses ORDER BY created_at DESC`,
	).all<CourseRow>();
	return Response.json({ courses: results.map(serializeCourse) });
});

adminRouter.post("/courses", requireAdmin, async (request: IRequest, env: Env) => {
	const body = (await request.json().catch(() => null)) as
		| { name?: string; durationDays?: number; dailyBreakBudgetMinutes?: number }
		| null;

	const name = body?.name?.trim();
	const durationDays = Number(body?.durationDays);
	const dailyBreakBudgetMinutes = Number(body?.dailyBreakBudgetMinutes);

	if (
		!name ||
		!Number.isInteger(durationDays) ||
		durationDays <= 0 ||
		!Number.isInteger(dailyBreakBudgetMinutes) ||
		dailyBreakBudgetMinutes <= 0
	) {
		return Response.json(
			{ error: "Name, Laufzeit (Tage) und tägliches Pausenbudget (Minuten) sind erforderlich." },
			{ status: 400 },
		);
	}

	const checkinCode = randomToken(CHECKIN_CODE_BYTES);
	const dashboardToken = randomToken(DASHBOARD_TOKEN_BYTES);

	const course = await env.DB.prepare(
		`INSERT INTO courses (name, duration_days, daily_break_budget_minutes, checkin_code, dashboard_token)
		 VALUES (?1, ?2, ?3, ?4, ?5)
		 RETURNING id, name, start_date, duration_days, daily_break_budget_minutes, checkin_code, dashboard_token, is_active, created_at`,
	)
		.bind(name, durationDays, dailyBreakBudgetMinutes, checkinCode, dashboardToken)
		.first<CourseRow>();

	return Response.json({ course: serializeCourse(course!) }, { status: 201 });
});
