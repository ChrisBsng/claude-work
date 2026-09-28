import { Router, type IRequest } from "itty-router";
import type { Env } from "../env";
import { computeBreakBudgetFromEvents, fetchRecentParticipantEvents, localDateString, type BreakBudgetResult } from "../breakBudget";
import { hashParticipantPassword, randomToken, verifyParticipantPassword } from "../crypto";
import { resolveBaseUrl } from "../baseUrl";
import { resolveHeaderImageIds } from "../images";
import { renderQrCodeSvg } from "../qrcode";
import { isValidDateString, OVERTIME_WARNING_TOLERANCE_MINUTES } from "../worklog";

const PARTICIPANT_TOKEN_BYTES = 20;
const MIN_PASSWORD_LENGTH = 4;

interface CourseRow {
	id: number;
	name: string;
	daily_break_budget_minutes: number;
	timezone: string;
	is_active: number;
	header_left_image_id: string | null;
	header_right_image_id: string | null;
	has_break_tracking: number;
	has_worklog_tracking: number;
	daily_worklog_minutes: number | null;
	allow_overtime_credit: number;
}

type ParticipantStatus = "present" | "on_break" | "unknown";

interface ParticipantRow {
	id: number;
	name: string;
	access_token: string;
	password_hash: string | null;
	group_id: number | null;
}

async function getActiveCourseByCheckinCode(db: D1Database, checkinCode: string): Promise<CourseRow | null> {
	const course = await db
		.prepare(
			`SELECT id, name, daily_break_budget_minutes, timezone, is_active, header_left_image_id, header_right_image_id,
			 has_break_tracking, has_worklog_tracking, daily_worklog_minutes, allow_overtime_credit
			 FROM courses WHERE checkin_code = ?1`,
		)
		.bind(checkinCode)
		.first<CourseRow>();
	return course && course.is_active ? course : null;
}

async function getParticipantByToken(db: D1Database, courseId: number, accessToken: string): Promise<ParticipantRow | null> {
	return db
		.prepare("SELECT id, name, access_token, password_hash, group_id FROM participants WHERE course_id = ?1 AND access_token = ?2")
		.bind(courseId, accessToken)
		.first<ParticipantRow>();
}

async function requireParticipant(
	request: IRequest,
	env: Env,
	course: CourseRow,
): Promise<{ participant: ParticipantRow } | { error: Response }> {
	const accessToken = request.headers.get("X-Access-Token");
	if (!accessToken) {
		return { error: Response.json({ error: "Kein Zugriffs-Token" }, { status: 401 }) };
	}
	const participant = await getParticipantByToken(env.DB, course.id, accessToken);
	if (!participant) {
		return { error: Response.json({ error: "Teilnehmer nicht gefunden" }, { status: 404 }) };
	}
	return { participant };
}

// Status wird immer frisch aus dem Event-Log abgeleitet (tagesbezogen),
// nicht aus einer gespeicherten Spalte: "unknown" heißt "heute noch keine
// einzige Aktion", damit hängt nichts von Vortagen ab und ein neuer Tag
// startet nie fälschlich als "anwesend".
async function loadParticipantView(
	db: D1Database,
	participant: { id: number; name: string },
	course: CourseRow,
): Promise<{ participant: { id: number; name: string; status: ParticipantStatus }; budget: BreakBudgetResult }> {
	const events = await fetchRecentParticipantEvents(db, participant.id);
	const budget = computeBreakBudgetFromEvents(events, course.daily_break_budget_minutes, course.timezone);
	const status: ParticipantStatus = !budget.hasActivityToday ? "unknown" : budget.isOnBreakNow ? "on_break" : "present";
	return { participant: { id: participant.id, name: participant.name, status }, budget };
}

export const checkinRouter = Router({ base: "/api/checkin" });

checkinRouter.get("/:checkinCode", async (request: IRequest, env: Env) => {
	const course = await getActiveCourseByCheckinCode(env.DB, request.params.checkinCode);
	if (!course) {
		return Response.json({ error: "Kurs nicht gefunden" }, { status: 404 });
	}
	const { leftImageId, rightImageId } = await resolveHeaderImageIds(env.DB, course);
	return Response.json({
		course: {
			name: course.name,
			dailyBreakBudgetMinutes: course.daily_break_budget_minutes,
			headerLeftImageId: leftImageId,
			headerRightImageId: rightImageId,
			hasBreakTracking: Boolean(course.has_break_tracking),
			hasWorklogTracking: Boolean(course.has_worklog_tracking),
			dailyWorklogMinutes: course.daily_worklog_minutes,
			allowOvertimeCredit: Boolean(course.allow_overtime_credit),
		},
	});
});

