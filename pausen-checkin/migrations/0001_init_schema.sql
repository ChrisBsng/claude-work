-- Kurse werden im Admin-Bereich angelegt. Zwei getrennte, automatisch
-- generierte URL-Bausteine:
--   - checkin_code: öffentlicher Teil der QR-Check-in-URL für Teilnehmer
--   - dashboard_token: geheimer Teil der Kurs-Dashboard-URL (Beamer/Leinwand-
--     Ansicht mit Teilnehmerliste, Pausenbudget und dem QR-Code)
-- Kein eigenes Login-System, Zugriff ausschließlich über diese Tokens.
CREATE TABLE courses (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL,
	start_date TEXT NOT NULL DEFAULT (date('now')),
	duration_days INTEGER NOT NULL,
	daily_break_budget_minutes INTEGER NOT NULL,
	timezone TEXT NOT NULL DEFAULT 'Europe/Berlin',
	checkin_code TEXT NOT NULL UNIQUE,
	dashboard_token TEXT NOT NULL UNIQUE,
	is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Teilnehmende registrieren sich selbst über den gemeinsamen Check-in-Link:
-- beim ersten Aufruf auf dem eigenen Gerät wird nur der Name abgefragt,
-- der zurückgegebene access_token wird im Browser (localStorage)
-- gespeichert und identifiziert die Person bei künftigen Aufrufen.
-- status hält den aktuellen Zustand redundant vor, damit das Dashboard
-- bei häufigem Polling nicht jedes Mal das komplette Event-Log
-- aggregieren muss. Das tatsächliche Pausenbudget wird zur Laufzeit aus
-- checkin_events berechnet (Tagesgrenze anhand courses.timezone).
CREATE TABLE participants (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	course_id INTEGER NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	access_token TEXT NOT NULL UNIQUE,
	status TEXT NOT NULL DEFAULT 'present' CHECK (status IN ('present', 'on_break')),
	status_changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_participants_course_id ON participants (course_id);

-- Unveränderliches Event-Log jedes Check-in/-out, Basis für die
-- Pausenbudget-Berechnung (Summe der Pausenzeiten pro Kalendertag) und
-- spätere Auswertungen/Historie.
CREATE TABLE checkin_events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	participant_id INTEGER NOT NULL REFERENCES participants (id) ON DELETE CASCADE,
	course_id INTEGER NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
	event_type TEXT NOT NULL CHECK (event_type IN ('check_in', 'check_out')),
	occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_checkin_events_course_occurred ON checkin_events (course_id, occurred_at);
CREATE INDEX idx_checkin_events_participant_occurred ON checkin_events (participant_id, occurred_at);
