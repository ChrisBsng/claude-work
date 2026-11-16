export interface Env {
	DB: D1Database;
	ASSETS: Fetcher;
	// Startpasswort Admin (bis in der Oberfläche ein eigenes gesetzt wird).
	ADMIN_PASSWORD: string;
	// Ableitungsbasis für Root-Key-Verschlüsselung und Session-Tokens.
	MASTER_SECRET: string;
}
