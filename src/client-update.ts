// Admin > Client: re-pin the client to the build x.com serves now, as
// `bun scripts/fetch-client.ts --latest` does, keeping the previous pin to go
// back to. The guest page is what can be fetched without an account, so a pin
// taken with --token loses its signed-in feature switches here.

import { copyFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { BUILD_FILE, RUNTIME_FILE, loadBuild, reloadBuild } from "./build";
import { CLIENT_DIR, getClientFile } from "./client-cache";
import { brandText, clearPatchCache, patchText } from "./patch";

const PREVIOUS = { build: join(CLIENT_DIR, "build.previous.json"), runtime: join(CLIENT_DIR, "runtime.previous.js") };
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

export function clientStatus() {
	const b = loadBuild()?.build;
	const previous = existsSync(PREVIOUS.build) ? (JSON.parse(readFileSync(PREVIOUS.build, "utf8")) as { sha: string; fetchedAt: string }) : null;
	return { sha: b?.sha ?? null, fetchedAt: b?.fetchedAt ?? null, previous: previous && { sha: previous.sha, fetchedAt: previous.fetchedAt } };
}

export async function latestSha(): Promise<string> {
	const html = await (await fetch("https://x.com/i/tweetdeck", { headers: { "user-agent": UA } })).text();
	const sha = /window\.__META_DATA__=\{.*?"sha":"([0-9a-f]{40})"/s.exec(html)?.[1];
	if (!sha) throw new Error("x.com didn't return the client page.");
	return sha;
}

// the entry scripts must still parse once patched and branded (patch.ts)
async function entryScriptsParse(): Promise<string | undefined> {
	const build = loadBuild()?.build;
	if (!build) return "no build pinned";
	const parser = new Bun.Transpiler({ loader: "js" });
	for (const path of build.scripts) {
		const raw = await getClientFile(path);
		if (!raw) return `${path} couldn't be downloaded`;
		try {
			parser.transformSync(brandText(patchText(raw.toString("utf8")), "%%%", !path.includes("/i18n/")));
		} catch {
			return `${path} doesn't parse once branded`;
		}
	}
}

function swap(from: { build: string; runtime: string }, to: { build: string; runtime: string }) {
	copyFileSync(from.build, to.build);
	copyFileSync(from.runtime, to.runtime);
}

function reload() {
	reloadBuild();
	clearPatchCache();
}

let busy = false;

export async function updateClient(): Promise<{ sha: string; changed: boolean }> {
	if (busy) throw new Error("An update is already running.");
	busy = true;
	const before = loadBuild()?.build.sha ?? null;
	const current = { build: BUILD_FILE, runtime: RUNTIME_FILE };
	const kept = existsSync(BUILD_FILE) && existsSync(RUNTIME_FILE);
	const backup = { build: `${BUILD_FILE}.updating`, runtime: `${RUNTIME_FILE}.updating` };
	try {
		if (kept) swap(current, backup);
		const run = Bun.spawn([process.execPath, join(import.meta.dir, "../scripts/fetch-client.ts"), "--latest"], { stdout: "pipe", stderr: "pipe" });
		const [code, out, err] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()]);
		if (code !== 0) throw new Error(`fetch-client failed: ${(err || out).trim().split("\n").pop()}`);
		reload();
		const sha = loadBuild()?.build.sha ?? "";
		if (sha === before) return { sha, changed: false };
		const broken = await entryScriptsParse();
		if (broken) throw new Error(`The new build was not kept: ${broken}.`);
		if (kept) swap(backup, PREVIOUS);
		return { sha, changed: true };
	} catch (e) {
		if (kept) swap(backup, current);
		reload();
		throw e;
	} finally {
		for (const f of Object.values(backup)) if (existsSync(f)) unlinkSync(f);
		busy = false;
	}
}

// the previous pin and the current one trade places
export function rollbackClient(): string {
	if (busy) throw new Error("An update is running.");
	if (!existsSync(PREVIOUS.build) || !existsSync(PREVIOUS.runtime)) throw new Error("There is no previous build.");
	const temp = { build: `${BUILD_FILE}.swap`, runtime: `${RUNTIME_FILE}.swap` };
	swap({ build: BUILD_FILE, runtime: RUNTIME_FILE }, temp);
	swap(PREVIOUS, { build: BUILD_FILE, runtime: RUNTIME_FILE });
	swap(temp, PREVIOUS);
	for (const f of Object.values(temp)) unlinkSync(f);
	reload();
	return loadBuild()?.build.sha ?? "";
}
