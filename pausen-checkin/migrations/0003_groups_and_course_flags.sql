-- Untergruppen innerhalb eines Kurses (z. B. Klassen/Teams). Werden bei
-- der Anmeldung neuer Teilnehmer als Freitext angelegt oder aus
-- bestehenden Gruppen des Kurses ausgewählt.
CREATE TABLE groups (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	course_id INTEGER NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX idx_groups_course_name ON groups (course_id, name COLLATE NOCASE);

ALTER TABLE participants ADD COLUMN group_id INTEGER REFERENCES groups (id) ON DELETE SET NULL;

-- Zwei unabhängige Erfassungs-Modi je Kurs. has_worklog_tracking ist
-- vorerst nur ein gespeichertes Flag ohne eigene Funktion (folgt in
-- einem späteren Schritt).
ALTER TABLE courses ADD COLUMN has_break_tracking INTEGER NOT NULL DEFAULT 1 CHECK (has_break_tracking IN (0, 1));
ALTER TABLE courses ADD COLUMN has_worklog_tracking INTEGER NOT NULL DEFAULT 0 CHECK (has_worklog_tracking IN (0, 1));
