/**
 * Adressiert das Session-Durable-Object für ein Domain+Benutzername-Paar über
 * einen SHA-256-Hash, statt Rohdaten in den DO-Namen zu schreiben. So landen
 * dieselben Zugangsdaten immer auf derselben (gecachten) Session, ohne dass
 * Cloudflare-Logs/Analytics Klartext-Benutzernamen als DO-Namen sehen.
 */
export async function sessionKeyFor(domain: string, username: string): Promise<string> {
	const key = `${domain.toLowerCase()}\u0000${username.toLowerCase()}`;
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}
