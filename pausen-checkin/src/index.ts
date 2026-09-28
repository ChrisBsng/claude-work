import { Router } from "itty-router";
import { resolveBaseUrl } from "./baseUrl";
import type { Env } from "./env";
import { adminRouter } from "./routes/admin";
import { checkinRouter } from "./routes/checkin";
import { dashboardRouter } from "./routes/dashboard";
import { imagesRouter } from "./routes/images";

const router = Router();

router.get("/api/health", () => Response.json({ status: "ok" }));
// Öffentlich: teilt der Frontend-JS mit, welche Basis-URL für angezeigte
// Links verwendet werden soll (CUSTOM_DOMAIN, falls gesetzt).
router.get("/api/config", (request: Request, env: Env) => Response.json({ baseUrl: resolveBaseUrl(env, request) }));
router.all("/api/admin/*", adminRouter.fetch);
router.all("/api/checkin/*", checkinRouter.fetch);
router.all("/api/dashboard/*", dashboardRouter.fetch);
router.all("/api/images/*", imagesRouter.fetch);
router.all("/api/*", () => Response.json({ error: "Not found" }, { status: 404 }));
router.all("*", (request: Request, env: Env) => env.ASSETS.fetch(request));

export default {
	fetch: (request, env, ctx) => router.fetch(request, env, ctx),
} satisfies ExportedHandler<Env>;
