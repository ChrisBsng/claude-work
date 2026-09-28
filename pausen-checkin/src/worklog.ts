// Ein Schulstunden-Dropdown-Wert (1-12) entspricht dieser Minutenzahl.
export const SCHULSTUNDE_MINUTES = 45;
export const MAX_SCHULSTUNDEN = 12;

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
