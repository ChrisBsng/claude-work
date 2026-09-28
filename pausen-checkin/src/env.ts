export interface Env {
	DB: D1Database;
	ASSETS: Fetcher;
	IMAGES: R2Bucket;
	ADMIN_PASSWORD: string;
	// Optionales zweites Passwort für einen reinen Lesezugriff (Statistiken/
	// Reports, kein Anlegen/Ändern/Löschen). Ohne gesetztes Secret ist der
	// Read-Only-Login einfach nicht verfügbar.
	READONLY_PASSWORD?: string;
	// Optional, über GitHub Actions (Repository-Variable) und
	// `wrangler deploy --var CUSTOM_DOMAIN:...` gesetzt. Leer/undefined,
	// wenn keine eigene Domain konfiguriert ist.
	CUSTOM_DOMAIN?: string;
}
