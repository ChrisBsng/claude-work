-- Verwaltung einer ausgestellten Zwischenzertifizierungsstelle durch den Inhaber:
-- eigene Ressource (öffentlicher URL-Token, ohne Login nutzbar) + Anfragen für Endzertifikate.

CREATE TABLE ca_resources (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	csr_id INTEGER NOT NULL UNIQUE REFERENCES csrs (id) ON DELETE CASCADE,
	public_token TEXT NOT NULL UNIQUE,   -- Teil der Klassen-URL /ca/<token>, 128 Bit Zufall
	key_encrypted TEXT,                  -- optional: Private Key der Zwischen-CA (AES-GCM), NULL = nicht hinterlegt
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Anfragen von Mitschülern: eigener CSR (kind = 'csr') oder Quick-Zertifikat (kind = 'quick').
CREATE TABLE leaf_requests (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	ca_id INTEGER NOT NULL REFERENCES ca_resources (id) ON DELETE CASCADE,
	kind TEXT NOT NULL CHECK (kind IN ('csr', 'quick')),
	requester TEXT NOT NULL DEFAULT '',
	csr_pem TEXT NOT NULL,
	key_info TEXT NOT NULL,
	subject_cn TEXT NOT NULL,
	subject_ou TEXT NOT NULL DEFAULT '',
	subject_email TEXT NOT NULL DEFAULT '',
	san TEXT NOT NULL DEFAULT '',        -- Komma-getrennte Liste (DNS, IP, E-Mail)
	status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'issued', 'rejected')),
	reject_reason TEXT,
	cert_pem TEXT,
	serial_number TEXT,
	not_before TEXT,
	not_after TEXT,
	submitted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	decided_at TEXT
);
CREATE INDEX idx_leaf_ca ON leaf_requests (ca_id, submitted_at);
