// Kontaktangaben für die Verifikation durch die Administration (Schüler-Antrag und Admin-Bearbeitung).
export const CONTACT_METHODS = ["email", "teams", "phone"] as const;
export type ContactMethod = (typeof CONTACT_METHODS)[number];

// Kontaktangaben für die Verifikation durch die Administration.
export function validateContact(person: unknown, method: unknown, detail: unknown): { error: string } | { person: string; method: ContactMethod; detail: string } {
	const p = typeof person === "string" ? person.trim() : "";
	const d = typeof detail === "string" ? detail.trim() : "";
	if (p.length < 2 || p.length > 80) return { error: "Bitte die Kontaktperson angeben (Vor- und Nachname, 2–80 Zeichen)." };
	if (!CONTACT_METHODS.includes(method as ContactMethod)) return { error: "Bitte einen Kontaktweg wählen (E-Mail, Teams oder Telefon)." };
	if (d.length < 3 || d.length > 120) return { error: "Bitte die Kontaktangabe zum gewählten Kontaktweg eintragen." };
	if (method === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d)) return { error: "Bitte eine gültige E-Mail-Adresse angeben." };
	if (method === "phone" && !/^\+?[0-9 ()\/.-]{6,30}$/.test(d)) return { error: "Bitte eine gültige Telefonnummer angeben." };
	return { person: p, method: method as ContactMethod, detail: d };
}
