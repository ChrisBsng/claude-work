import { Router, type IRequest } from "itty-router";
import type { Env } from "../env";

// Öffentlich erreichbar (nur Logos, keine sensiblen Daten) – wird direkt
// als <img src> von Dashboard-/Check-in-Seiten geladen. Jede id ist
// unveränderlich, daher aggressiv cachebar.
export const imagesRouter = Router({ base: "/api/images" });

imagesRouter.get("/:id", async (request: IRequest, env: Env) => {
	const object = await env.IMAGES.get(request.params.id);
	if (!object) {
		return new Response("Not found", { status: 404 });
	}
	return new Response(object.body, {
		headers: {
			"Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
			"Cache-Control": "public, max-age=31536000, immutable",
		},
	});
});
