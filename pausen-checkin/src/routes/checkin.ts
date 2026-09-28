import { Router, type IRequest } from "itty-router";
import type { Env } from "../env";
import { computeBreakBudgetFromEvents, fetchRecentParticipantEvents, type BreakBudgetResult } from "../breakBudget";
import { hashParticipantPassword, randomToken, verifyParticipantPassword } from "../crypto";
import { resolveHeaderImageIds } from "../images";
import { renderQrCodeSvg } from "../qrcode";

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
}

type ParticipantStatus = "present" | "on_break" | "unknown";

interface ParticipantRow {
	id: number;
	name: string;
	access_token: string;
	password_hash: string | null;
}

async function getActiveCourseByCheckinCode(db: D1Database, checkinCode: string): Promise<CourseRow | null> {
	const course = await db
		.prepare(
			`SELECT id, name, daily_break_budget_minutes, timezone, is_active, header_left_image_id, header_right_image_id,
			 has_break_tracking, has_worklog_tracking
			 FROM courses WHERE checkin_code = ?1`,
		)
		.bind(checkinCode)
		.first<CourseRow>();
	return course && course.is_active ? course : null;
}

async function getParticipantByToken(db: D1Database, courseId: number, accessToken: string): Promise<ParticipantRow | null> {
	return db
		.prepare("SELECT id, name, access_token, password_hash FROM participants WHERE course_id = ?1 AND access_token = ?2")
		.bind(courseId, accessToken)
		.first<ParticipantRow>();
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

	const checkinUrl = new URL(`/k/${request.params.checkinCode}`, request.url).toString();
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

// Ohne body: normaler Toggle (present<->on_break) anhand des aktuellen,
// tagesbezogenen Status. Mit body.status: expliziter Zielstatus – nötig,
// wenn der aktuelle Status "unknown" ist (erste Aktion des Tages), da man
// von dort nicht "umschalten" kann, sondern explizit wählen muss.
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
