# Schul-CA – Zwischenzertifikate für Klassen per CSR

Cloudflare Worker + D1, gleicher Aufbau wie `pausen-checkin`.

**Öffentlich** (`/`, ohne Login): Mindestanforderungen an den CSR und Download der Stammzertifikate
(nur das Zertifikat).

**Zwei getrennte Zugänge auf der Startseite:**

1. *Neues Zwischenzertifikat beantragen* – **Schulpasswort + Captcha**, danach CSR-Upload (Auswahl
   des Stammzertifikats, Kontaktangaben) und einmalige Anzeige des Abruf-Codes.
2. *Status prüfen, Zertifikat abrufen & verwalten* – **Abruf-Code + Captcha**, ohne Schulpasswort.
   Daraus entsteht eine kurzlebige **Abruf-Sitzung** (2 h, an genau diesen CSR gebunden): Download
   des Zertifikats, Verwaltung aktivieren/deaktivieren, Zugang zum Inhaber-Bereich der Klassen-Seite.
   Das Schulpasswort wird dafür nicht benötigt, der Abruf-Code ersetzt es nicht beim Beantragen.

**Admin** (`/admin`): CSR-Queue (freigeben mit Template / ablehnen / Zertifikat erzeugen),
Stammzertifikate (nur Import von Zertifikat + Key, die Root wird offline erzeugt; aktiv/inaktiv), Templates, Schüler-/Admin-Passwort
und Passworthinweis.

## Wichtige Designentscheidungen

* **Kein OpenSSL im Worker.** Cloudflare Workers können keine Prozesse starten. CSR-Prüfung und
  Signierung laufen daher mit WebCrypto + `@peculiar/x509` (reines JS). Die Ergebnisse werden in
  `test/pki.test.ts` mit `openssl verify` gegengeprüft.
* **Root-Key-„Trust Store“:** Der Private Key liegt nur als AES-256-GCM-Ciphertext in D1. Der
  Schlüssel wird per HKDF aus dem Worker-Secret `MASTER_SECRET` abgeleitet. Ohne dieses Secret
  ist ein DB-Dump wertlos. Der Key wird nie an den Client ausgeliefert.
* **Passwörter** wie im Pausen-Tool: PBKDF2-SHA256, 100.000 Iterationen, Format
  `pbkdf2:<iter>:<salt>:<hash>`, Vergleich in konstanter Zeit, HMAC-signierte Session-Tokens.
  Admin- und Schülerpasswort werden in der Admin-Oberfläche gesetzt und als Hash in D1 gespeichert.
  Bis zum ersten Ändern gilt für den Admin das Secret `ADMIN_PASSWORD`. Ein Passwortwechsel macht
  alle bestehenden Sessions dieser Rolle ungültig. Ohne gesetztes Schülerpasswort ist die
  Schülerseite gesperrt.
* **Captcha:** selbst gehostet (SVG, Zeichen als Pfade), zustandslos signiert, einmalig einlösbar.
  Zusätzlich Rate-Limits (Login, Upload, Code-Abruf) in D1.
* **Abruf-Code:** 80 Bit, nur als SHA-256 gespeichert, wird nur beim Upload angezeigt.
* **Ausgestellte Inhalte:** Schlüssel aus dem CSR; Subject aus Template/Admin-Eingabe; Extensions
  ausschließlich aus dem Template (BasicConstraints CA:TRUE kritisch + Pfadlänge, KeyUsage
  keyCertSign/cRLSign, SKI/AKI, optional Name Constraints, CRL-DP, AIA). Im CSR angeforderte
  Extensions werden ignoriert. Die Laufzeit wird auf die Gültigkeit des Stammzertifikats gekürzt.
* **Verifikation:** Beim Einreichen sind Kontaktperson und Kontaktweg (E-Mail, Teams oder Telefon, mit Kontaktangabe) Pflicht und werden serverseitig validiert (E-Mail-/Telefonformat). Die Administration sieht sie in der CSR-Liste und im Detail; für Schüler sind sie nicht abrufbar. Ein Hinweis zur Verifikation steht auf der Schülerseite.
* CSRs werden abgelehnt bei ungültiger Signatur, fehlendem CN, RSA < 2048 Bit oder nicht unterstützter Kurve (steht auch öffentlich auf der Startseite).

## Zwischen-CA verwalten (Klassen-Seite)

