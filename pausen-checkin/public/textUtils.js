// Gemeinsame Grenzwerte für Texteingaben/-anzeigen, von admin.js und
// checkin.js genutzt.

// Maximale Länge für freie Texteingaben (Namen, Gruppen, Tasks, ...).
export const MAX_TEXT_INPUT_LENGTH = 100;

// Maximale sichtbare Länge einer Combobox-Option, bevor sie gekürzt wird.
// Der volle Text bleibt über den title-Tooltip (QuickInfo) erreichbar.
const COMBOBOX_LABEL_MAX_LENGTH = 30;

export function truncateLabel(text, maxLength = COMBOBOX_LABEL_MAX_LENGTH) {
	const value = String(text);
	if (value.length <= maxLength) return value;
	return `${value.slice(0, maxLength - 1)}…`;
}
