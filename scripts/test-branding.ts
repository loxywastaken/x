// The instance name in the client (patch.ts brandText) against the pinned build:
// every script file is branded with a name that is fine inside a string but a
// syntax error anywhere else, so a file that still parses had only strings changed.
// usage: bun test ./scripts/test-branding.ts

import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { brandText, patchText } from "../src/patch";

const ROOT = "client/abs";
const I18N = "/responsive-web/client-web/i18n/";
const files = existsSync(ROOT) ? [...new Bun.Glob("**/*.js").scanSync(ROOT)].map((p) => `/${p}`) : [];
const parse = new Bun.Transpiler({ loader: "js" });
const parses = (text: string) => {
	try {
		parse.transformSync(text);
		return true;
	} catch {
		return false;
	}
};

test("sentences", () => {
	expect(brandText(`o("a","Sign up for X"),o("b","X"),o("c","X’s rules")`, "Acme")).toBe(`o("a","Sign up for Acme"),o("b","Acme"),o("c","Acme’s rules")`);
	expect(brandText(`"Go to x.com or X.com, SpaceX, @X, X-Large, Mac OS X"`, "Acme")).toBe(`"Go to x.com or X.com, SpaceX, @X, X-Large, Mac OS X"`);
	expect(brandText(`"Say \\"hi\\" on X"`, `A"b`)).toBe(`"Say \\"hi\\" on A\\"b"`);
	expect(brandText(`"{name} on X"`, "Acme", true)).toBe(`"{name} on Acme"`);
	// in code only prose: not a lone value, not a span between two strings
	expect(brandText(`a("X"),b="a"+X+"b c d"`, "Acme", true)).toBe(`a("X"),b="a"+X+"b c d"`);
});

test.skipIf(!files.length)("only strings change in the pinned client", () => {
	const broken: string[] = [];
	let changed = 0;
	for (const path of files) {
		const raw = patchText(require("node:fs").readFileSync(ROOT + path, "utf8"), path.startsWith("/x-web/xchat/"));
		const out = brandText(raw, "%%%", !path.startsWith(I18N));
		if (out === raw) continue;
		changed++;
		if (!parses(out) && parses(raw)) broken.push(path);
	}
	expect(broken).toEqual([]);
	expect(changed).toBeGreaterThan(0);
}, 600_000);
