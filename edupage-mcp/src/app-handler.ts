import { AuthorizationError, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./env";
import type { EdupageCredentials } from "./edupage/session-do";
import { sessionKeyFor } from "./edupage/session-key";

type AppEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function renderLoginPage(opts: {
	handle: string;
	clientName: string;
	redirectHost: string;
	domain?: string;
	username?: string;
	error?: string;
}): string {
	const esc = escapeHtml;
	return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mit Edupage verbinden</title>
<style>
	body { font-family: system-ui, sans-serif; max-width: 28rem; margin: 3rem auto; padding: 0 1rem; color: #1a1a1a; }
	label { display: block; margin: 1rem 0 0.25rem; font-weight: 600; }
	input { width: 100%; box-sizing: border-box; padding: 0.5rem; font-size: 1rem; border: 1px solid #ccc; border-radius: 4px; }
	button { margin-top: 1.5rem; padding: 0.6rem 1.2rem; font-size: 1rem; border: none; border-radius: 4px; background: #2c6ecb; color: white; cursor: pointer; }
	.error { background: #fdecea; color: #b71c1c; padding: 0.75rem 1rem; border-radius: 4px; margin-top: 1rem; }
	.hint { color: #555; font-size: 0.85rem; margin-top: 0.25rem; }
</style>
<h1>Mit Edupage verbinden</h1>
<p><strong>${esc(opts.clientName || "Diese Anwendung")}</strong> möchte über diesen MCP-Server auf deine Edupage-Daten zugreifen (Stundenplan, Anwesenheit u. a.).
${opts.redirectHost ? `Der Zugriff wird an <strong>${esc(opts.redirectHost)}</strong> gesendet.` : ""}</p>
<p class="hint">Deine Edupage-Zugangsdaten werden verschlüsselt für diese Verbindung hinterlegt und nicht im Chat sichtbar.</p>
${opts.error ? `<div class="error">${esc(opts.error)}</div>` : ""}
<form method="post">
	<input type="hidden" name="handle" value="${esc(opts.handle)}">
	<input type="hidden" name="clientName" value="${esc(opts.clientName)}">
	<input type="hidden" name="redirectHost" value="${esc(opts.redirectHost)}">
	<label for="domain">Schul-Subdomain</label>
	<input id="domain" name="domain" required pattern="[a-zA-Z0-9-]{1,63}" placeholder="musterschule" value="${esc(opts.domain ?? "")}">
	<p class="hint">Nur die Subdomain, z. B. "musterschule" bei musterschule.edupage.org</p>
	<label for="username">Benutzername</label>
	<input id="username" name="username" required value="${esc(opts.username ?? "")}">
	<label for="password">Passwort</label>
	<input id="password" name="password" type="password" required autofocus>
	<button type="submit">Anmelden &amp; verbinden</button>
</form>`;
}

async function handleAuthorizeGet(request: Request, env: AppEnv): Promise<Response> {
	let oauthReq;
	try {
		oauthReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
	} catch (error) {
		if (error instanceof AuthorizationError && error.redirectTo) {
			return Response.redirect(error.redirectTo, 302);
		}
		const message = error instanceof AuthorizationError ? error.description : "Ungültige Autorisierungsanfrage.";
		return new Response(escapeHtml(message), { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
	}

	const details = await env.OAUTH_PROVIDER.describeConsent(oauthReq);
	const consent = await env.OAUTH_PROVIDER.beginConsent(oauthReq);
	consent.headers.set("Content-Type", "text/html; charset=utf-8");
	return new Response(
		renderLoginPage({ handle: consent.handle, clientName: details.clientName, redirectHost: details.redirectHost }),
		{ headers: consent.headers },
	);
}

async function handleAuthorizePost(request: Request, env: AppEnv): Promise<Response> {
	const form = await request.formData();
	const handle = String(form.get("handle") ?? "");
	const clientName = String(form.get("clientName") ?? "");
	const redirectHost = String(form.get("redirectHost") ?? "");
	const domain = String(form.get("domain") ?? "")
		.trim()
		.toLowerCase();
	const username = String(form.get("username") ?? "").trim();
	const password = String(form.get("password") ?? "");

	const fail = (message: string, status = 400) =>
		new Response(renderLoginPage({ handle, clientName, redirectHost, domain, username, error: message }), {
			status,
			headers: { "Content-Type": "text/html; charset=utf-8" },
		});

	if (!domain || !username || !password) {
		return fail("Bitte alle Felder ausfüllen.");
	}

	const credentials: EdupageCredentials = { domain, username, password };
	try {
		const key = await sessionKeyFor(domain, username);
		await env.EDUPAGE_SESSION.getByName(key).login(credentials);
	} catch (error) {
		return fail(error instanceof Error ? error.message : "Edupage-Login fehlgeschlagen.");
	}

	try {
		const approved = await env.OAUTH_PROVIDER.approveConsent(request, handle, { scope: ["edupage"] });
		const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
			request: approved.request,
			// userId darf laut Bibliothek keinen ":" enthalten (trennt intern
			// Token-/Storage-Key-Teile) - domain+username daher encoden statt
			// mit ":" zu verbinden.
			userId: encodeURIComponent(`${domain}:${username}`),
			metadata: { domain, username },
			scope: ["edupage"],
			props: credentials,
		});
		approved.headers.set("Location", redirectTo);
		return new Response(null, { status: 302, headers: approved.headers });
	} catch (error) {
		if (error instanceof AuthorizationError) {
			return fail(
				"Der Verbindungsvorgang ist abgelaufen oder wurde bereits verwendet. Bitte den Connector erneut verbinden.",
			);
		}
		throw error;
	}
}

export const appHandler = {
	// Der OAuthProvider ruft defaultHandler.fetch mit env auf, das zusätzlich
	// OAUTH_PROVIDER trägt (siehe workers-oauth-provider-README); der
	// Ziel-Typ von OAuthProviderOptions.defaultHandler erwartet aber nur
	// Env, daher hier auf AppEnv gecastet statt die Signatur zu verengen.
	async fetch(request: Request, rawEnv: Env): Promise<Response> {
		const env = rawEnv as AppEnv;
		const url = new URL(request.url);

		if (url.pathname === "/authorize" && request.method === "GET") {
			return handleAuthorizeGet(request, env);
		}
		if (url.pathname === "/authorize" && request.method === "POST") {
			return handleAuthorizePost(request, env);
		}
		if (url.pathname === "/") {
			return new Response(
				"Edupage MCP Server.\n\nVerbinde dich über deinen MCP-Client (z. B. Claude als Custom Connector). Beim " +
					"Verbinden wirst du automatisch nach deiner Edupage-Schul-Subdomain, Benutzername und Passwort " +
					"gefragt - danach läuft die Sitzung serverseitig, ohne dass Zugangsdaten im Chat erscheinen.\n",
				{ status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } },
			);
		}

		return new Response("Not found", { status: 404 });
	},
};
