-- Kurse: jeder Kurs ist unabhängig, hat einen öffentlichen Slug (URL)
-- und einen geheimen admin_token für die Trainer-Ansicht (kein Login-System).
CREATE TABLE courses (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	slug TEXT NOT NULL UNIQUE,
	name TEXT NOT NULL,
	admin_token TEXT NOT NULL UNIQUE,
	is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Teilnehmende gehören zu genau einem Kurs. access_token steckt im
-- persönlichen Check-in/-out-Link jeder Person (z. B. per QR-Code),
-- ebenfalls ohne Login-System. status hält den aktuellen Zustand
-- redundant vor, damit die Live-Ansicht nicht bei jedem Poll über das
-- komplette Event-Log aggregieren muss.
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

-- Unveränderliches Event-Log für Historie/Audit je Check-in/-out.
CREATE TABLE checkin_events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	participant_id INTEGER NOT NULL REFERENCES participants (id) ON DELETE CASCADE,
	course_id INTEGER NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
	event_type TEXT NOT NULL CHECK (event_type IN ('check_in', 'check_out')),
	occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_checkin_events_course_occurred ON checkin_events (course_id, occurred_at);
CREATE INDEX idx_checkin_events_participant_occurred ON checkin_events (participant_id, occurred_at);
