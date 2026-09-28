# edupage-mcp

Ein generischer **MCP-Server** für [Edupage](https://edupage.org), deployed als Cloudflare Worker. Einmal
deployed, kann ihn jeder Edupage-Nutzer verwenden - Domain, Benutzername und Passwort werden bei **jedem
Tool-Aufruf** mitgegeben, nicht serverseitig konfiguriert. Der Server selbst kennt also keine Zugangsdaten und
speichert nur eine kurzlebige Session (Cookie + CSRF-Token) pro Domain+Benutzername-Paar, um nicht bei jedem
Aufruf neu einloggen zu müssen.

## Wichtige Hinweise

- Edupage hat **keine offizielle, dokumentierte API**. Login und Datenabruf basieren auf reverse-engineerten
  internen Endpunkten (dem `__func`/`__args`/`__gsh`-RPC-Muster, das auch andere inoffizielle Edupage-Clients
  nutzen). Das kann brechen, wenn Edupage sein Seitenlayout ändert.
- Der Worker ist **bewusst ohne eigenes Auth-Gate** deployt (siehe `src/index.ts`) - jeder, der die URL kennt,
  kann ihn ansprechen, muss dafür aber gültige Edupage-Zugangsdaten mitschicken. Die eigentliche Zugriffskontrolle
  liegt also bei Edupage, nicht am Worker. Passwörter werden nur transient für den Login verwendet und nie in
  Durable-Object-Storage persistiert (dort landen nur Cookie + CSRF-Token).
- Die Nutzung eines inoffiziellen Zugriffswegs kann je nach Schule/Edupage-Vertrag gegen die Nutzungsbedingungen
  verstoßen - das hier ist für den persönlichen Gebrauch mit den eigenen Zugangsdaten gedacht.

## Architektur

- **`EdupageSessionDO`** (Durable Object, `src/edupage/session-do.ts`): hält Login-Cookie + CSRF-Token
  (`gsechash`) für eine Domain+Benutzername-Kombination. Adressiert wird das Objekt über einen SHA-256-Hash aus
  `domain+username` (`EdupageMcpAgent.sessionFor`), damit dieselben Zugangsdaten immer auf dieselbe gecachte
  Session treffen, ohne dass Cloudflare-Logs Klartext-Benutzernamen als DO-Namen sehen. Die `domain` wird streng
  gegen ein Subdomain-Muster (`^[a-z0-9-]{1,63}$`) validiert, damit sie nicht als Host-Injection missbraucht
  werden kann.
- **`EdupageMcpAgent`** (`src/mcp-agent.ts`): der eigentliche MCP-Server (Cloudflare Agents SDK, `agents/mcp`),
  registriert die Tools. Jedes Tool erwartet `domain`, `username`, `password` (außer `edupage_logout`, das nur
  `domain`+`username` braucht) und ruft damit `EdupageSessionDO` per Durable-Object-RPC auf.
- **`src/index.ts`**: Worker-Entry-Point, routet `/mcp` (Streamable HTTP) und `/sse` (Legacy SSE) zum MCP-Agent.

## Tools

| Tool | Parameter | Beschreibung |
| --- | --- | --- |
| `edupage_login` | `domain`, `username`, `password` | Loggt ein / erneuert die Session (optional - andere Tools loggen bei Bedarf automatisch ein) |
| `edupage_logout` | `domain`, `username` | Löscht die gespeicherte Session |
| `edupage_get_timetable` | `domain`, `username`, `password`, `dateFrom?`, `dateTo?` | Stundenplan für einen Datumsbereich |
| `edupage_raw_call` | `domain`, `username`, `password`, `path`, `func`, `args?` | Escape-Hatch: beliebige interne `__func`/`__args`-RPC-Funktion |
| `edupage_raw_request` | `domain`, `username`, `password`, `path`, `method?`, `body?` | Escape-Hatch: beliebiger authentifizierter HTTP-Request |

`domain` ist die Subdomain vor `.edupage.org` (z. B. `musterschule` bei `musterschule.edupage.org`), ohne Punkte
oder Protokoll.

Nur der Stundenplan ist als dediziertes Tool umgesetzt, weil dessen Endpunkt (`curenttt.js` /
`curentttGetData`) über mehrere inoffizielle Edupage-Clients hinweg stabil dokumentiert ist. Für alles andere
(Hausaufgaben, Noten, Nachrichten, ...) die beiden Escape-Hatches nutzen:

1. Edupage im Browser öffnen, Entwicklertools -> Netzwerk -> Filter auf `Fetch/XHR`.
2. Die gewünschte Ansicht öffnen (z. B. Hausaufgaben) und die abgefeuerten Requests inspizieren.
3. Requests mit `__func`/`__args` im JSON-Body -> `edupage_raw_call` mit `path`, `func`, `args` nachbauen.
4. Requests ohne dieses Muster -> `edupage_raw_request` mit `path`/`method`/`body`.

Sobald ein Endpunkt sich bewährt hat, lohnt es sich, ihn als eigenes, sauber typisiertes Tool in `mcp-agent.ts`
nachzuziehen (siehe `edupage_get_timetable` als Vorlage).

## Setup & lokale Entwicklung

```bash
cd edupage-mcp
npm install
npm run dev
```

Keine Secrets nötig - Zugangsdaten kommen ja pro Tool-Aufruf. Zum Testen im MCP Inspector oder über `mcp-remote`
gegen `http://localhost:8787/mcp` verbinden und beim Tool-Aufruf `domain`/`username`/`password` mitgeben.

## Deploy

```bash
npm run deploy
```

Keine `wrangler secret put`-Schritte nötig, der Worker braucht keine Secrets mehr.

## Als Custom Connector einbinden

Nach dem Deploy in claude.ai unter **Settings -> Connectors -> Add custom connector** die Worker-URL plus
`/mcp` eintragen, z. B.:

```
https://edupage-mcp.<dein-account>.workers.dev/mcp
```

Da der Server kein eigenes Auth-Gate hat, ist keine OAuth-/Token-Konfiguration im Connector nötig. Beim
Tool-Aufruf fragt Claude dann nach `domain`/`username`/`password` (oder du hinterlegst sie im Gespräch), die bei
jedem Aufruf mitgeschickt werden.

## CI/CD

`.github/workflows/deploy-edupage-mcp.yml` deployed bei Pushes auf `main` mit Änderungen unter `edupage-mcp/**`.
Benötigte Repository-Secrets: nur noch `CLOUDFLARE_API_TOKEN` und `CLOUDFLARE_ACCOUNT_ID`.
