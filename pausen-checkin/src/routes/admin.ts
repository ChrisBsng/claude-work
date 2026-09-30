import { Router, type IRequest } from "itty-router";
import type { Env } from "../env";
import { type AdminRole, createAdminSessionToken, randomToken, verifyAdminSessionToken, verifyPassword } from "../crypto";
import {
	addDaysToDateString,
	computeBreakBudgetFromEvents,
	computeTotalBreakMinutes,
	computeUsedMinutesForDate,
	fetchAllCourseEventsByParticipant,
	localDateString,
} from "../breakBudget";
import { buildXlsx, type XlsxCell, type XlsxSheet } from "../xlsx";
import { isAllowedImageType, MAX_IMAGE_UPLOAD_BYTES } from "../images";
import { isValidDailyWorklogMinutes, isValidDateString, SCHULSTUNDE_MINUTES } from "../worklog";

const CHECKIN_CODE_BYTES = 6;
const DASHBOARD_TOKEN_BYTES = 20;
const MAX_DURATION_DAYS = 366;

interface CourseRow {
	id: number;
	name: string;
	start_date: string;
	duration_days: number;
	daily_break_budget_minutes: number;
	timezone: string;
	checkin_code: string;
	dashboard_token: string;
	is_active: number;
	created_at: string;
	header_left_image_id: string | null;
	header_right_image_id: string | null;
	has_break_tracking: number;
	has_worklog_tracking: number;
	daily_worklog_minutes: number | null;
	allow_overtime_credit: number;
}

const COURSE_COLUMNS =
	"id, name, start_date, duration_days, daily_break_budget_minutes, timezone, checkin_code, dashboard_token, is_active, created_at, header_left_image_id, header_right_image_id, has_break_tracking, has_worklog_tracking, daily_worklog_minutes, allow_overtime_credit";

async function loadDefaultHeaderLeftImageId(db: D1Database): Promise<string | null> {
	const setting = await db
		.prepare("SELECT value FROM app_settings WHERE key = 'default_header_left_image_id'")
		.first<{ value: string }>();
	return setting?.value ?? null;
}

function serializeCourse(course: CourseRow, defaultHeaderLeftImageId: string | null) {
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
		headerLeftImageId: course.header_left_image_id ?? defaultHeaderLeftImageId,
		headerLeftImageOverrideId: course.header_left_image_id,
		headerRightImageId: course.header_right_image_id,
		hasBreakTracking: Boolean(course.has_break_tracking),
		hasWorklogTracking: Boolean(course.has_worklog_tracking),
		dailyWorklogMinutes: course.daily_worklog_minutes,
		allowOvertimeCredit: Boolean(course.allow_overtime_credit),
	};
}

async function requireRole(request: IRequest, env: Env, allowedRoles: AdminRole[]): Promise<Response | void> {
	const authHeader = request.headers.get("Authorization") ?? "";
	const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;
	const role = await verifyAdminSessionToken({ admin: env.ADMIN_PASSWORD, readonly: env.READONLY_PASSWORD }, token);
	if (!role || !allowedRoles.includes(role)) {
		return Response.json({ error: "Nicht autorisiert" }, { status: 401 });
	}
}

// Volle Rechte (Anlegen/Ändern/Löschen).
const requireAdmin = (request: IRequest, env: Env) => requireRole(request, env, ["admin"]);
// Lesender Zugriff, für Admin UND Read-Only-Rolle.
const requireReadAccess = (request: IRequest, env: Env) => requireRole(request, env, ["admin", "readonly"]);

export const adminRouter = Router({ base: "/api/admin" });

adminRouter.post("/login", async (request: IRequest, env: Env) => {
	const body = (await request.json().catch(() => null)) as { password?: string; role?: string } | null;
	const role: AdminRole = body?.role === "readonly" ? "readonly" : "admin";
	const secret = role === "admin" ? env.ADMIN_PASSWORD : env.READONLY_PASSWORD;
	if (!secret || !body?.password || !(await verifyPassword(secret, body.password))) {
		return Response.json({ error: "Ungültiges Passwort" }, { status: 401 });
	}
	const token = await createAdminSessionToken(secret, role);
	return Response.json({ token, role });
});

adminRouter.get("/courses", requireReadAccess, async (_request: IRequest, env: Env) => {
	const { results } = await env.DB.prepare(`SELECT ${COURSE_COLUMNS} FROM courses ORDER BY created_at DESC`).all<CourseRow>();
	const defaultHeaderLeftImageId = await loadDefaultHeaderLeftImageId(env.DB);
	return Response.json({ courses: results.map((c) => serializeCourse(c, defaultHeaderLeftImageId)) });
});

