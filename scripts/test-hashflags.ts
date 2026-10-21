// End-to-end check of branded hashtags (hashflags.ts) against a running
// server: an admin makes one, the client's /1.1/hashflags.json carries it,
// its files are served, and ending or deleting it takes it away.
// usage: bun scripts/test-hashflags.ts <admin> <user> <password of both>

export {};

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const [adminName, userName, password] = process.argv.slice(2);
if (!adminName || !userName || !password) throw new Error("usage: bun scripts/test-hashflags.ts <admin> <user> <password>");

let failed = 0;
const check = (ok: boolean, what: string, detail?: unknown) => {
	console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail === undefined ? "" : `: ${JSON.stringify(detail).slice(0, 300)}`}`);
	if (!ok) failed++;
};

async function session(username: string) {
	const r = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username, password }), redirect: "manual" });
	const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
	const csrf = cookies.find((c) => c.startsWith("ct0="))?.slice(4);
	if (!csrf) throw new Error(`login ${username} failed`);
	const headers = { cookie: cookies.join("; "), "x-csrf-token": csrf };
	const admin = async (action: string, body: object = {}) => {
		const res = await fetch(`${origin}/admin/api/${action}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
		return { status: res.status, ...(await res.json()) };
	};
	const flags = async () => (await fetch(`${origin}/i/api/1.1/hashflags.json`, { headers })).json();
	return { admin, flags };
}

const b64 = (s: string | Uint8Array) => Buffer.from(s).toString("base64");
// the smallest Lottie the check accepts, and a 1x1 PNG
const LOTTIE = JSON.stringify({ v: "5.8.1", fr: 60, ip: 0, op: 30, w: 100, h: 100, layers: [] });
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const tag = `brandtest${Date.now() % 1e6}`;
const now = Date.now();

const a = await session(adminName);
const u = await session(userName);

check((await a.admin("createHashflag", { hashtag: tag, starts_at: new Date(now - 60e3).toISOString(), ends_at: new Date(now + 3600e3).toISOString(), like_animation: b64('{"not":"lottie"}') })).status === 400, "a file that isn't Lottie is refused");
check((await a.admin("createHashflag", { hashtag: tag, starts_at: new Date(now).toISOString(), ends_at: new Date(now - 1).toISOString(), like_animation: b64(LOTTIE) })).status === 400, "it has to end after it starts");
check((await u.admin("createHashflag", { hashtag: tag, starts_at: new Date(now).toISOString(), ends_at: new Date(now + 3600e3).toISOString(), like_animation: b64(LOTTIE) })).status === 403, "only staff can make one");

const made = await a.admin("createHashflag", { hashtag: `#${tag}`, starts_at: new Date(now - 60e3).toISOString(), ends_at: new Date(now + 3600e3).toISOString(), like_animation: b64(LOTTIE), emoji: b64(PNG), hashfetti: true });
check(made.status === 200 && !!made.id, "an admin makes one", made);

const list = await u.flags();
const mine = list.find((f: any) => f.hashtag === tag);
check(!!mine, "the client's hashflags.json carries it", list.length);
check(mine?.animations?.[0]?.context === "Like" && /\/public\/hashflag-\d+\.json$/.test(mine.animations[0].assetUrl), "with a Like animation", mine?.animations);
check(/\/public\/hashflag-\d+\.png$/.test(mine?.assetUrl ?? "") && mine?.isHashfettiEnabled === true, "and its emoji with hashfetti", mine);
check(Number(mine?.startingTimestampMs) < now && Number(mine?.endingTimestampMs) > now, "and its times in ms");

const anim = await fetch(mine.animations[0].assetUrl.replace(/^https?:\/\/[^/]+/, origin));
check(anim.status === 200 && (await anim.json()).v === "5.8.1", "the animation is served");
const emoji = await fetch(mine.assetUrl.replace(/^https?:\/\/[^/]+/, origin));
check(emoji.status === 200 && emoji.headers.get("content-type") === "image/png", "the emoji is served");

await a.admin("endHashflag", { id: made.id });
check(!(await u.flags()).some((f: any) => f.hashtag === tag), "ending it takes it out");
await a.admin("deleteHashflag", { id: made.id });
const gone = await fetch(mine.animations[0].assetUrl.replace(/^https?:\/\/[^/]+/, origin));
check(gone.status === 404, "deleting it removes its files");

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
