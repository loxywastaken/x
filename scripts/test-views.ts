// View counts: a post shown to another account counts once for it, never for
// its author. usage: bun scripts/test-views.ts <author> <viewer> <password>

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const [authorName, viewerName, password] = process.argv.slice(2);
if (!password) throw new Error("usage: bun scripts/test-views.ts <author> <viewer> <password>");

async function session(username: string) {
	const r = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username, password }), redirect: "manual" });
	const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
	const csrf = cookies.find((c) => c.startsWith("ct0="))?.slice(4);
	if (!csrf) throw new Error(`login ${username} failed`);
	const headers = { cookie: cookies.join("; "), "x-csrf-token": csrf };
	const gql = async (op: string, variables: object) =>
		(await fetch(`${origin}/i/api/graphql/q/${op}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ variables }) })).json();
	const get = async (op: string, variables: object) =>
		(await fetch(`${origin}/i/api/graphql/q/${op}?variables=${encodeURIComponent(JSON.stringify(variables))}`, { headers })).json();
	return { gql, get };
}
let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${JSON.stringify(detail)}`}`);
}
const views = async (s: Awaited<ReturnType<typeof session>>, id: string) =>
	(await s.get("TweetResultByRestId", { tweetId: id })).data?.tweetResult?.result?.views;

const author = await session(authorName);
const viewer = await session(viewerName);
const id = (await author.gql("CreateTweet", { tweet_text: `views test ${Date.now()}` })).data.create_tweet.tweet_results.result.rest_id;
try {
	await views(author, id);
	check("the author's own look doesn't count", (await views(author, id))?.state === "Enabled");
	await views(viewer, id);
	await new Promise((r) => setTimeout(r, 300));
	const first = await views(viewer, id);
	check("another account's look counts once", first?.count === "1" && first.state === "EnabledWithCount", first);
	await views(viewer, id);
	await new Promise((r) => setTimeout(r, 300));
	check("and only once", (await views(author, id))?.count === "1");
} finally {
	await author.gql("DeleteTweet", { tweet_id: id });
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