adminRouter.post("/courses", requireAdmin, async (request: IRequest, env: Env) => {
	const body = (await request.json().catch(() => null)) as
		| {
				name?: string;
				durationDays?: number;
				dailyBreakBudgetMinutes?: number;
				hasBreakTracking?: boolean;
				hasWorklogTracking?: boolean;
				dailyWorklogMinutes?: number;
				allowOvertimeCredit?: boolean;
		  }
		| null;

	const name = body?.name?.trim();
	const durationDays = Number(body?.durationDays);
	const dailyBreakBudgetMinutes = Number(body?.dailyBreakBudgetMinutes);
	const hasBreakTracking = body?.hasBreakTracking ?? true;
	const hasWorklogTracking = body?.hasWorklogTracking ?? false;
	const dailyWorklogMinutes = body?.dailyWorklogMinutes !== undefined ? Number(body.dailyWorklogMinutes) : null;
	const allowOvertimeCredit = body?.allowOvertimeCredit ?? false;

	if (
		!name ||
		!Number.isInteger(durationDays) ||
		durationDays <= 0 ||
		durationDays > MAX_DURATION_DAYS ||
		!Number.isInteger(dailyBreakBudgetMinutes) ||
		dailyBreakBudgetMinutes <= 0
	) {
		return Response.json(
			{
				error: `Name, Laufzeit (1–${MAX_DURATION_DAYS} Tage) und tägliches Pausenbudget (Minuten) sind erforderlich.`,
			},
			{ status: 400 },
		);
	}
	if (hasWorklogTracking && (dailyWorklogMinutes === null || !isValidDailyWorklogMinutes(dailyWorklogMinutes))) {
		return Response.json(
			{ error: `Bei aktivierter Worklogerfassung ist eine tägliche Arbeitszeit (1–12 Schulstunden à ${SCHULSTUNDE_MINUTES} Min.) erforderlich.` },
			{ status: 400 },
		);
	}

	const checkinCode = randomToken(CHECKIN_CODE_BYTES);
	const dashboardToken = randomToken(DASHBOARD_TOKEN_BYTES);

	const course = await env.DB.prepare(
		`INSERT INTO courses (name, duration_days, daily_break_budget_minutes, checkin_code, dashboard_token, has_break_tracking, has_worklog_tracking, daily_worklog_minutes, allow_overtime_credit)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
		 RETURNING ${COURSE_COLUMNS}`,
	)
		.bind(
			name,
			durationDays,
			dailyBreakBudgetMinutes,
			checkinCode,
			dashboardToken,
			hasBreakTracking ? 1 : 0,
			hasWorklogTracking ? 1 : 0,
			hasWorklogTracking ? dailyWorklogMinutes : null,
			allowOvertimeCredit ? 1 : 0,
		)
		.first<CourseRow>();

	const defaultHeaderLeftImageId = await loadDefaultHeaderLeftImageId(env.DB);
	return Response.json({ course: serializeCourse(course!, defaultHeaderLeftImageId) }, { status: 201 });
});

// Allgemeine Kurseinstellungen bearbeiten (nicht die Header-Logos, dafür
// gibt es den eigenen /header-Endpunkt). Alle Felder optional/partiell.
adminRouter.patch("/courses/:id", requireAdmin, async (request: IRequest, env: Env) => {
	const course = await loadCourseOr404(env.DB, Number(request.params.id));
	if (!course) {
		return Response.json({ error: "Kurs nicht gefunden" }, { status: 404 });
	}

	const body = (await request.json().catch(() => null)) as
		| {
				name?: string;
				durationDays?: number;
				dailyBreakBudgetMinutes?: number;
				hasBreakTracking?: boolean;
				hasWorklogTracking?: boolean;
				dailyWorklogMinutes?: number;
				allowOvertimeCredit?: boolean;
		  }
		| null;
	if (!body) {
		return Response.json({ error: "Ungültige Anfrage" }, { status: 400 });
	}

	const name = body.name !== undefined ? body.name.trim() : course.name;
	const durationDays = body.durationDays !== undefined ? Number(body.durationDays) : course.duration_days;
	const dailyBreakBudgetMinutes =
		body.dailyBreakBudgetMinutes !== undefined ? Number(body.dailyBreakBudgetMinutes) : course.daily_break_budget_minutes;
	const hasBreakTracking = body.hasBreakTracking !== undefined ? body.hasBreakTracking : Boolean(course.has_break_tracking);
	const hasWorklogTracking = body.hasWorklogTracking !== undefined ? body.hasWorklogTracking : Boolean(course.has_worklog_tracking);
	const dailyWorklogMinutes =
		body.dailyWorklogMinutes !== undefined ? Number(body.dailyWorklogMinutes) : course.daily_worklog_minutes;
	const allowOvertimeCredit =
		body.allowOvertimeCredit !== undefined ? body.allowOvertimeCredit : Boolean(course.allow_overtime_credit);

	if (!name || !Number.isInteger(durationDays) || durationDays <= 0 || durationDays > MAX_DURATION_DAYS) {
		return Response.json({ error: `Name und Laufzeit (1–${MAX_DURATION_DAYS} Tage) sind erforderlich.` }, { status: 400 });
	}
	if (!Number.isInteger(dailyBreakBudgetMinutes) || dailyBreakBudgetMinutes <= 0) {
		return Response.json({ error: "Tägliches Pausenbudget muss eine positive Zahl sein." }, { status: 400 });
	}
	if (hasWorklogTracking && (dailyWorklogMinutes === null || !isValidDailyWorklogMinutes(dailyWorklogMinutes))) {
		return Response.json(
			{ error: `Bei aktivierter Worklogerfassung ist eine tägliche Arbeitszeit (1–12 Schulstunden à ${SCHULSTUNDE_MINUTES} Min.) erforderlich.` },
			{ status: 400 },
		);
	}

	const updated = await env.DB.prepare(
		`UPDATE courses SET name = ?1, duration_days = ?2, daily_break_budget_minutes = ?3, has_break_tracking = ?4, has_worklog_tracking = ?5, daily_worklog_minutes = ?6, allow_overtime_credit = ?7
		 WHERE id = ?8 RETURNING ${COURSE_COLUMNS}`,
	)
		.bind(
			name,
			durationDays,
			dailyBreakBudgetMinutes,
			hasBreakTracking ? 1 : 0,
			hasWorklogTracking ? 1 : 0,
			hasWorklogTracking ? dailyWorklogMinutes : null,
			allowOvertimeCredit ? 1 : 0,
			course.id,
		)
		.first<CourseRow>();

	const defaultHeaderLeftImageId = await loadDefaultHeaderLeftImageId(env.DB);
	return Response.json({ course: serializeCourse(updated!, defaultHeaderLeftImageId) });
});

