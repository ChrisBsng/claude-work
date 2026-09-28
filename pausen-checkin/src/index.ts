import { Router } from "itty-router";
import type { Env } from "./env";
import { adminRouter } from "./routes/admin";
import { checkinRouter } from "./routes/checkin";
import { dashboardRouter } from "./routes/dashboard";
import { imagesRouter } from "./routes/images";

const router = Router();

router.get("/api/health", () => Response.json({ status: "ok" }));
router.all("/api/admin/*", adminRouter.fetch);
router.all("/api/checkin/*", checkinRouter.fetch);
router.all("/api/dashboard/*", dashboardRouter.fetch);
router.all("/api/images/*", imagesRouter.fetch);
router.all("/api/*", () => Response.json({ error: "Not found" }, { status: 404 }));
router.all("*", (request: Request, env: Env) => env.ASSETS.fetch(request));

export default {
	fetch: (request, env, ctx) => router.fetch(request, env, ctx),
} satisfies ExportedHandler<Env>;
