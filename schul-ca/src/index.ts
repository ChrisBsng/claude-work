import { Router } from "itty-router";
import type { Env } from "./env";
import { adminRouter } from "./routes/admin";
import { caRouter } from "./routes/ca";
import { studentRouter } from "./routes/student";

const router = Router();

router.get("/api/health", () => Response.json({ status: "ok" }));
router.all("/api/admin/*", adminRouter.fetch);
router.all("/api/student/*", studentRouter.fetch);
router.all("/api/ca/*", caRouter.fetch);
router.all("/api/*", () => Response.json({ error: "Not found" }, { status: 404 }));
router.all("*", (request: Request, env: Env) => env.ASSETS.fetch(request));

const SECURITY_HEADERS: Record<string, string> = {
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	"X-Frame-Options": "DENY",
	"Content-Security-Policy":
		"default-src 'self'; img-src 'self' data:; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

export default {
	fetch: async (request, env, ctx) => {
		if (!env.MASTER_SECRET || env.MASTER_SECRET.length < 16) {
			return Response.json({ error: "Server nicht konfiguriert: MASTER_SECRET fehlt oder ist zu kurz." }, { status: 500 });
		}
		let response: Response;
		try {
			response = await router.fetch(request, env, ctx);
		} catch (e) {
			console.error("Unhandled error", e);
			response = Response.json({ error: "Interner Fehler" }, { status: 500 });
		}
		const out = new Response(response.body, response);
		for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
		return out;
	},
} satisfies ExportedHandler<Env>;