// Header-Logos eines einzelnen Kurses setzen/zurücksetzen. null bei left
// bedeutet "globalen Standard verwenden", null bei right "kein Bild".
adminRouter.patch("/courses/:id/header", requireAdmin, async (request: IRequest, env: Env) => {
	const course = await loadCourseOr404(env.DB, Number(request.params.id));
	if (!course) {
		return Response.json({ error: "Kurs nicht gefunden" }, { status: 404 });
	}

	const body = (await request.json().catch(() => null)) as
		| { headerLeftImageId?: string | null; headerRightImageId?: string | null }
		| null;
	if (!body) {
		return Response.json({ error: "Ungültige Anfrage" }, { status: 400 });
	}

	for (const imageId of [body.headerLeftImageId, body.headerRightImageId]) {
		if (imageId) {
			const exists = await env.DB.prepare("SELECT 1 FROM images WHERE id = ?1").bind(imageId).first();
			if (!exists) {
				return Response.json({ error: `Bild ${imageId} nicht gefunden` }, { status: 404 });
			}
		}
	}

	// Feld weggelassen -> unverändert lassen; Feld als null/"" gesendet ->
	// explizit zurücksetzen (links: globaler Standard, rechts: kein Bild).
	const newLeft = "headerLeftImageId" in body ? (body.headerLeftImageId || null) : course.header_left_image_id;
	const newRight = "headerRightImageId" in body ? (body.headerRightImageId || null) : course.header_right_image_id;

	const updated = await env.DB.prepare(`UPDATE courses SET header_left_image_id = ?1, header_right_image_id = ?2 WHERE id = ?3 RETURNING ${COURSE_COLUMNS}`)
		.bind(newLeft, newRight, course.id)
		.first<CourseRow>();

	const defaultHeaderLeftImageId = await loadDefaultHeaderLeftImageId(env.DB);
	return Response.json({ course: serializeCourse(updated!, defaultHeaderLeftImageId) });
});

// Endgültiges Löschen: explizite Kaskade statt Verlass auf D1s
// FOREIGN KEY-ON-DELETE-Verhalten (SQLite erzwingt Fremdschlüssel nur mit
// aktivem PRAGMA foreign_keys, worauf wir uns hier bewusst nicht verlassen).
adminRouter.post("/courses/bulk-delete", requireAdmin, async (request: IRequest, env: Env) => {
	const body = (await request.json().catch(() => null)) as { ids?: unknown } | null;
	const ids = Array.isArray(body?.ids) ? body!.ids.filter((id): id is number => Number.isInteger(id)) : [];

	if (ids.length === 0) {
		return Response.json({ error: "Keine Kurs-IDs angegeben." }, { status: 400 });
	}

	const placeholders = ids.map((_, i) => `?${i + 1}`).join(",");
	await env.DB.batch([
		env.DB.prepare(`DELETE FROM checkin_events WHERE course_id IN (${placeholders})`).bind(...ids),
		env.DB.prepare(`DELETE FROM participants WHERE course_id IN (${placeholders})`).bind(...ids),
		env.DB.prepare(`DELETE FROM courses WHERE id IN (${placeholders})`).bind(...ids),
	]);

	return Response.json({ deletedIds: ids });
});

async function loadCourseOr404(db: D1Database, id: number): Promise<CourseRow | null> {
	if (!Number.isInteger(id)) return null;
	return db
		.prepare(`SELECT ${COURSE_COLUMNS} FROM courses WHERE id = ?1`)
		.bind(id)
		.first<CourseRow>();
}

