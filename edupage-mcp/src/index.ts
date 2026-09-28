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

		// McpAgent.serve()/.serveSSE() default to looking up a Durable Object
		// binding literally named "MCP_OBJECT" - ours is "MCP_AGENT" (see
		// wrangler.jsonc), so it must be passed explicitly here.
		if (url.pathname === "/sse" || url.pathname === "/sse/message") {
			return EdupageMcpAgent.serveSSE("/sse", { binding: "MCP_AGENT" }).fetch(request, env, ctx);
		}
		if (url.pathname === "/mcp") {
			return EdupageMcpAgent.serve("/mcp", { binding: "MCP_AGENT" }).fetch(request, env, ctx);
		}

		return new Response(
			"Edupage MCP Server.\n\nVerbinde dich über /mcp (Streamable HTTP, empfohlen) oder /sse (Legacy SSE). " +
				"Jeder Tool-Aufruf braucht domain/username/password als Parameter.\n",
			{ status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } },
		);
	},
} satisfies ExportedHandler<Env>;
