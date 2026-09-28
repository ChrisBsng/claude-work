// Liefert die Basis-URL für angezeigte Links (Dashboard-/Check-in-Links).
// Kommt vom Server (CUSTOM_DOMAIN, falls als GitHub-Actions-Variable
// gesetzt), damit angezeigte Links auch dann die eigene Domain zeigen,
// wenn die Seite selbst z. B. über die workers.dev-Domain aufgerufen wurde.
let cachedBaseUrl = null;

export async function getBaseUrl() {
	if (cachedBaseUrl) return cachedBaseUrl;
	try {
		const response = await fetch("/api/config");
		const data = await response.json();
		cachedBaseUrl = data.baseUrl || window.location.origin;
	} catch {
		cachedBaseUrl = window.location.origin;
	}
	return cachedBaseUrl;
}
