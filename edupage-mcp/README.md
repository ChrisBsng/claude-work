# edupage-mcp

Ein **MCP-Server** für [Edupage](https://edupage.org), deployed als Cloudflare Worker. Beim Verbinden des
Connectors (z. B. in claude.ai) fragt der Server einmalig über eine eigene Login-Seite nach Edupage-Domain,
Benutzername und Passwort, prüft sie live gegen Edupage und hinterlegt sie verschlüsselt als OAuth-Grant. Alle
MCP-Tools laufen danach ohne weitere Zugangsdaten - die Session wird komplett serverseitig verwaltet.

## Wichtige Hinweise

- Edupage hat **keine offizielle, dokumentierte API**. Login und Datenabruf basieren auf reverse-engineerten
  internen Endpunkten (dem `__func`/`__args`/`__gsh`-RPC-Muster und dem älteren `/gcall`-Postback-Muster, die
  auch andere inoffizielle Edupage-Clients nutzen). Das kann brechen, wenn Edupage sein Seitenlayout ändert.
- Der Worker ist **ein eigener OAuth-Authorization-Server** (`@cloudflare/workers-oauth-provider`, siehe
  `src/index.ts`/`src/app-handler.ts`) - nicht Edupage selbst. Er signiert Tokens für MCP-Clients und legt die
  Edupage-Zugangsdaten AES-verschlüsselt in den Grant-Props ab (KV-Namespace `OAUTH_KV`), entschlüsselbar nur mit
  dem zugehörigen Access-Token. Das Passwort wird beim `/authorize`-Login-Formular einmalig live gegen Edupage
  geprüft, danach nur noch für automatische Re-Logins der Session verwendet, nie im Klartext geloggt.
- Die Nutzung eines inoffiziellen Zugriffswegs kann je nach Schule/Edupage-Vertrag gegen die Nutzungsbedingungen
  verstoßen - das hier ist für den persönlichen Gebrauch mit den eigenen Zugangsdaten gedacht.

## Architektur

- **`EdupageSessionDO`** (Durable Object, `src/edupage/session-do.ts`): hält Login-Cookie + CSRF-Token
  (`gsechash`) für eine Domain+Benutzername-Kombination und implementiert alle Edupage-RPC-Aufrufe (Login,
  `__func`/`__args`-Muster für Stundenplan/Namensauflösung, `/gcall`-Postback-Muster inkl. `json_dc`-Dekoder für
  die Anwesenheits-Ansicht). Adressiert wird das Objekt über einen SHA-256-Hash aus `domain+username`
  (`sessionKeyFor` in `src/edupage/session-key.ts`), damit dieselben Zugangsdaten immer auf dieselbe gecachte
  Session treffen, ohne dass Cloudflare-Logs Klartext-Benutzernamen als DO-Namen sehen. Die `domain` wird streng
  gegen ein Subdomain-Muster (`^[a-z0-9-]{1,63}$`) validiert, damit sie nicht als Host-Injection missbraucht
  werden kann.
- **`EdupageMcpAgent`** (`src/mcp-agent.ts`): der eigentliche MCP-Server (Cloudflare Agents SDK, `agents/mcp`),
  registriert die Tools. Die Edupage-Zugangsdaten kommen nicht als Tool-Parameter, sondern aus `this.props` -
  gesetzt einmalig beim OAuth-Authorize-Flow und für die Dauer der MCP-Verbindung von der Agents-SDK persistiert.
- **`src/app-handler.ts`**: der `/authorize`-Login-Flow (GET zeigt das Formular, POST prüft die Zugangsdaten live
  gegen Edupage und schließt die OAuth-Autorisierung ab) sowie die Root-Info-Seite.
- **`src/index.ts`**: Worker-Entry-Point. Baut pro Request einen `OAuthProvider` (Resource = Origin, damit sowohl
  `/mcp` als auch `/sse` geschützt sind) und delegiert an `app-handler.ts` (Authorize-Seite) bzw. den
  authentifizierten MCP-Agent-Handler (`/mcp` Streamable HTTP, `/sse` Legacy SSE).

## Tools

Kein Tool braucht mehr `domain`/`username`/`password` als Parameter - die Zugangsdaten kommen aus der
OAuth-Session.

| Tool | Parameter | Beschreibung |
| --- | --- | --- |
| `edupage_get_timetable` | `dateFrom?`, `dateTo?` | Stundenplan für einen Datumsbereich, inkl. `classIds` je Eintrag |
| `edupage_get_attendance` | `date`, `classId?` | Schüler-Anwesenheit (anwesend/abwesend/verspätet/entschuldigt) für eine Woche und Klasse |
| `edupage_logout` | - | Löscht die gespeicherte Session, erzwingt Neu-Login beim nächsten Aufruf |
| `edupage_raw_call` | `path`, `func`, `args?` | Escape-Hatch: beliebige interne `__func`/`__args`-RPC-Funktion |
| `edupage_raw_request` | `path`, `method?`, `body?` | Escape-Hatch: beliebiger authentifizierter HTTP-Request |
| `edupage_find_in_page` | `path`, `find` | Escape-Hatch: durchsucht eine Dashboard-Seite serverseitig nach einem Textausschnitt |

Nur Stundenplan und Anwesenheit sind als dedizierte Tools umgesetzt, weil deren Endpunkte reverse-engineert und
gegen echte Daten verifiziert sind. Für alles andere (Hausaufgaben, Noten, Nachrichten, ...) die Escape-Hatches
nutzen:

1. Edupage im Browser öffnen, Entwicklertools -> Netzwerk -> Filter auf `Fetch/XHR`.
2. Die gewünschte Ansicht öffnen (z. B. Hausaufgaben) und die abgefeuerten Requests inspizieren.
3. Requests mit `__func`/`__args` im JSON-Body -> `edupage_raw_call` mit `path`, `func`, `args` nachbauen.
4. Requests ohne dieses Muster (z. B. `/gcall`-Postbacks) -> `edupage_raw_request` mit `path`/`method`/`body`.
5. `edupage_find_in_page` hilft, in einer großen Dashboard-Seite die Stelle zu finden, mit welchen Parametern das
   echte Edupage-Frontend eine bestimmte RPC-Funktion aufruft.

Sobald ein Endpunkt sich bewährt hat, lohnt es sich, ihn als eigenes, sauber typisiertes Tool in `mcp-agent.ts`
nachzuziehen (siehe `edupage_get_timetable`/`edupage_get_attendance` als Vorlage).

## Setup & lokale Entwicklung

```bash
cd edupage-mcp
npm install
npm run dev
```

Keine Worker-Secrets nötig - die Edupage-Zugangsdaten landen über den OAuth-Flow verschlüsselt im KV-Namespace
`OAUTH_KV` (Binding in `wrangler.jsonc`), nicht als Secret. Zum lokalen Testen den vollen OAuth-Flow durchlaufen
(z. B. über den MCP Inspector oder `mcp-remote` gegen `http://localhost:8787/mcp`) - der Client wird automatisch
zu `/authorize` weitergeleitet.

## Deploy

```bash
npm run deploy
```

Benötigt einen KV-Namespace für `OAUTH_KV` (einmalig per `wrangler kv namespace create` anlegen und die `id` in
`wrangler.jsonc` eintragen).

## Als Custom Connector einbinden

Nach dem Deploy in claude.ai unter **Settings -> Connectors -> Add custom connector** die Worker-URL plus
`/mcp` eintragen, z. B.:

```
https://edupage-mcp.<dein-account>.workers.dev/mcp
```

Der Server meldet sich als OAuth-Authorization-Server (RFC 8414/9728-Metadaten, Dynamic Client Registration
unter `/register`) - Claude erkennt das automatisch und leitet beim Verbinden zu `/authorize` weiter. Dort einmal
Edupage-Domain, Benutzername und Passwort eingeben; die Session läuft danach serverseitig.

## CI/CD

`.github/workflows/deploy-edupage-mcp.yml` deployed bei Pushes auf `main` mit Änderungen unter `edupage-mcp/**`
(nicht bei reinen Pull Requests). Benötigte Repository-Secrets: `CLOUDFLARE_API_TOKEN` und
`CLOUDFLARE_ACCOUNT_ID`.

Änderungen laufen über Feature-Branch + Pull Request nach `main` - erst der Merge löst das automatische Deploy
aus, nicht schon das Öffnen des PRs.
