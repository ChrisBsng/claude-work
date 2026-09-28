import { Router, type IRequest } from "itty-router";
import type { Env } from "../env";
import { createAdminSessionToken, randomToken, verifyAdminSessionToken, verifyPassword } from "../crypto";
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
}

const COURSE_COLUMNS =
	"id, name, start_date, duration_days, daily_break_budget_minutes, timezone, checkin_code, dashboard_token, is_active, created_at, header_left_image_id, header_right_image_id";

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
	const { results } = await env.DB.prepare(`SELECT ${COURSE_COLUMNS} FROM courses ORDER BY created_at DESC`).all<CourseRow>();
	const defaultHeaderLeftImageId = await loadDefaultHeaderLeftImageId(env.DB);
	return Response.json({ courses: results.map((c) => serializeCourse(c, defaultHeaderLeftImageId)) });
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

	const checkinCode = randomToken(CHECKIN_CODE_BYTES);
	const dashboardToken = randomToken(DASHBOARD_TOKEN_BYTES);

	const course = await env.DB.prepare(
		`INSERT INTO courses (name, duration_days, daily_break_budget_minutes, checkin_code, dashboard_token)
		 VALUES (?1, ?2, ?3, ?4, ?5)
		 RETURNING ${COURSE_COLUMNS}`,
	)
		.bind(name, durationDays, dailyBreakBudgetMinutes, checkinCode, dashboardToken)
		.first<CourseRow>();

	const defaultHeaderLeftImageId = await loadDefaultHeaderLeftImageId(env.DB);
	return Response.json({ course: serializeCourse(course!, defaultHeaderLeftImageId) }, { status: 201 });
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

adminRouter.get("/courses/:id/stats", requireAdmin, async (request: IRequest, env: Env) => {
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

adminRouter.get("/courses/:id/export.xlsx", requireAdmin, async (request: IRequest, env: Env) => {
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
			]);
		}
	}

	const breakSheet: XlsxSheet = {
		name: "Pausenzeiten",
		rows: [["Name", "Datum", "Pausenzeit (Min)", "Tagesbudget (Min)", "Verbleibend (Min)"], ...breakRows],
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

	const xlsxBytes = buildXlsx([participantsSheet, breakSheet, eventsSheet]);
	const safeFileName = course.name.replace(/[^\p{L}\p{N}\- ]+/gu, "").trim().replace(/\s+/g, "-") || `kurs-${course.id}`;

	return new Response(xlsxBytes, {
		headers: {
			"Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			"Content-Disposition": `attachment; filename="${safeFileName}.xlsx"`,
		},
	});
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

adminRouter.get("/images", requireAdmin, async (_request: IRequest, env: Env) => {
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
