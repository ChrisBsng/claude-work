// Ein Schulstunden-Dropdown-Wert (1-12) entspricht dieser Minutenzahl.
export const SCHULSTUNDE_MINUTES = 45;
export const MAX_SCHULSTUNDEN = 12;

// Toleranz, um wie viele Minuten ein Tag das Tagesziel überschreiten darf,
// bevor ein Eintrag (ohne aktivierte Mehrarbeits-Anrechnung) abgelehnt wird.
export const OVERTIME_WARNING_TOLERANCE_MINUTES = 5;

export function isValidDailyWorklogMinutes(minutes: number): boolean {
	return (
		Number.isInteger(minutes) &&
		minutes > 0 &&
		minutes % SCHULSTUNDE_MINUTES === 0 &&
		minutes / SCHULSTUNDE_MINUTES <= MAX_SCHULSTUNDEN
	);
}

export function isValidDateString(value: string): boolean {
	return /^\d{4}-\d{2}-\d{2}$/.test(value);
}