adminRouter.get("/courses/:id/stats", requireReadAccess, async (request: IRequest, env: Env) => {
	const course = await loadCourseOr404(env.DB, Number(request.params.id));
	if (!course) {
		return Response.json({ error: "Kurs nicht gefunden" }, { status: 404 });
	}

	const { results: participants } = await env.DB.prepare("SELECT id FROM participants WHERE course_id = ?1")
		.bind(course.id)
		.all<{ id: number }>();

	const eventsByParticipant = await fetchAllCourseEventsByParticipant(env.DB, course.id);
	const totalBreakMinutes = participants.reduce(
		(sum, p) => sum + computeTotalBreakMinutes(eventsByParticipant.get(p.id) ?? []),
		0,
	);

	return Response.json({ participantCount: participants.length, totalBreakMinutes });
});

adminRouter.get("/courses/:id/export.xlsx", requireReadAccess, async (request: IRequest, env: Env) => {
	const course = await loadCourseOr404(env.DB, Number(request.params.id));
	if (!course) {
		return Response.json({ error: "Kurs nicht gefunden" }, { status: 404 });
	}

	const { results: participants } = await env.DB.prepare(
		"SELECT id, name, created_at FROM participants WHERE course_id = ?1 ORDER BY name COLLATE NOCASE ASC",
	)
		.bind(course.id)
		.all<{ id: number; name: string; created_at: string }>();

	const eventsByParticipant = await fetchAllCourseEventsByParticipant(env.DB, course.id);

	const participantsSheet: XlsxSheet = {
		name: "Teilnehmer",
		rows: [
			["Name", "Status (aktuell)", "Angemeldet seit"],
			...participants.map((p) => {
				const budget = computeBreakBudgetFromEvents(
					eventsByParticipant.get(p.id) ?? [],
					course.daily_break_budget_minutes,
					course.timezone,
				);
				return [p.name, budget.isOnBreakNow ? "In der Pause" : "Anwesend", p.created_at];
			}),
		],
	};

	const todayLocal = localDateString(new Date(), course.timezone);
	const nominalEnd = addDaysToDateString(course.start_date, course.duration_days - 1);
	const rangeEnd = nominalEnd < todayLocal ? nominalEnd : todayLocal;

	const dates: string[] = [];
	for (let cursor = course.start_date; cursor <= rangeEnd && dates.length <= MAX_DURATION_DAYS; cursor = addDaysToDateString(cursor, 1)) {
		dates.push(cursor);
	}

	const breakRows: XlsxCell[][] = [];
	for (const participant of participants) {
		const events = eventsByParticipant.get(participant.id) ?? [];
		for (const date of dates) {
			const { usedMinutes } = computeUsedMinutesForDate(events, course.timezone, date);
			breakRows.push([
				participant.name,
				date,
				usedMinutes,
				course.daily_break_budget_minutes,
				Math.max(0, course.daily_break_budget_minutes - usedMinutes),
				Math.max(0, usedMinutes - course.daily_break_budget_minutes),
			]);
		}
	}

	const breakSheet: XlsxSheet = {
		name: "Pausenzeiten",
		rows: [
			["Name", "Datum", "Pausenzeit (Min)", "Tagesbudget (Min)", "Verbleibend (Min)", "Überschreitung (Min)"],
			...breakRows,
		],
	};

	const eventRows: XlsxCell[][] = [];
	for (const participant of participants) {
		for (const event of eventsByParticipant.get(participant.id) ?? []) {
			eventRows.push([participant.name, event.event_type === "check_in" ? "Check-in" : "Check-out", event.occurred_at]);
		}
	}

	const eventsSheet: XlsxSheet = {
		name: "Ereignisse",
		rows: [["Name", "Ereignis", "Zeitpunkt"], ...eventRows],
	};

	const sheets: XlsxSheet[] = [participantsSheet, breakSheet, eventsSheet];

	if (course.has_worklog_tracking && course.daily_worklog_minutes) {
		const report = await buildWorklogReport(env.DB, course);

		const worklogOverviewRows: XlsxCell[][] = report.participants.map((p) => [
			p.name,
			p.groupName ?? "Ohne Gruppe",
			p.totalMinutes,
			p.expectedMinutes,
			p.completenessPercent ?? 0,
		]);
		sheets.push({
			name: "Worklog-Übersicht",
			rows: [["Name", "Gruppe", "Erfasst (Min)", "Erwartet bisher (Min)", "Vollständigkeit (%)"], ...worklogOverviewRows],
		});

		const worklogGroupRows: XlsxCell[][] = report.groups.map((g) => [
			g.groupName,
			g.memberCount,
			g.totalMinutes,
			g.expectedMinutes,
			g.completenessPercent ?? 0,
		]);
		sheets.push({
			name: "Worklog nach Gruppe",
			rows: [["Gruppe", "Mitglieder", "Erfasst (Min)", "Erwartet bisher (Min)", "Vollständigkeit (%)"], ...worklogGroupRows],
		});

		const { results: worklogEntries } = await env.DB.prepare(
			`SELECT p.name AS participant_name, g.name AS group_name, w.date, w.task, w.minutes
			 FROM worklog_entries w
			 JOIN participants p ON p.id = w.participant_id
			 LEFT JOIN groups g ON g.id = p.group_id
			 WHERE w.course_id = ?1
			 ORDER BY w.date ASC, p.name COLLATE NOCASE ASC, w.created_at ASC`,
		)
			.bind(course.id)
			.all<{ participant_name: string; group_name: string | null; date: string; task: string; minutes: number }>();

		sheets.push({
			name: "Worklog-Einträge",
			rows: [
				["Datum", "Name", "Gruppe", "Task", "Minuten"],
				...worklogEntries.map((e) => [e.date, e.participant_name, e.group_name ?? "Ohne Gruppe", e.task, e.minutes]),
			],
		});
	}

	const xlsxBytes = buildXlsx(sheets);
	const safeFileName = course.name.replace(/[^\p{L}\p{N}\- ]+/gu, "").trim().replace(/\s+/g, "-") || `kurs-${course.id}`;

	return new Response(xlsxBytes, {
		headers: {
			"Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			"Content-Disposition": `attachment; filename="${safeFileName}.xlsx"`,
		},
	});
});

