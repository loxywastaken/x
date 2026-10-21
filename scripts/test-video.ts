// End-to-end check of video uploads against a running server: chunked upload,
// processing status, the post's video entity, seeking by byte range, and a file
// that is not a video. Needs ffmpeg to make the test clip.
// usage: bun scripts/test-video.ts <user> <password>

import { mkdirSync, readFileSync } from "node:fs";

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const [user, password] = process.argv.slice(2);
if (!user || !password) throw new Error("usage: bun scripts/test-video.ts <user> <password>");

const login = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username: user, password }), redirect: "manual" });
const cookies = login.headers.getSetCookie().map((c) => c.split(";")[0]);
const csrf = cookies.find((c) => c.startsWith("ct0="))?.slice(4);
if (!csrf) throw new Error(`login failed (${login.status})`);
const headers = { cookie: cookies.join("; "), "x-csrf-token": csrf };

let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}

// a 4-second 640x360 WebM with sound, so the server has to convert it
mkdirSync(".probe", { recursive: true });
const clip = ".probe/test-clip.webm";
const ff = Bun.spawn(
	["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=25:duration=4", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-c:v", "libvpx-vp9", "-b:v", "300k", "-c:a", "libopus", clip],
	{ stdout: "ignore", stderr: "inherit" },
);
if ((await ff.exited) !== 0) throw new Error("ffmpeg could not make the test clip");

const call = async (query: string, body?: FormData) => fetch(`${origin}/i/media/upload.json?${query}`, { method: "POST", headers, body });

async function upload(data: Uint8Array, type: string): Promise<{ id: string; finalize: any }> {
	const init = await (await call(`command=INIT&total_bytes=${data.length}&media_type=${type}&media_category=tweet_video`)).json();
	const id = init.media_id_string;
	const size = Math.ceil(data.length / 3);
	for (let i = 0; i < 3; i++) {
		const form = new FormData();
		form.set("media", new Blob([data.subarray(i * size, (i + 1) * size)]));
		const r = await call(`command=APPEND&media_id=${id}&segment_index=${i}`, form);
		if (r.status !== 204) throw new Error(`APPEND ${i}: ${r.status} ${await r.text()}`);
	}
	return { id, finalize: await (await call(`command=FINALIZE&media_id=${id}`)).json() };
}

async function waitFor(id: string) {
	const seen: string[] = [];
	for (let i = 0; i < 120; i++) {
		const s = await (await fetch(`${origin}/i/media/upload.json?command=STATUS&media_id=${id}`, { headers })).json();
		const state = s.processing_info?.state;
		if (!seen.includes(state)) seen.push(state);
		if (state === "succeeded" || state === "failed") return { state, seen, info: s.processing_info };
		await Bun.sleep(500);
	}
	return { state: "timeout", seen, info: undefined };
}

const video = await upload(readFileSync(clip), "video/webm");
check("FINALIZE reports processing", video.finalize.processing_info?.state === "pending", video.finalize.processing_info);
const done = await waitFor(video.id);
check("STATUS ends in succeeded", done.state === "succeeded", done.seen);

const gql = async (op: string, variables: object) =>
	(await fetch(`${origin}/i/api/graphql/q/${op}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ variables }) })).json();
const created = await gql("CreateTweet", { tweet_text: "video test", media: { media_entities: [{ media_id: video.id, tagged_users: [] }], possibly_sensitive: false } });
const post = created.data?.create_tweet?.tweet_results?.result;
const entity = post?.legacy?.extended_entities?.media?.[0];
check("post carries a video entity", entity?.type === "video" && entity.media_key === `7_${video.id}`, entity?.type);
check("video is 640x360, 16:9, about 4 s", entity?.original_info?.width === 640 && entity.video_info?.aspect_ratio?.join(":") === "16:9" && Math.abs(entity.video_info.duration_millis - 4000) < 300, {
	size: [entity?.original_info?.width, entity?.original_info?.height],
	aspect: entity?.video_info?.aspect_ratio,
	ms: entity?.video_info?.duration_millis,
});

const mp4Url = entity?.video_info?.variants?.[0]?.url ?? "";
const whole = await fetch(mp4Url, { headers });
const bytes = new Uint8Array(await whole.arrayBuffer());
check("MP4 is served", whole.status === 200 && whole.headers.get("content-type") === "video/mp4" && new TextDecoder().decode(bytes.subarray(4, 8)) === "ftyp", whole.status);
const part = await fetch(mp4Url, { headers: { ...headers, range: "bytes=100-199" } });
check("byte range answered", part.status === 206 && (await part.arrayBuffer()).byteLength === 100 && part.headers.get("content-range") === `bytes 100-199/${bytes.length}`, part.headers.get("content-range"));
const poster = await fetch(entity?.media_url_https ?? "", { headers });
check("poster image is served", poster.status === 200 && poster.headers.get("content-type") === "image/jpeg", poster.status);

// what the compose box does: the whole file as one APPENDMULTI with its MD5
const data = readFileSync(clip);
const md5 = new Bun.CryptoHasher("md5").update(data).digest("hex");
async function appendMulti(id: string, sum: string) {
	const form = new FormData();
	form.set("media", new Blob([data]));
	return call(`command=APPENDMULTI&media_id=${id}&segment_indexes=0&max_segment_size=${data.length}&media_md5=${sum}`, form);
}
const multi = (await (await call(`command=INIT&total_bytes=${data.length}&media_type=video/webm&media_category=amplify_video`)).json()).media_id_string;
check("APPENDMULTI with a wrong checksum is refused", (await appendMulti(multi, "0".repeat(32))).status === 400);
check("APPENDMULTI with the right checksum is taken", (await appendMulti(multi, md5)).status === 204);
await call(`command=FINALIZE&media_id=${multi}&allow_async=true`);
check("APPENDMULTI upload is processed", (await waitFor(multi)).state === "succeeded");

const junk = await upload(new TextEncoder().encode("this is not a video at all, just text".repeat(20)), "video/mp4");
const junkDone = await waitFor(junk.id);
check("a file that is not a video fails processing", junkDone.state === "failed", junkDone.info?.error?.message);
const junkPost = await gql("CreateTweet", { tweet_text: "should have no media", media: { media_entities: [{ media_id: junk.id, tagged_users: [] }], possibly_sensitive: false } });
const junkResult = junkPost.data?.create_tweet?.tweet_results?.result;
check("a failed upload is not attached", !junkResult?.legacy?.extended_entities);

// clean up
// KEEP=1 leaves the video post up, for looking at it in the client
if (post?.rest_id && !process.env.KEEP) await gql("DeleteTweet", { tweet_id: post.rest_id });
else if (post?.rest_id) console.log(`kept /${user}/status/${post.rest_id}`);
if (junkResult?.rest_id) await gql("DeleteTweet", { tweet_id: junkResult.rest_id });

console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);