// Bestehende Gruppen des Kurses für das Auswahl-Dropdown bei der Anmeldung.
checkinRouter.get("/:checkinCode/groups", async (request: IRequest, env: Env) => {
	const course = await getActiveCourseByCheckinCode(env.DB, request.params.checkinCode);
	if (!course) {
		return Response.json({ error: "Kurs nicht gefunden" }, { status: 404 });
	}
	const { results } = await env.DB.prepare("SELECT name FROM groups WHERE course_id = ?1 ORDER BY name COLLATE NOCASE ASC")
		.bind(course.id)
		.all<{ name: string }>();
	return Response.json({ groups: results.map((row) => row.name) });
});

checkinRouter.get("/:checkinCode/qrcode.svg", async (request: IRequest, env: Env) => {
	const course = await getActiveCourseByCheckinCode(env.DB, request.params.checkinCode);
	if (!course) {
		return Response.json({ error: "Kurs nicht gefunden" }, { status: 404 });
	}

	const checkinUrl = new URL(`/k/${request.params.checkinCode}`, resolveBaseUrl(env, request)).toString();
	const svg = renderQrCodeSvg(checkinUrl);
	return new Response(svg, {
		headers: {
			"Content-Type": "image/svg+xml",
			"Cache-Control": "public, max-age=3600",
		},
	});
});

// Namen bereits registrierter Teilnehmer für das Auswahl-Dropdown auf der
// Check-in-Seite (kein Login nötig, enthält keine sensiblen Daten).
checkinRouter.get("/:checkinCode/participants", async (request: IRequest, env: Env) => {
	const course = await getActiveCourseByCheckinCode(env.DB, request.params.checkinCode);
	if (!course) {
		return Response.json({ error: "Kurs nicht gefunden" }, { status: 404 });
	}
	const { results } = await env.DB.prepare(
		"SELECT name FROM participants WHERE course_id = ?1 ORDER BY name COLLATE NOCASE ASC",
	)
		.bind(course.id)
		.all<{ name: string }>();
	return Response.json({ names: results.map((row) => row.name) });
});

// Vereint Neuregistrierung und Login: Name unbekannt -> neuer Teilnehmer
// mit dem angegebenen Passwort; Name bekannt ohne Passwort (Altbestand)
// -> das jetzt eingegebene Passwort wird übernommen; Name bekannt mit
// Passwort -> muss übereinstimmen.
checkinRouter.post("/:checkinCode/login", async (request: IRequest, env: Env) => {
	const course = await getActiveCourseByCheckinCode(env.DB, request.params.checkinCode);
	if (!course) {
		return Response.json({ error: "Kurs nicht gefunden" }, { status: 404 });
	}

	const body = (await request.json().catch(() => null)) as { name?: string; password?: string; group?: string } | null;
	const name = body?.name?.trim();
	const password = body?.password ?? "";
	const groupName = body?.group?.trim();

	if (!name || password.length < MIN_PASSWORD_LENGTH) {
		return Response.json(
			{ error: `Name und ein Passwort mit mindestens ${MIN_PASSWORD_LENGTH} Zeichen sind erforderlich.` },
			{ status: 400 },
		);
	}

	const existing = await env.DB.prepare(
		"SELECT id, name, access_token, password_hash FROM participants WHERE course_id = ?1 AND name = ?2 COLLATE NOCASE",
	)
		.bind(course.id, name)
		.first<ParticipantRow>();

	let participant: { id: number; name: string };
	let accessToken: string;

	if (!existing) {
		if (!groupName) {
			return Response.json({ error: "Gruppe ist erforderlich." }, { status: 400 });
		}

		let group = await env.DB.prepare("SELECT id FROM groups WHERE course_id = ?1 AND name = ?2 COLLATE NOCASE")
			.bind(course.id, groupName)
			.first<{ id: number }>();
		if (!group) {
			group = await env.DB.prepare("INSERT INTO groups (course_id, name) VALUES (?1, ?2) RETURNING id")
				.bind(course.id, groupName)
				.first<{ id: number }>();
		}

		accessToken = randomToken(PARTICIPANT_TOKEN_BYTES);
		const passwordHash = await hashParticipantPassword(password);
		let created: { id: number; name: string } | null;
		try {
			created = await env.DB.prepare(
				"INSERT INTO participants (course_id, name, access_token, password_hash, group_id) VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id, name",
			)
				.bind(course.id, name, accessToken, passwordHash, group!.id)
				.first<{ id: number; name: string }>();
		} catch {
			return Response.json({ error: "Dieser Name wurde gerade eben schon vergeben. Bitte Seite neu laden." }, { status: 409 });
		}
		participant = created!;
		await env.DB.prepare("INSERT INTO checkin_events (participant_id, course_id, event_type) VALUES (?1, ?2, 'check_in')")
			.bind(participant.id, course.id)
			.run();
	} else if (!existing.password_hash) {
		const passwordHash = await hashParticipantPassword(password);
		await env.DB.prepare("UPDATE participants SET password_hash = ?1 WHERE id = ?2").bind(passwordHash, existing.id).run();
		participant = { id: existing.id, name: existing.name };
		accessToken = existing.access_token;
	} else {
		if (!(await verifyParticipantPassword(existing.password_hash, password))) {
			return Response.json({ error: "Falsches Passwort" }, { status: 401 });
		}
		participant = { id: existing.id, name: existing.name };
		accessToken = existing.access_token;
	}

	return Response.json({ accessToken, ...(await loadParticipantView(env.DB, participant, course)) });
});