// --- Gruppen ---

interface GroupRow {
	id: number;
	course_id: number;
	name: string;
	created_at: string;
}

adminRouter.get("/courses/:id/groups", requireReadAccess, async (request: IRequest, env: Env) => {
	const course = await loadCourseOr404(env.DB, Number(request.params.id));
	if (!course) {
		return Response.json({ error: "Kurs nicht gefunden" }, { status: 404 });
	}

	const { results: groups } = await env.DB.prepare(
		"SELECT id, name, created_at FROM groups WHERE course_id = ?1 ORDER BY name COLLATE NOCASE ASC",
	)
		.bind(course.id)
		.all<{ id: number; name: string; created_at: string }>();

	const { results: counts } = await env.DB.prepare(
		"SELECT group_id, COUNT(*) AS count FROM participants WHERE course_id = ?1 AND group_id IS NOT NULL GROUP BY group_id",
	)
		.bind(course.id)
		.all<{ group_id: number; count: number }>();
	const countByGroup = new Map(counts.map((c) => [c.group_id, c.count]));

	return Response.json({
		groups: groups.map((g) => ({ id: g.id, name: g.name, createdAt: g.created_at, memberCount: countByGroup.get(g.id) ?? 0 })),
	});
});

adminRouter.post("/courses/:id/groups", requireAdmin, async (request: IRequest, env: Env) => {
	const course = await loadCourseOr404(env.DB, Number(request.params.id));
	if (!course) {
		return Response.json({ error: "Kurs nicht gefunden" }, { status: 404 });
	}

	const body = (await request.json().catch(() => null)) as { name?: string } | null;
	const name = body?.name?.trim();
	if (!name) {
		return Response.json({ error: "Gruppenname ist erforderlich." }, { status: 400 });
	}

	let group: GroupRow | null;
	try {
		group = await env.DB.prepare("INSERT INTO groups (course_id, name) VALUES (?1, ?2) RETURNING *")
			.bind(course.id, name)
			.first<GroupRow>();
	} catch {
		return Response.json({ error: "Eine Gruppe mit diesem Namen existiert in diesem Kurs bereits." }, { status: 409 });
	}

	return Response.json({ group: { id: group!.id, name: group!.name, createdAt: group!.created_at, memberCount: 0 } }, { status: 201 });
});

adminRouter.patch("/groups/:groupId", requireAdmin, async (request: IRequest, env: Env) => {
	const groupId = Number(request.params.groupId);
	const body = (await request.json().catch(() => null)) as { name?: string } | null;
	const name = body?.name?.trim();
	if (!name) {
		return Response.json({ error: "Gruppenname ist erforderlich." }, { status: 400 });
	}

	let group: GroupRow | null;
	try {
		group = await env.DB.prepare("UPDATE groups SET name = ?1 WHERE id = ?2 RETURNING *").bind(name, groupId).first<GroupRow>();
	} catch {
		return Response.json({ error: "Eine Gruppe mit diesem Namen existiert in diesem Kurs bereits." }, { status: 409 });
	}
	if (!group) {
		return Response.json({ error: "Gruppe nicht gefunden" }, { status: 404 });
	}

	return Response.json({ group: { id: group.id, name: group.name, createdAt: group.created_at } });
});

adminRouter.delete("/groups/:groupId", requireAdmin, async (request: IRequest, env: Env) => {
	const groupId = Number(request.params.groupId);

	const { count } = (await env.DB.prepare("SELECT COUNT(*) AS count FROM participants WHERE group_id = ?1")
		.bind(groupId)
		.first<{ count: number }>())!;
	if (count > 0) {
		return Response.json(
			{
				error: `Gruppe kann nicht gelöscht werden: ${count} Teilnehmer ${count === 1 ? "ist" : "sind"} ihr noch zugeordnet. Bitte zuerst umgruppieren.`,
			},
			{ status: 409 },
		);
	}

	const deleted = await env.DB.prepare("DELETE FROM groups WHERE id = ?1 RETURNING id").bind(groupId).first<{ id: number }>();
	if (!deleted) {
		return Response.json({ error: "Gruppe nicht gefunden" }, { status: 404 });
	}
	return Response.json({ deletedId: deleted.id });
});

// --- Teilnehmer (Admin-Verwaltung) ---

interface ParticipantAdminRow {
	id: number;
	name: string;
	group_id: number | null;
	group_name: string | null;
	created_at: string;
}

