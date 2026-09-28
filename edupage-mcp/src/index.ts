import { EdupageMcpAgent } from "./mcp-agent";
import type { Env } from "./env";

export { EdupageMcpAgent };
export { EdupageSessionDO } from "./edupage/session-do";

function isAuthorized(request: Request, env: Env): boolean {
	// Ohne gesetztes MCP_AUTH_TOKEN bleibt der Endpunkt offen - praktisch für
	// lokale Entwicklung, aber vor dem Deploy sollte ein Token gesetzt werden
	// (siehe README), da hier persönliche Schuldaten abrufbar sind.
	if (!env.MCP_AUTH_TOKEN) return true;
	return request.headers.get("Authorization") === `Bearer ${env.MCP_AUTH_TOKEN}`;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		if (!isAuthorized(request, env)) {
			return new Response("Unauthorized", { status: 401 });
		}

		if (url.pathname === "/sse" || url.pathname === "/sse/message") {
			return EdupageMcpAgent.serveSSE("/sse").fetch(request, env, ctx);
		}
		if (url.pathname === "/mcp") {
			return EdupageMcpAgent.serve("/mcp").fetch(request, env, ctx);
		}

		return new Response(
			"Edupage MCP Server.\n\nVerbinde dich über /mcp (Streamable HTTP, empfohlen) oder /sse (Legacy SSE).\n",
			{ status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } },
		);
	},
} satisfies ExportedHandler<Env>;
