import type { EdupageMcpAgent } from "./mcp-agent";
import type { EdupageSessionDO } from "./edupage/session-do";

export interface Env {
	MCP_AGENT: DurableObjectNamespace<EdupageMcpAgent>;
	EDUPAGE_SESSION: DurableObjectNamespace<EdupageSessionDO>;
}