adminRouter.get("/courses/:id/participants", requireReadAccess, async (request: IRequest, env: Env) => {
	const course = await loadCourseOr404(env.DB, Number(request.params.id));
	if (!course) {
		return Response.json({ error: "Kurs nicht gefunden" }, { status: 404 });
	}

	const { results } = await env.DB.prepare(
		`SELECT p.id, p.name, p.group_id, g.name AS group_name, p.created_at
		 FROM participants p LEFT JOIN groups g ON g.id = p.group_id
		 WHERE p.course_id = ?1 ORDER BY p.name COLLATE NOCASE ASC`,
	)
		.bind(course.id)
		.all<ParticipantAdminRow>();

	return Response.json({
		participants: results.map((p) => ({
			id: p.id,
			name: p.name,
			groupId: p.group_id,
			groupName: p.group_name,
			createdAt: p.created_at,
		})),
	});
});

adminRouter.patch("/participants/:id", requireAdmin, async (request: IRequest, env: Env) => {
	const participantId = Number(request.params.id);
	const existing = await env.DB.prepare("SELECT id, course_id, name FROM participants WHERE id = ?1")
		.bind(participantId)
		.first<{ id: number; course_id: number; name: string }>();
	if (!existing) {
		return Response.json({ error: "Teilnehmer nicht gefunden" }, { status: 404 });
	}

	const body = (await request.json().catch(() => null)) as { name?: string; groupId?: number | null } | null;
	if (!body) {
		return Response.json({ error: "Ungültige Anfrage" }, { status: 400 });
	}

	const name = body.name !== undefined ? body.name.trim() : existing.name;
	if (!name) {
		return Response.json({ error: "Name darf nicht leer sein." }, { status: 400 });
	}

	let groupId: number | null | undefined = undefined;
	if (body.groupId !== undefined) {
		groupId = body.groupId;
		if (groupId !== null) {
			const group = await env.DB.prepare("SELECT id FROM groups WHERE id = ?1 AND course_id = ?2")
				.bind(groupId, existing.course_id)
				.first();
			if (!group) {
				return Response.json({ error: "Gruppe nicht gefunden" }, { status: 404 });
			}
		}
	}

	let updated;
	try {
		updated = await env.DB.prepare(
			groupId === undefined
				? "UPDATE participants SET name = ?1 WHERE id = ?2 RETURNING id, name, group_id"
				: "UPDATE participants SET name = ?1, group_id = ?2 WHERE id = ?3 RETURNING id, name, group_id",
		)
			.bind(...(groupId === undefined ? [name, participantId] : [name, groupId, participantId]))
			.first<{ id: number; name: string; group_id: number | null }>();
	} catch {
		return Response.json({ error: "Dieser Name wird im Kurs bereits verwendet." }, { status: 409 });
	}

	return Response.json({ participant: { id: updated!.id, name: updated!.name, groupId: updated!.group_id } });
});

// Setzt das Passwort zurück UND rotiert den Geräte-Token: die Person
// wird dadurch auf allen Geräten "ausgeloggt" (die alte access_token wird
// ungültig) und muss sich beim nächsten Aufruf mit einem neuen Passwort
// neu anmelden.
adminRouter.post("/participants/:id/reset-password", requireAdmin, async (request: IRequest, env: Env) => {
	const participantId = Number(request.params.id);
	const newAccessToken = randomToken(20);
	const updated = await env.DB.prepare(
		"UPDATE participants SET password_hash = NULL, access_token = ?1 WHERE id = ?2 RETURNING id",
	)
		.bind(newAccessToken, participantId)
		.first<{ id: number }>();

	if (!updated) {
		return Response.json({ error: "Teilnehmer nicht gefunden" }, { status: 404 });
	}

	return Response.json({ ok: true });
});

// Löscht den Teilnehmer vollständig, inkl. seiner Check-in-Events und
// Worklog-Einträge (ON DELETE CASCADE in den Migrationen).
adminRouter.delete("/participants/:id", requireAdmin, async (request: IRequest, env: Env) => {
	const participantId = Number(request.params.id);
	const deleted = await env.DB.prepare("DELETE FROM participants WHERE id = ?1 RETURNING id").bind(participantId).first<{ id: number }>();
	if (!deleted) {
		return Response.json({ error: "Teilnehmer nicht gefunden" }, { status: 404 });
	}
	return Response.json({ deletedId: deleted.id });
});

// --- Projekttage & Worklog ---

adminRouter.get("/courses/:id/project-days", requireReadAccess, async (request: IRequest, env: Env) => {
	const course = await loadCourseOr404(env.DB, Number(request.params.id));
	if (!course) {
		return Response.json({ error: "Kurs nicht gefunden" }, { status: 404 });
	}
	const { results } = await env.DB.prepare("SELECT date FROM project_days WHERE course_id = ?1 ORDER BY date ASC")
		.bind(course.id)
		.all<{ date: string }>();
	return Response.json({ dates: results.map((r) => r.date) });
});

