// Loads a page in headless Edge over the DevTools protocol and prints the
// exceptions thrown while it renders, including ones the client catches itself.
// usage: bun scripts/js-errors.ts [path] [seconds]
// Uses the signed-in browser profile left by scripts/probe.sh.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Git Bash rewrites an argument that starts with "/" into a Windows path, so the
// leading slash is optional: pass "pozo" for /pozo
const page = `/${(process.argv[2] ?? "home").replace(/^\/+/, "")}`;
const seconds = Number(process.argv[3] ?? 20);
const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const debugPort = 9377;
const EDGE = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
if (!EDGE) throw new Error("Edge not found");

const edge = spawn(EDGE, [
	"--headless=new",
	"--disable-gpu",
	"--no-first-run",
	`--remote-debugging-port=${debugPort}`,
	`--user-data-dir=${resolve(".probe/profile")}`,
	"about:blank",
]);

async function target(): Promise<string> {
	for (let i = 0; i < 50; i++) {
		try {
			const list: any[] = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
			const t = list.find((t) => t.type === "page");
			if (t) return t.webSocketDebuggerUrl;
		} catch {}
		await Bun.sleep(200);
	}
	throw new Error("browser did not start");
}

const ws = new WebSocket(await target());
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const send = (method: string, params: object = {}) => ws.send(JSON.stringify({ id: ++id, method, params }));

const seen = new Map<string, number>();
let pauses = 0;
let summaryId = 0;
// WHERE=<regex>: print the source around the throwing frame of matching exceptions
const where = process.env.WHERE ? new RegExp(process.env.WHERE) : undefined;
const pending = new Map<number, { line: number; col: number; text: string }>();
ws.addEventListener("message", (ev) => {
	const msg = JSON.parse(String(ev.data));
	const want = msg.id && pending.get(msg.id);
	if (want && msg.result?.scriptSource) {
		const line = msg.result.scriptSource.split(String.fromCharCode(10))[want.line] ?? "";
		console.log(`SOURCE for ${want.text}: ${line.slice(Math.max(0, want.col - 400), want.col)}<<HERE>>${line.slice(want.col, want.col + 200)}`);
	}
	if (msg.id && msg.id === summaryId) console.log(`page: ${msg.result?.result?.value}`);
	if (msg.error) console.log(`protocol error: ${JSON.stringify(msg.error)}`);
	if (msg.result?.errorText) console.log(`navigation failed: ${msg.result.errorText}`);
	if (msg.method !== "Debugger.paused") return;
	pauses++;
	const { reason, data, callFrames } = msg.params;
	if (reason === "exception" || reason === "promiseRejection") {
		const text = String(data?.description ?? data?.value ?? data?.className ?? "?").split("\n")[0];
		const frames = (callFrames as any[])
			.slice(0, 3)
			.map((f) => `${f.functionName || "(anonymous)"} ${String(f.url).split("/").pop()}:${f.location.lineNumber + 1}:${f.location.columnNumber}`)
			.join(" < ");
		const key = `${text}\n    at ${frames}`;
		seen.set(key, (seen.get(key) ?? 0) + 1);
			if (where?.test(text) && seen.get(key) === 1) {
				const f = callFrames[0];
				pending.set(++id, { line: f.location.lineNumber, col: f.location.columnNumber, text });
				ws.send(JSON.stringify({ id, method: "Debugger.getScriptSource", params: { scriptId: f.location.scriptId } }));
			}
	}
	send("Debugger.resume");
});

send("Debugger.enable");
send("Debugger.setPauseOnExceptions", { state: "all" });
send("Page.enable");
send("Page.navigate", { url: origin + page });
await Bun.sleep(seconds * 1000);

// where the page ended up, so a redirect or a healthy render is not mistaken for "no errors"
send("Runtime.evaluate", {
	expression: `location.pathname + " | " + document.title + " | failed=" + /Something went wrong/.test(document.body.innerText) + " | posts=" + document.querySelectorAll('[data-testid="tweet"]').length`,
	returnByValue: true,
});
summaryId = id;
await Bun.sleep(1500);
console.log(`debugger pauses: ${pauses}`);

// Noise: React re-invokes components without props to build a component stack
// after a failure, suspended renders throw promises, and the client probes URLs
// inside its own try/catch. The real failure is the first thing left, in order.
const NOISE = /DetermineComponentFrameRoot|^\d*x? ?Promise|React error #460|Invalid URL|^Error\n/;
const real = [...seen].filter(([key]) => !NOISE.test(key));
for (const [key, n] of real) console.log(`${n}x ${key}`);
if (!real.length) console.log(`no exceptions (${seen.size} kinds of noise filtered)`);
ws.close();
edge.kill();
process.exit(0);
