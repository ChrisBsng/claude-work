import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { EdupageMcpAgent } from "./mcp-agent";
import { appHandler } from "./app-handler";
import type { Env } from "./env";

export { EdupageMcpAgent };
export { EdupageSessionDO } from "./edupage/session-do";

// McpAgent.serve()/.serveSSE() default to looking up a Durable Object binding
// named literally "MCP_OBJECT" - ours is "MCP_AGENT" (see wrangler.jsonc), so
// it must be passed explicitly here.
const apiHandler = {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/sse" || url.pathname === "/sse/message") {
			return EdupageMcpAgent.serveSSE("/sse", { binding: "MCP_AGENT" }).fetch(request, env, ctx);
		}
		return EdupageMcpAgent.serve("/mcp", { binding: "MCP_AGENT" }).fetch(request, env, ctx);
	},
};

// Authentifizierung läuft jetzt über OAuth: beim Verbinden des Connectors
// fragt /authorize (siehe app-handler.ts) einmalig nach Edupage-Domain,
// Benutzername und Passwort, prüft sie live gegen Edupage und hinterlegt sie
// verschlüsselt als Grant-Props. Die eigentlichen MCP-Tools (siehe
// mcp-agent.ts) lesen die Zugangsdaten aus this.props - es müssen keine
// Zugangsdaten mehr im Chat/als Tool-Parameter übergeben werden.
export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const origin = new URL(request.url).origin;
		const provider = new OAuthProvider<Env>({
			apiRoute: ["/mcp", "/sse"],
			apiHandler,
			defaultHandler: appHandler,
			authorizeEndpoint: "/authorize",
			tokenEndpoint: "/token",
			clientRegistrationEndpoint: "/register",
			scopesSupported: ["edupage"],
			requiredScopes: ["edupage"],
			// Bare origin (statt z. B. "${origin}/mcp") als Resource, damit sowohl
			// /mcp (Streamable HTTP) als auch /sse (Legacy SSE) unter demselben
			// Audience-Wert geschützt sind - beide müssen Abkömmlinge der
			// resourceMetadata.resource sein.
			resourceMetadata: {
				resource: origin,
				authorization_servers: [origin],
				resource_name: "Edupage",
			},
		});
		return provider.fetch(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
