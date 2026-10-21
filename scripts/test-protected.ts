// End-to-end check of protected accounts: follow requests, who sees posts,
// reposting, going public. Restores both accounts.
// usage: bun scripts/test-protected.ts <viewer> <protected user> <password of both>

export {};

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const [nameA, nameB, password] = process.argv.slice(2);
if (!nameA || !nameB || !password) throw new Error("usage: bun scripts/test-protected.ts <viewer> <protected user> <password>");

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
	const form = async (path: string, body: Record<string, string> = {}) =>
		(await fetch(`${origin}/i/api${path}`, { method: "POST", headers, body: new URLSearchParams(body) })).json();
	const rest = async (path: string) => (await fetch(`${origin}/i/api${path}`, { headers })).json();
	return { gql, get, form, rest };
}

let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${JSON.stringify(detail)}`}`);
}

const entriesOf = (timeline: any): any[] => (timeline?.instructions ?? []).flatMap((i: any) => i.entries ?? []);
const tweetIds = (entries: any[]) => entries.map((e) => e.content?.itemContent?.tweet_results?.result?.rest_id).filter(Boolean);

const a = await session(nameA);
const b = await session(nameB);
const userB = (await a.get("UserByScreenName", { screen_name: nameB })).data.user.result;
const userA = (await b.get("UserByScreenName", { screen_name: nameA })).data.user.result;
await a.form("/1.1/friendships/destroy.json", { user_id: userB.rest_id });

const post = (await b.gql("CreateTweet", { tweet_text: "protected words" })).data.create_tweet.tweet_results.result.rest_id;
const publicSeen = tweetIds(entriesOf((await a.get("UserOriginalsTimeline", { userId: userB.rest_id, count: 20 })).data.user.result.timeline.timeline));
check("a public account's post is visible to a stranger", publicSeen.includes(post));

const settings = await b.form("/1.1/account/settings.json", { protected: "true" });
check("settings: protect your posts", settings.protected === true);
const asA = (await a.get("UserByScreenName", { screen_name: nameB })).data.user.result;
check("the profile says protected", asA.privacy?.protected === true);

const profile = tweetIds(entriesOf((await a.get("UserOriginalsTimeline", { userId: userB.rest_id, count: 20 })).data.user.result.timeline.timeline));
check("a stranger sees no posts on the profile", !profile.includes(post));
const direct = await a.get("TweetResultByRestId", { tweetId: post });
check("nor the post by its id", !direct.data?.tweetResult?.result?.legacy);
const home = tweetIds(entriesOf((await a.get("HomeTimeline", { count: 50 })).data.home.home_timeline_urt));
check("nor in the home feed", !home.includes(post));
const rt = await a.gql("CreateRetweet", { tweet_id: post });
check("reposting it is refused", !!rt.errors?.length);

const asked = await a.form("/1.1/friendships/create.json", { user_id: userB.rest_id });
check("following asks instead", asked.follow_request_sent === true && asked.following === false, { sent: asked.follow_request_sent, following: asked.following });
const incoming = await b.rest("/1.1/friendships/incoming.json");
check("the owner sees the request", incoming.ids?.includes(userA.rest_id));
const still = tweetIds(entriesOf((await a.get("UserOriginalsTimeline", { userId: userB.rest_id, count: 20 })).data.user.result.timeline.timeline));
check("a pending request shows nothing yet", !still.includes(post));

const accepted = await b.form("/1.1/friendships/accept.json", { user_id: userA.rest_id });
check("accept", accepted.followed_by === true || accepted.screen_name === nameA, accepted.followed_by);
const nowSeen = tweetIds(entriesOf((await a.get("UserOriginalsTimeline", { userId: userB.rest_id, count: 20 })).data.user.result.timeline.timeline));
check("an approved follower sees the posts", nowSeen.includes(post));
const homeAfter = tweetIds(entriesOf((await a.get("HomeLatestTimeline", { count: 50 })).data.home.home_timeline_urt));
check("and they reach the Following feed", homeAfter.includes(post));
const rtOk = await a.gql("CreateRetweet", { tweet_id: post });
check("reposts are still refused for an approved follower", !!rtOk.errors?.length);

// deny and cancel
await a.form("/1.1/friendships/destroy.json", { user_id: userB.rest_id });
await a.form("/1.1/friendships/create.json", { user_id: userB.rest_id });
const cancelled = await a.form("/1.1/friendships/cancel.json", { user_id: userB.rest_id });
check("cancel a request", cancelled.follow_request_sent === false);
await a.form("/1.1/friendships/create.json", { user_id: userB.rest_id });
await b.form("/1.1/friendships/deny.json", { user_id: userA.rest_id });
const denied = (await a.get("UserByScreenName", { screen_name: nameB })).data.user.result;
check("deny leaves them outside", denied.relationship_perspectives.following === false && denied.follow_request_sent === false);

// going public approves whoever asked
await a.form("/1.1/friendships/create.json", { user_id: userB.rest_id });
await b.form("/1.1/account/settings.json", { protected: "false" });
const after = (await a.get("UserByScreenName", { screen_name: nameB })).data.user.result;
check("going public approves pending requests", after.relationship_perspectives.following === true);

await b.gql("DeleteTweet", { tweet_id: post });
await a.form("/1.1/friendships/destroy.json", { user_id: userB.rest_id });
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
