-- Zeitpunkt der letzten erfolgreichen Anmeldung eines Teilnehmers, getrennt
-- von created_at (das bleibt der allererste Registrierungszeitpunkt). Basis
-- für eine serverseitige Sitzungs-Ablaufzeit (siehe checkin.ts), damit ein
-- vergessener, im Hintergrund offener Tab nicht unbegrenzt weiterpollt.
--
-- SQLite erlaubt bei ALTER TABLE ... ADD COLUMN keinen nicht-konstanten
-- DEFAULT-Ausdruck (z.B. strftime('now')), daher ohne DEFAULT anlegen und
-- bestehende Zeilen per UPDATE befüllen (neue Zeilen setzen die Spalte ab
-- jetzt explizit beim INSERT, siehe checkin.ts).
ALTER TABLE participants ADD COLUMN token_issued_at TEXT;
UPDATE participants SET token_issued_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE token_issued_at IS NULL;
