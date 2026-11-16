import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Die Adresse des Dienstes kann sich ändern (workers.dev, eigene Domain …). Deshalb darf im Code
// keine Domain fest eingetragen sein: Der Server liefert nur Pfade, absolute Adressen entstehen im
// Browser aus der aktuellen Adresse (siteUrl in public/api.js).
function files(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) return name === "fonts" ? [] : files(p);
		return /\.(ts|js|html|css|jsonc|json)$/.test(name) ? [p] : [];
	});
}

const SOURCES = [...files("src"), ...files("public"), "wrangler.jsonc"];

test("keine fest eingetragene Domain im Code", () => {
	const offenders: string[] = [];
	for (const f of SOURCES) {
		const text = readFileSync(f, "utf8");
		for (const m of text.matchAll(/workers\.dev|c-buessing|localhost|127\.0\.0\.1/g)) offenders.push(`${f}: ${m[0]}`);
		// absolute http(s)-Adressen nur als Beispiel/Validierung erlaubt, nie als Ziel
		for (const m of text.matchAll(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}/gi)) {
			if (!/w3\.org/.test(m[0])) offenders.push(`${f}: ${m[0]}`);
		}
	}
	assert.deepEqual(offenders, []);
});

test("absolute Adressen entstehen nur über siteUrl() im Browser", () => {
	const uses = SOURCES.filter((f) => f.startsWith("public")).filter((f) => /location\.(origin|host|hostname)/.test(readFileSync(f, "utf8")));
	assert.deepEqual(uses, ["public/api.js"], "window.location.origin darf nur in siteUrl() (public/api.js) verwendet werden");
});

test("der Server gibt keine absoluten Adressen aus", () => {
	for (const f of SOURCES.filter((x) => x.startsWith("src"))) {
		const text = readFileSync(f, "utf8");
		assert.ok(!/new URL\([^)]*\)\.origin|\.origin\b/.test(text), `${f}: Server darf keine eigene Origin ableiten/ausgeben`);
	}
});