// Ersetzt die komplette Auswahl (Löschen + Neueinfügen) statt inkrementell
// hinzuzufügen/zu entfernen – passend zu einer Kalender-Mehrfachauswahl,
// die als Ganzes gespeichert wird.
adminRouter.put("/courses/:id/project-days", requireAdmin, async (request: IRequest, env: Env) => {
	const course = await loadCourseOr404(env.DB, Number(request.params.id));
	if (!course) {
		return Response.json({ error: "Kurs nicht gefunden" }, { status: 404 });
	}

	const body = (await request.json().catch(() => null)) as { dates?: unknown } | null;
	const dates = Array.isArray(body?.dates)
		? [...new Set(body!.dates.filter((d): d is string => typeof d === "string" && isValidDateString(d)))]
		: null;
	if (!dates) {
		return Response.json({ error: "dates (Array von YYYY-MM-DD) ist erforderlich." }, { status: 400 });
	}

	const statements = [env.DB.prepare("DELETE FROM project_days WHERE course_id = ?1").bind(course.id)];
	for (const date of dates) {
		statements.push(env.DB.prepare("INSERT INTO project_days (course_id, date) VALUES (?1, ?2)").bind(course.id, date));
	}
	await env.DB.batch(statements);

	return Response.json({ dates: dates.sort() });
});

async function buildWorklogReport(db: D1Database, course: CourseRow) {
	const target = course.daily_worklog_minutes!;

	const { results: projectDayRows } = await db.prepare("SELECT date FROM project_days WHERE course_id = ?1 ORDER BY date ASC")
		.bind(course.id)
		.all<{ date: string }>();
	const todayLocal = localDateString(new Date(), course.timezone);
	const pastProjectDays = projectDayRows.map((r) => r.date).filter((date) => date <= todayLocal);

	const { results: participants } = await db.prepare(
		`SELECT p.id, p.name, p.group_id, g.name AS group_name
		 FROM participants p LEFT JOIN groups g ON g.id = p.group_id
		 WHERE p.course_id = ?1 ORDER BY p.name COLLATE NOCASE ASC`,
	)
		.bind(course.id)
		.all<{ id: number; name: string; group_id: number | null; group_name: string | null }>();

	const { results: entries } = await db.prepare("SELECT participant_id, date, minutes FROM worklog_entries WHERE course_id = ?1")
		.bind(course.id)
		.all<{ participant_id: number; date: string; minutes: number }>();

	const minutesByParticipantDate = new Map<string, number>();
	for (const entry of entries) {
		const key = `${entry.participant_id}|${entry.date}`;
		minutesByParticipantDate.set(key, (minutesByParticipantDate.get(key) ?? 0) + entry.minutes);
	}

	const percentOf = (logged: number, expected: number) => (expected > 0 ? Math.round((logged / expected) * 1000) / 10 : null);
	const allowOvertime = Boolean(course.allow_overtime_credit);

	const participantReports = participants.map((p) => {
		const days = pastProjectDays.map((date) => {
			const minutes = minutesByParticipantDate.get(`${p.id}|${date}`) ?? 0;
			return { date, minutes, isComplete: minutes >= target };
		});
		// Ohne aktivierte Mehrarbeits-Anrechnung zählen Minuten über dem Tagesziel
		// nicht zur Gesamtzeit (sie "verfallen"); die Tagesansicht zeigt weiterhin
		// die tatsächlich erfasste Zeit.
		const totalMinutes = days.reduce((sum, d) => sum + (allowOvertime ? d.minutes : Math.min(d.minutes, target)), 0);
		const completeDays = days.filter((d) => d.isComplete).length;
		const expectedMinutes = days.length * target;
		return {
			id: p.id,
			name: p.name,
			groupId: p.group_id,
			groupName: p.group_name,
			totalMinutes,
			expectedMinutes,
			completenessPercent: percentOf(totalMinutes, expectedMinutes),
			completeDays,
			totalDays: days.length,
			days,
		};
	});

	const groupMap = new Map<
		string,
		{
			groupId: number | null;
			groupName: string;
			totalMinutes: number;
			expectedMinutes: number;
			memberCount: number;
			completeDays: number;
			totalDays: number;
		}
	>();
	for (const p of participantReports) {
		const key = p.groupId === null ? "none" : String(p.groupId);
		const existing = groupMap.get(key) ?? {
			groupId: p.groupId,
			groupName: p.groupName ?? "Ohne Gruppe",
			totalMinutes: 0,
			expectedMinutes: 0,
			memberCount: 0,
			completeDays: 0,
			totalDays: 0,
		};
		existing.totalMinutes += p.totalMinutes;
		existing.expectedMinutes += p.expectedMinutes;
		existing.memberCount += 1;
		existing.completeDays += p.completeDays;
		existing.totalDays += p.totalDays;
		groupMap.set(key, existing);
	}

	const totalPossibleDays = participants.length * pastProjectDays.length;
	const totalCompleteDays = participantReports.reduce((sum, p) => sum + p.completeDays, 0);
	const totalExpectedMinutes = totalPossibleDays * target;
	const totalLoggedMinutes = participantReports.reduce((sum, p) => sum + p.totalMinutes, 0);

	return {
		course: {
			dailyWorklogMinutes: target,
			projectDaysCount: projectDayRows.length,
			pastProjectDaysCount: pastProjectDays.length,
		},
		summary: {
			totalExpectedMinutes,
			totalLoggedMinutes,
			totalCompleteDays,
			totalPossibleDays,
			completenessPercent: percentOf(totalLoggedMinutes, totalExpectedMinutes),
		},
		groups: [...groupMap.values()]
			.map((g) => ({ ...g, completenessPercent: percentOf(g.totalMinutes, g.expectedMinutes) }))
			.sort((a, b) => a.groupName.localeCompare(b.groupName, "de")),
		participants: participantReports,
	};
}

