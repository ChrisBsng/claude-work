-- Schul-CA: Zwischenzertifikate für Klassen per CSR.

-- Key-Value-Einstellungen:
--   student_password_hash  PBKDF2-Hash (gleiches Format wie im Pausen-Tool)
--   admin_password_hash    PBKDF2-Hash; solange leer, gilt das Secret ADMIN_PASSWORD
--   password_hint          Hinweistext auf der Schüler-Anmeldeseite
CREATE TABLE app_settings (
	key TEXT PRIMARY KEY,
	value TEXT
);

-- Stammzertifikate inkl. Private Key. Der Key liegt ausschließlich
-- verschlüsselt (AES-256-GCM, Schlüssel per HKDF aus dem Worker-Secret
-- MASTER_SECRET abgeleitet) in der Datenbank – "Trust Store" im Sinne von:
-- ohne das Secret ist der DB-Inhalt wertlos.
CREATE TABLE root_cas (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL,
	subject TEXT NOT NULL,
	cert_pem TEXT NOT NULL,
	key_encrypted TEXT NOT NULL,
	fingerprint_sha256 TEXT NOT NULL UNIQUE,
	key_algorithm TEXT NOT NULL,
	not_before TEXT NOT NULL,
	not_after TEXT NOT NULL,
	is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Vorlagen für typische Zertifikatsfelder / Erweiterungen.
CREATE TABLE cert_templates (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL UNIQUE,
	validity_days INTEGER NOT NULL,
	path_len INTEGER,               -- NULL = keine Pfadlängenbeschränkung
	subject_country TEXT,
	subject_state TEXT,
	subject_locality TEXT,
	subject_org TEXT,
	subject_org_unit TEXT,
	permitted_dns TEXT,             -- Komma-getrennt, NULL = keine Name Constraints
	crl_url TEXT,
	aia_url TEXT,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Eingereichte CSRs. code_hash = SHA-256 des Abruf-Codes (wird nur einmalig
-- im Klartext angezeigt).
CREATE TABLE csrs (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	root_ca_id INTEGER NOT NULL REFERENCES root_cas (id),
	label TEXT NOT NULL,
	csr_pem TEXT NOT NULL,
	csr_subject TEXT NOT NULL,
	key_info TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'issued')),
	code_hash TEXT NOT NULL UNIQUE,
	template_id INTEGER REFERENCES cert_templates (id) ON DELETE SET NULL,
	approved_subject TEXT,          -- JSON {C,ST,L,O,OU,CN}
	approved_validity_days INTEGER,
	reject_reason TEXT,
	cert_pem TEXT,
	serial_number TEXT,
	not_before TEXT,
	not_after TEXT,
	submitted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	decided_at TEXT,
	issued_at TEXT
);
CREATE INDEX idx_csrs_status ON csrs (status, submitted_at);

-- Einfaches Rate-Limiting (Anmeldeversuche, Uploads, Code-Abrufe).
CREATE TABLE rate_limits (
	key TEXT PRIMARY KEY,
	count INTEGER NOT NULL,
	reset_at INTEGER NOT NULL
);

-- Bereits verbrauchte Captcha-Nonces (Replay-Schutz).
CREATE TABLE used_captchas (
	nonce TEXT PRIMARY KEY,
	expires_at INTEGER NOT NULL
);
