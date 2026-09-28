import type { EdupageMcpAgent } from "./mcp-agent";
import type { EdupageSessionDO } from "./edupage/session-do";

export interface Env {
	MCP_AGENT: DurableObjectNamespace<EdupageMcpAgent>;
	EDUPAGE_SESSION: DurableObjectNamespace<EdupageSessionDO>;

	// Zugangsdaten für den Edupage-Login, per `wrangler secret put` gesetzt.
	EDUPAGE_SUBDOMAIN: string;
	EDUPAGE_USERNAME: string;
	EDUPAGE_PASSWORD: string;

	// Optionales Bearer-Token, das MCP-Clients im Authorization-Header
	// mitschicken müssen. Ohne gesetztes Secret ist der Endpunkt offen
	// erreichbar - siehe README.
	MCP_AUTH_TOKEN?: string;
}