checkinRouter.get("/:checkinCode/me", async (request: IRequest, env: Env) => {
	const course = await getActiveCourseByCheckinCode(env.DB, request.params.checkinCode);
	if (!course) {
		return Response.json({ error: "Kurs nicht gefunden" }, { status: 404 });
	}

	const auth = await requireParticipant(request, env, course);
	if ("error" in auth) return auth.error;

	return Response.json(await loadParticipantView(env.DB, auth.participant, course));
});

// Ohne body: normaler Toggle (present<->on_break) anhand des aktuellen,
// tagesbezogenen Status. Mit body.status: expliziter Zielstatus – nötig,
// wenn der aktuelle Status "unknown" ist (erste Aktion des Tages), da man
// von dort nicht "umschalten" kann, sondern explizit wählen muss.
checkinRouter.post("/:checkinCode/toggle", async (request: IRequest, env: Env) => {
	const course = await getActiveCourseByCheckinCode(env.DB, request.params.checkinCode);
	if (!course) {
		return Response.json({ error: "Kurs nicht gefunden" }, { status: 404 });
	}

	const auth = await requireParticipant(request, env, course);
	if ("error" in auth) return auth.error;
	const participant = auth.participant;

	const body = (await request.json().catch(() => null)) as { status?: string } | null;
	const requestedStatus = body?.status === "present" || body?.status === "on_break" ? body.status : null;

	const before = await loadParticipantView(env.DB, participant, course);
	const newStatus = requestedStatus ?? (before.participant.status === "on_break" ? "present" : "on_break");
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

// --- Worklog ---

interface WorklogEntryRow {
	id: number;
	task: string;
	minutes: number;
}

function requireWorklogEnabled(course: CourseRow): Response | null {
	if (!course.has_worklog_tracking || !course.daily_worklog_minutes) {
		return Response.json({ error: "Worklogerfassung ist für diesen Kurs nicht aktiviert." }, { status: 400 });
	}
	return null;
}

async function isProjectDay(db: D1Database, courseId: number, date: string): Promise<boolean> {
	const row = await db.prepare("SELECT 1 FROM project_days WHERE course_id = ?1 AND date = ?2").bind(courseId, date).first();
	return Boolean(row);
}

// Projekttage mit Gesamtzeit/Vollständigkeit der aktuell angemeldeten
// Person – Grundlage für die Tagesauswahl auf der Worklog-Seite
// ("vergangene Projekttage", rot markiert wenn unvollständig).
checkinRouter.get("/:checkinCode/worklog/days", async (request: IRequest, env: Env) => {
	const course = await getActiveCourseByCheckinCode(env.DB, request.params.checkinCode);
	if (!course) {
		return Response.json({ error: "Kurs nicht gefunden" }, { status: 404 });
	}
	const disabled = requireWorklogEnabled(course);
	if (disabled) return disabled;

	const auth = await requireParticipant(request, env, course);
	if ("error" in auth) return auth.error;

	const todayLocal = localDateString(new Date(), course.timezone);
	const { results: projectDays } = await env.DB.prepare(
		"SELECT date FROM project_days WHERE course_id = ?1 AND date <= ?2 ORDER BY date ASC",
	)
		.bind(course.id, todayLocal)
		.all<{ date: string }>();

	const { results: entries } = await env.DB.prepare(
		"SELECT date, SUM(minutes) AS total FROM worklog_entries WHERE participant_id = ?1 GROUP BY date",
	)
		.bind(auth.participant.id)
		.all<{ date: string; total: number }>();
	const totalsByDate = new Map(entries.map((e) => [e.date, e.total]));

	const target = course.daily_worklog_minutes!;
	const days = projectDays.map((d) => {
		const totalMinutes = totalsByDate.get(d.date) ?? 0;
		return { date: d.date, totalMinutes, isComplete: totalMinutes >= target };
	});

	return Response.json({ dailyWorklogMinutes: target, today: todayLocal, days });
});

// Bereits verwendete Tasks derselben Gruppe, neueste zuerst – Grundlage
// für die Task-Dropdownbox beim Erfassen eines neuen Eintrags.
checkinRouter.get("/:checkinCode/worklog/tasks", async (request: IRequest, env: Env) => {
	const course = await getActiveCourseByCheckinCode(env.DB, request.params.checkinCode);
	if (!course) {
		return Response.json({ error: "Kurs nicht gefunden" }, { status: 404 });
	}
	const disabled = requireWorklogEnabled(course);
	if (disabled) return disabled;

	const auth = await requireParticipant(request, env, course);
	if ("error" in auth) return auth.error;

	if (auth.participant.group_id === null) {
		return Response.json({ tasks: [] });
	}

	const { results } = await env.DB.prepare(
		`SELECT w.task, MAX(w.created_at) AS last_used
		 FROM worklog_entries w JOIN participants p ON p.id = w.participant_id
		 WHERE p.group_id = ?1
		 GROUP BY w.task
		 ORDER BY last_used DESC
		 LIMIT 50`,
	)
		.bind(auth.participant.group_id)
		.all<{ task: string; last_used: string }>();

	return Response.json({ tasks: results.map((r) => r.task) });
});

async function getDayTotalMinutes(db: D1Database, participantId: number, date: string): Promise<number> {
	const row = await db
		.prepare("SELECT COALESCE(SUM(minutes), 0) AS total FROM worklog_entries WHERE participant_id = ?1 AND date = ?2")
		.bind(participantId, date)
		.first<{ total: number }>();
	return row?.total ?? 0;
}

function overtimeErrorResponse(projectedMinutes: number, target: number): Response {
	return Response.json(
		{
			error:
				`Mit dieser Zeit läge dein Tag bei ${projectedMinutes} Minuten und würde dein Tagesziel von ${target} Minuten ` +
				`um mehr als ${OVERTIME_WARNING_TOLERANCE_MINUTES} Minuten überschreiten. In diesem Kurs zählen Überstunden nicht zur ` +
				`Gesamtzeit – bitte reduziere die Zeit oder trage den Rest an einem anderen Tag ein.`,
		},
		{ status: 400 },
	);
}

async function loadWorklogDay(db: D1Database, participantId: number, date: string, targetMinutes: number) {
	const { results: entries } = await db
		.prepare("SELECT id, task, minutes FROM worklog_entries WHERE participant_id = ?1 AND date = ?2 ORDER BY created_at ASC")
		.bind(participantId, date)
		.all<WorklogEntryRow>();
	const totalMinutes = entries.reduce((sum, e) => sum + e.minutes, 0);
	return { date, entries, totalMinutes, targetMinutes, isComplete: totalMinutes >= targetMinutes };
}

checkinRouter.get("/:checkinCode/worklog/:date", async (request: IRequest, env: Env) => {
	const course = await getActiveCourseByCheckinCode(env.DB, request.params.checkinCode);
	if (!course) {
		return Response.json({ error: "Kurs nicht gefunden" }, { status: 404 });
	}
	const disabled = requireWorklogEnabled(course);
	if (disabled) return disabled;
	if (!isValidDateString(request.params.date)) {
		return Response.json({ error: "Ungültiges Datum" }, { status: 400 });
	}

	const auth = await requireParticipant(request, env, course);
	if ("error" in auth) return auth.error;

	return Response.json(await loadWorklogDay(env.DB, auth.participant.id, request.params.date, course.daily_worklog_minutes!));
});

checkinRouter.post("/:checkinCode/worklog/:date", async (request: IRequest, env: Env) => {
	const course = await getActiveCourseByCheckinCode(env.DB, request.params.checkinCode);
	if (!course) {
		return Response.json({ error: "Kurs nicht gefunden" }, { status: 404 });
	}
	const disabled = requireWorklogEnabled(course);
	if (disabled) return disabled;

	const date = request.params.date;
	const todayLocal = localDateString(new Date(), course.timezone);
	if (!isValidDateString(date) || date > todayLocal) {
		return Response.json({ error: "Ungültiges Datum" }, { status: 400 });
	}
	if (!(await isProjectDay(env.DB, course.id, date))) {
		return Response.json({ error: "Dieser Tag ist kein Projekttag." }, { status: 400 });
	}

	const auth = await requireParticipant(request, env, course);
	if ("error" in auth) return auth.error;

	const body = (await request.json().catch(() => null)) as { task?: string; minutes?: number } | null;
	const task = body?.task?.trim();
	const minutes = Number(body?.minutes);
	if (!task || !Number.isInteger(minutes) || minutes < 0) {
		return Response.json({ error: "Task und eine Zeit (Minuten, ≥ 0) sind erforderlich." }, { status: 400 });
	}

	if (!course.allow_overtime_credit) {
		const existingTotal = await getDayTotalMinutes(env.DB, auth.participant.id, date);
		const projectedTotal = existingTotal + minutes;
		const target = course.daily_worklog_minutes!;
		if (projectedTotal > target + OVERTIME_WARNING_TOLERANCE_MINUTES) {
			return overtimeErrorResponse(projectedTotal, target);
		}
	}

	await env.DB.prepare("INSERT INTO worklog_entries (participant_id, course_id, date, task, minutes) VALUES (?1, ?2, ?3, ?4, ?5)")
		.bind(auth.participant.id, course.id, date, task, minutes)
		.run();

	return Response.json(await loadWorklogDay(env.DB, auth.participant.id, date, course.daily_worklog_minutes!), { status: 201 });
});

checkinRouter.patch("/:checkinCode/worklog/:date/:entryId", async (request: IRequest, env: Env) => {
	const course = await getActiveCourseByCheckinCode(env.DB, request.params.checkinCode);
	if (!course) {
		return Response.json({ error: "Kurs nicht gefunden" }, { status: 404 });
	}
	const disabled = requireWorklogEnabled(course);
	if (disabled) return disabled;

	const auth = await requireParticipant(request, env, course);
	if ("error" in auth) return auth.error;

	const entryId = Number(request.params.entryId);
	const owned = await env.DB.prepare("SELECT id, date, minutes FROM worklog_entries WHERE id = ?1 AND participant_id = ?2")
		.bind(entryId, auth.participant.id)
		.first<{ id: number; date: string; minutes: number }>();
	if (!owned) {
		return Response.json({ error: "Eintrag nicht gefunden" }, { status: 404 });
	}

	const body = (await request.json().catch(() => null)) as { task?: string; minutes?: number } | null;
	const task = body?.task?.trim();
	const minutes = body?.minutes !== undefined ? Number(body.minutes) : undefined;
	if (minutes !== undefined && (!Number.isInteger(minutes) || minutes < 0)) {
		return Response.json({ error: "Zeit muss eine ganze Zahl ≥ 0 sein." }, { status: 400 });
	}

	if (!course.allow_overtime_credit && minutes !== undefined) {
		const dayTotal = await getDayTotalMinutes(env.DB, auth.participant.id, owned.date);
		const projectedTotal = dayTotal - owned.minutes + minutes;
		const target = course.daily_worklog_minutes!;
		if (projectedTotal > target + OVERTIME_WARNING_TOLERANCE_MINUTES) {
			return overtimeErrorResponse(projectedTotal, target);
		}
	}

	await env.DB.prepare(
		`UPDATE worklog_entries SET task = COALESCE(?1, task), minutes = COALESCE(?2, minutes), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
		 WHERE id = ?3`,
	)
		.bind(task || null, minutes ?? null, entryId)
		.run();

	return Response.json(await loadWorklogDay(env.DB, auth.participant.id, request.params.date, course.daily_worklog_minutes!));
});

checkinRouter.delete("/:checkinCode/worklog/:date/:entryId", async (request: IRequest, env: Env) => {
	const course = await getActiveCourseByCheckinCode(env.DB, request.params.checkinCode);
	if (!course) {
		return Response.json({ error: "Kurs nicht gefunden" }, { status: 404 });
	}
	const disabled = requireWorklogEnabled(course);
	if (disabled) return disabled;

	const auth = await requireParticipant(request, env, course);
	if ("error" in auth) return auth.error;

	const entryId = Number(request.params.entryId);
	await env.DB.prepare("DELETE FROM worklog_entries WHERE id = ?1 AND participant_id = ?2").bind(entryId, auth.participant.id).run();

	return Response.json(await loadWorklogDay(env.DB, auth.participant.id, request.params.date, course.daily_worklog_minutes!));
});
