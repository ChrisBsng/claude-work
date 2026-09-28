# edupage-mcp

Ein custom **MCP-Server** für [Edupage](https://edupage.org), deployed als Cloudflare Worker. Loggt sich mit
Benutzername/Passwort ein und stellt die Daten (aktuell: Stundenplan, plus generische Escape-Hatches) als MCP-Tools
bereit, z. B. für Claude Desktop, claude.ai oder andere MCP-Clients.

## Wichtiger Hinweis

Edupage hat **keine offizielle, dokumentierte API**. Login und Datenabruf basieren auf reverse-engineerten
internen Endpunkten (dem `__func`/`__args`/`__gsh`-RPC-Muster, das auch andere inoffizielle Edupage-Clients nutzen).
Das kann brechen, wenn Edupage sein Seitenlayout ändert, und die Nutzung eines inoffiziellen Zugriffswegs kann je
nach Schule/Edupage-Vertrag gegen die Nutzungsbedingungen verstoßen - das hier ist für den persönlichen Gebrauch mit
den eigenen Zugangsdaten gedacht.

## Architektur

- **`EdupageSessionDO`** (Durable Object, `src/edupage/session-do.ts`): hält Login-Cookie + CSRF-Token (`gsechash`)
  persistent über mehrere MCP-Verbindungen hinweg, damit sich nicht jede Anfrage neu einloggen muss. Wird als ein
  einzelnes, namentlich adressiertes Objekt (`getByName("singleton")`) angesprochen.
- **`EdupageMcpAgent`** (`src/mcp-agent.ts`): der eigentliche MCP-Server (Cloudflare Agents SDK, `agents/mcp`),
  registriert die Tools und ruft dafür `EdupageSessionDO` per Durable-Object-RPC auf.
- **`src/index.ts`**: Worker-Entry-Point, routet `/mcp` (Streamable HTTP) und `/sse` (Legacy SSE) zum MCP-Agent, plus
  ein simpler Bearer-Token-Check.

## Tools

| Tool | Beschreibung |
| --- | --- |
| `edupage_login` | Loggt sich mit den konfigurierten Zugangsdaten ein / erneuert die Session |
| `edupage_logout` | Löscht die gespeicherte Session |
| `edupage_get_timetable` | Stundenplan für einen Datumsbereich |
| `edupage_raw_call` | Escape-Hatch: beliebige interne `__func`/`__args`-RPC-Funktion aufrufen |
| `edupage_raw_request` | Escape-Hatch: beliebiger authentifizierter HTTP-Request an den Edupage-Host |

Nur der Stundenplan ist als dediziertes Tool umgesetzt, weil dessen Endpunkt (`curenttt.js` /
`curentttGetData`) über mehrere inoffizielle Edupage-Clients hinweg stabil dokumentiert ist. Für alles andere
(Hausaufgaben, Noten, Nachrichten, ...) die beiden Escape-Hatches nutzen:

1. Edupage im Browser öffnen, Entwicklertools -> Netzwerk -> Filter auf `Fetch/XHR`.
2. Die gewünschte Ansicht öffnen (z. B. Hausaufgaben) und die abgefeuerten Requests inspizieren.
3. Requests mit `__func`/`__args` im JSON-Body -> `edupage_raw_call` mit `path`, `func`, `args` nachbauen.
4. Requests ohne dieses Muster -> `edupage_raw_request` mit `path`/`method`/`body`.

Sobald ein Endpunkt sich bewährt hat, lohnt es sich, ihn als eigenes, sauber typisiertes Tool in `mcp-agent.ts`
nachzuziehen (siehe `edupage_get_timetable` als Vorlage).

## Setup

```bash
cd edupage-mcp
npm install
cp .dev.vars.example .dev.vars
# .dev.vars mit EDUPAGE_SUBDOMAIN / EDUPAGE_USERNAME / EDUPAGE_PASSWORD befüllen
npm run dev
```

`EDUPAGE_SUBDOMAIN` ist der Teil vor `.edupage.org` in der Schul-URL (z. B. `musterschule` bei
`musterschule.edupage.org`).

## Deploy

```bash
npx wrangler secret put EDUPAGE_SUBDOMAIN
npx wrangler secret put EDUPAGE_USERNAME
npx wrangler secret put EDUPAGE_PASSWORD
npx wrangler secret put MCP_AUTH_TOKEN   # empfohlen, siehe unten
npm run deploy
```

### MCP_AUTH_TOKEN

Der Worker liefert persönliche Schuldaten aus und hat sonst keinen Auth-Mechanismus. Ohne gesetztes
`MCP_AUTH_TOKEN` ist der Endpunkt für jeden erreichbar, der die Worker-URL kennt. Vor dem Deploy also ein
zufälliges Token setzen (z. B. `openssl rand -hex 32`) und beim Verbinden als `Authorization: Bearer <token>`
mitschicken. Für einen einzelnen Nutzer ist das ausreichend; für claude.ai-Custom-Connectors mit echtem OAuth
bräuchte es zusätzlich `@cloudflare/workers-oauth-provider` - dafür gibt es Cloudflares "Remote MCP + OAuth"
Guide als Ausgangspunkt.

## Verbinden

Mit [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) (z. B. in der Claude-Desktop-`config.json` oder für
lokale Tests):

```bash
npx mcp-remote https://edupage-mcp.<dein-account>.workers.dev/mcp \
  --header "Authorization: Bearer <dein-MCP_AUTH_TOKEN>"
```

## CI/CD

`.github/workflows/deploy-edupage-mcp.yml` deployed bei Pushes auf `main` mit Änderungen unter `edupage-mcp/**`.
Benötigte Repository-Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `EDUPAGE_SUBDOMAIN`,
`EDUPAGE_USERNAME`, `EDUPAGE_PASSWORD`, `MCP_AUTH_TOKEN`.
