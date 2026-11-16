-- Pflichtangaben zur Verifikation: Kontaktperson + Kontaktweg.
-- Bestehende CSRs behalten leere Werte (NOT NULL DEFAULT '').
ALTER TABLE csrs ADD COLUMN contact_person TEXT NOT NULL DEFAULT '';
ALTER TABLE csrs ADD COLUMN contact_method TEXT NOT NULL DEFAULT '';   -- email | teams | phone
ALTER TABLE csrs ADD COLUMN contact_detail TEXT NOT NULL DEFAULT '';
