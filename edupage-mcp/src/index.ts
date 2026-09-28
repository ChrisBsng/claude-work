import { EdupageMcpAgent } from "./mcp-agent";
import type { Env } from "./env";

export { EdupageMcpAgent };
export { EdupageSessionDO } from "./edupage/session-do";

// Bewusst kein Auth-Gate: der Server ist als generischer, öffentlicher
// MCP-Server für beliebige Edupage-Nutzer gedacht - jeder Tool-Aufruf
// bringt seine eigenen Edupage-Zugangsdaten mit (siehe mcp-agent.ts). Die
// eigentliche Zugriffskontrolle passiert also bei Edupage selbst, nicht
// hier am Worker.
export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/sse" || url.pathname === "/sse/message") {
			return EdupageMcpAgent.serveSSE("/sse").fetch(request, env, ctx);
		}
		if (url.pathname === "/mcp") {
			return EdupageMcpAgent.serve("/mcp").fetch(request, env, ctx);
		}

		return new Response(
			"Edupage MCP Server.\n\nVerbinde dich über /mcp (Streamable HTTP, empfohlen) oder /sse (Legacy SSE). " +
				"Jeder Tool-Aufruf braucht domain/username/password als Parameter.\n",
			{ status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } },
		);
	},
} satisfies ExportedHandler<Env>;