adminRouter.get("/courses/:id/worklog-report", requireReadAccess, async (request: IRequest, env: Env) => {
	const course = await loadCourseOr404(env.DB, Number(request.params.id));
	if (!course) {
		return Response.json({ error: "Kurs nicht gefunden" }, { status: 404 });
	}
	if (!course.has_worklog_tracking || !course.daily_worklog_minutes) {
		return Response.json({ error: "Worklogerfassung ist für diesen Kurs nicht aktiviert." }, { status: 400 });
	}

	return Response.json(await buildWorklogReport(env.DB, course));
});

// --- Bild-Repository (Header-Logos, gespeichert in R2) ---

interface ImageRow {
	id: string;
	original_filename: string;
	content_type: string;
	size_bytes: number;
	uploaded_at: string;
}

function serializeImage(image: ImageRow) {
	return {
		id: image.id,
		filename: image.original_filename,
		contentType: image.content_type,
		sizeBytes: image.size_bytes,
		uploadedAt: image.uploaded_at,
		url: `/api/images/${image.id}`,
	};
}

adminRouter.get("/images", requireReadAccess, async (_request: IRequest, env: Env) => {
	const { results } = await env.DB.prepare("SELECT * FROM images ORDER BY uploaded_at DESC").all<ImageRow>();
	const defaultHeaderLeftImageId = await loadDefaultHeaderLeftImageId(env.DB);
	return Response.json({ images: results.map(serializeImage), defaultHeaderLeftImageId });
});

adminRouter.post("/images", requireAdmin, async (request: IRequest, env: Env) => {
	const contentType = request.headers.get("Content-Type") ?? "";
	if (!isAllowedImageType(contentType)) {
		return Response.json({ error: "Nicht unterstützter Bildtyp. Erlaubt: PNG, JPEG, WebP, GIF, SVG." }, { status: 400 });
	}

	const body = await request.arrayBuffer();
	if (body.byteLength === 0) {
		return Response.json({ error: "Leere Datei" }, { status: 400 });
	}
	if (body.byteLength > MAX_IMAGE_UPLOAD_BYTES) {
		return Response.json(
			{ error: `Datei zu groß (max. ${Math.round(MAX_IMAGE_UPLOAD_BYTES / 1024 / 1024)} MB).` },
			{ status: 400 },
		);
	}

	const filenameHeader = request.headers.get("X-Filename");
	const filename = filenameHeader ? decodeURIComponent(filenameHeader) : "bild";

	const id = randomToken(16);
	await env.IMAGES.put(id, body, { httpMetadata: { contentType } });

	const image = await env.DB.prepare(
		"INSERT INTO images (id, original_filename, content_type, size_bytes) VALUES (?1, ?2, ?3, ?4) RETURNING *",
	)
		.bind(id, filename, contentType, body.byteLength)
		.first<ImageRow>();

	return Response.json({ image: serializeImage(image!) }, { status: 201 });
});

adminRouter.delete("/images/:id", requireAdmin, async (request: IRequest, env: Env) => {
	const id = request.params.id;
	await env.IMAGES.delete(id);
	await env.DB.batch([
		env.DB.prepare("UPDATE courses SET header_left_image_id = NULL WHERE header_left_image_id = ?1").bind(id),
		env.DB.prepare("UPDATE courses SET header_right_image_id = NULL WHERE header_right_image_id = ?1").bind(id),
		env.DB.prepare("DELETE FROM app_settings WHERE key = 'default_header_left_image_id' AND value = ?1").bind(id),
		env.DB.prepare("DELETE FROM images WHERE id = ?1").bind(id),
	]);
	return Response.json({ deletedId: id });
});

adminRouter.put("/settings/default-header-left", requireAdmin, async (request: IRequest, env: Env) => {
	const body = (await request.json().catch(() => null)) as { imageId?: string | null } | null;
	const imageId = body?.imageId || null;

	if (imageId) {
		const exists = await env.DB.prepare("SELECT 1 FROM images WHERE id = ?1").bind(imageId).first();
		if (!exists) {
			return Response.json({ error: "Bild nicht gefunden" }, { status: 404 });
		}
		await env.DB.prepare(
			`INSERT INTO app_settings (key, value) VALUES ('default_header_left_image_id', ?1)
			 ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
		)
			.bind(imageId)
			.run();
	} else {
		await env.DB.prepare("DELETE FROM app_settings WHERE key = 'default_header_left_image_id'").run();
	}

	return Response.json({ defaultHeaderLeftImageId: imageId });
});
