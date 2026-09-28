-- Individuelles Passwort je Teilnehmer (nullable: bestehende Teilnehmer
-- ohne Passwort werden beim nächsten Login zur Vergabe aufgefordert,
-- siehe /api/checkin/:checkinCode/login). Name muss je Kurs eindeutig
-- sein, da er jetzt als Login-Bezeichner dient.
ALTER TABLE participants ADD COLUMN password_hash TEXT;
CREATE UNIQUE INDEX idx_participants_course_name ON participants (course_id, name COLLATE NOCASE);

-- Bild-Repository (Dateien liegen in R2, diese Tabelle hält nur die
-- Metadaten; id ist zugleich der R2-Objektschlüssel).
CREATE TABLE images (
	id TEXT PRIMARY KEY,
	original_filename TEXT NOT NULL,
	content_type TEXT NOT NULL,
	size_bytes INTEGER NOT NULL,
	uploaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Globale Einstellungen (z. B. Standard-Logo links), simples Key-Value.
CREATE TABLE app_settings (
	key TEXT PRIMARY KEY,
	value TEXT
);

-- Individuelle Header-Bilder je Kurs; NULL bei header_left_image_id
-- bedeutet "globalen Standard verwenden" (app_settings), NULL bei
-- header_right_image_id bedeutet "kein Bild".
ALTER TABLE courses ADD COLUMN header_left_image_id TEXT REFERENCES images (id) ON DELETE SET NULL;
ALTER TABLE courses ADD COLUMN header_right_image_id TEXT REFERENCES images (id) ON DELETE SET NULL;
