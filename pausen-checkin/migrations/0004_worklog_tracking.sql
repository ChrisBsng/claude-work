-- Tägliche Soll-Arbeitszeit in Minuten (Auswahl im Admin-Bereich erfolgt
-- in Schulstunden à 45 Minuten, gespeichert wird direkt in Minuten).
ALTER TABLE courses ADD COLUMN daily_worklog_minutes INTEGER;

-- Explizit ausgewählte Projekttage (nicht zwingend jeder Kalendertag der
-- Kurslaufzeit, z. B. keine Wochenenden).
CREATE TABLE project_days (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	course_id INTEGER NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
	date TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_project_days_course_date ON project_days (course_id, date);

-- Ein Eintrag pro Task/Zeitblock; mehrere Einträge pro Teilnehmer und Tag
-- möglich, deren Summe mit daily_worklog_minutes verglichen wird.
CREATE TABLE worklog_entries (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	participant_id INTEGER NOT NULL REFERENCES participants (id) ON DELETE CASCADE,
	course_id INTEGER NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
	date TEXT NOT NULL,
	task TEXT NOT NULL,
	minutes INTEGER NOT NULL CHECK (minutes >= 0),
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_worklog_entries_participant_date ON worklog_entries (participant_id, date);
CREATE INDEX idx_worklog_entries_course_date ON worklog_entries (course_id, date);