Unter dem Abruf-Code eines ausgestellten Zwischenzertifikats gibt es das Häkchen „Ich möchte die
Zwischenzertifizierungsstelle hier verwalten“. Es legt die Ressource `/ca/<Token>` an (128 Bit
Zufall, ohne Login nutzbar), die der Inhaber an die Klasse weitergibt.

* **Klassen-Seite (öffentlich, per URL):** Zwischenzertifikat herunterladen (PEM/DER/Kette), Tabelle
  aller Anfragen und ausgestellten Zertifikate (Download PEM/Kette/Vollkette/DER), neue Anfrage per
  eigenem CSR oder **Quick-Zertifikat** (CN, OU, SAN, E → Schlüssel und CSR werden serverseitig
  erzeugt; der Private Key steht nur in der Antwort, wird nicht gespeichert und ist nur einmal
  herunterladbar). Einreichen erfordert Captcha, Rate-Limit und ist je Zwischen-CA auf 300 Anfragen begrenzt.
* **Inhaber-Bereich (Abruf-Code + Captcha bzw. Abruf-Sitzung):** Anfragen prüfen, Subject/SAN/Laufzeit anpassen, freigeben
  (= ausstellen) oder mit Grund ablehnen. Den Schlüssel der Zwischen-CA kann der Inhaber
  **dauerhaft hinterlegen** (AES-256-GCM, eigener abgeleiteter Schlüssel `ca-key`) oder bei jeder
  Freigabe **neu hochladen** (wird nur im Request verwendet). Ein hinterlegter Schlüssel ist für die
  Betreiber technisch entschlüsselbar – die Oberfläche weist darauf hin.
* **Pflichtangaben & Subject:** OU und E-Mail sind bei jeder Anfrage (Quick und CSR) und bei der
  Freigabe Pflicht, damit der Antragsteller identifizierbar ist. C, ST, L und O werden aus dem
  Zwischenzertifikat vorbelegt; der Inhaber kann sie bei der Freigabe anpassen. Die Laufzeit ist im
  Freigabeformular begrenzt auf die Restlaufzeit der Zwischen-CA (max. 825 Tage); längere Werte
  lehnt der Server ab.
* **Endzertifikate:** CA:FALSE, KeyUsage digitalSignature (+ keyEncipherment bei RSA), EKU
  serverAuth + clientAuth, SAN, SKI/AKI. SANs außerhalb der Name Constraints der Zwischen-CA werden
  beim Ausstellen abgelehnt. 
* Die Administration sieht in der CSR-Liste je Zwischenzertifikat ein „+“, das alle verwalteten
  Zertifikate (CN, OU, E-Mail, SAN, Antragsteller, Status, Laufzeit) aufklappt, und kann die Verwaltung im CSR-Detail deaktivieren (löscht
  Klassen-URL, Anfragen und gespeicherten Schlüssel).

## Einrichtung

```bash
cd schul-ca
npm ci
npx wrangler d1 create schul-ca-db      # database_id in wrangler.jsonc eintragen
npm run db:migrations:apply:remote
npx wrangler secret put ADMIN_PASSWORD   # Startpasswort
npx wrangler secret put MASTER_SECRET    # z. B. openssl rand -base64 48 – SICHER AUFBEWAHREN
npm run deploy
```

`MASTER_SECRET` darf nicht verloren gehen oder geändert werden: sonst lassen sich die
gespeicherten Root-Keys nicht mehr entschlüsseln (Stammzertifikate müssten neu importiert werden).

GitHub Actions (`.github/workflows/deploy-schul-ca.yml`): Repository-Secrets
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `SCHULCA_ADMIN_PASSWORD`, `SCHULCA_MASTER_SECRET`.

## Lokal entwickeln & testen

```bash
cp .dev.vars.example .dev.vars
npm run db:migrations:apply:local
npm run dev                # http://localhost:8787
npm test                   # PKI-/Krypto-Tests (OpenSSL-Gegenprobe, falls installiert)
```

E2E gegen einen laufenden `wrangler dev` (Secrets: `ADMIN_PASSWORD=startpass-123`,
`MASTER_SECRET=test-master-secret-0123456789abcdef`, frische lokale DB):
`BASE=http://localhost:8787 npm run test:e2e`

## Hinweise / Grenzen

* PBKDF2 mit 100k Iterationen und Signieren sind im Pausen-Tool bereits so im Einsatz.
* Keine CRL/OCSP-Erzeugung und kein Widerruf – nur die Verweis-URLs im Template.
* Import: Private Key muss unverschlüsseltes PKCS#8 sein (Hinweis zur Umwandlung steht in der UI).
