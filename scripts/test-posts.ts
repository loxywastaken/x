// End-to-end check of reposts in feeds, the Following feed, quotes and pins,
// against a running server. Uses two existing accounts and removes what it creates.
// usage: bun scripts/test-posts.ts <user A> <user B> <password of both>

export {};

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const [nameA, nameB, password] = process.argv.slice(2);
if (!nameA || !nameB || !password) throw new Error("usage: bun scripts/test-posts.ts <user A> <user B> <password>");

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
	const rest = async (path: string, form: Record<string, string>) =>
		(await fetch(`${origin}/i/api/1.1/${path}`, { method: "POST", headers, body: new URLSearchParams(form) })).json();
	return { gql, get, rest };
}

let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${JSON.stringify(detail)}`}`);
}

const entriesOf = (timeline: any): any[] => (timeline?.instructions ?? []).flatMap((i: any) => i.entries ?? []);
const results = (entries: any[]) => entries.map((e) => e.content?.itemContent?.tweet_results?.result).filter(Boolean);

const a = await session(nameA);
const b = await session(nameB);
const userA = (await a.get("UserByScreenName", { screen_name: nameA })).data.user.result;
const userB = (await a.get("UserByScreenName", { screen_name: nameB })).data.user.result;
const created: [typeof a, string][] = [];

const postA = (await a.gql("CreateTweet", { tweet_text: "step 2 test post" })).data.create_tweet.tweet_results.result.rest_id;
created.push([a, postA]);
const postB = (await b.gql("CreateTweet", { tweet_text: "a post by B" })).data.create_tweet.tweet_results.result.rest_id;
created.push([b, postB]);
const repostId = (await b.gql("CreateRetweet", { tweet_id: postA })).data.create_retweet.retweet_results.result.rest_id;

const forYou = results(entriesOf((await a.get("HomeTimeline", { count: 20 })).data.home.home_timeline_urt));
const rt = forYou.find((r) => r.rest_id === repostId);
check(
	"repost appears in For you as a wrapper around the original",
	rt?.legacy?.retweeted_status_result?.result?.rest_id === postA && rt.core.user_results.result.rest_id === userB.rest_id,
	{ text: rt?.legacy?.full_text, by: rt?.core?.user_results?.result?.core?.screen_name },
);
check("the repost carries the original's counters", rt?.legacy?.retweet_count === 1);

let following = results(entriesOf((await a.get("HomeLatestTimeline", { count: 40 })).data.home.home_timeline_urt));
check("Following shows own posts", following.some((r) => r.rest_id === postA));
check("Following hides accounts not followed", !following.some((r) => r.rest_id === postB || r.rest_id === repostId));
await a.rest("friendships/create.json", { user_id: userB.rest_id });
following = results(entriesOf((await a.get("HomeLatestTimeline", { count: 40 })).data.home.home_timeline_urt));
check("after following, their posts and reposts show", following.some((r) => r.rest_id === postB) && following.some((r) => r.rest_id === repostId));

const quote = (await b.gql("CreateTweet", { tweet_text: "quoting this", attachment_url: `${origin}/${nameA}/status/${postA}` })).data.create_tweet.tweet_results.result;
created.push([b, quote.rest_id]);
check("quote carries the quoted post", quote.quoted_status_result?.result?.rest_id === postA && quote.legacy.is_quote_status === true, quote.legacy.quoted_status_permalink);
const original = (await a.get("TweetDetail", { focalTweetId: postA })).data.threaded_conversation_with_injections_v2;
check("quoted post counts the quote", results(entriesOf(original))[0]?.legacy?.quote_count === 1);

check("someone else's post cannot be pinned", !!(await b.gql("PinTweet", { tweet_id: postA })).errors);
await a.gql("PinTweet", { tweet_id: postA });
const pinnedUser = (await a.get("UserByScreenName", { screen_name: nameA })).data.user.result;
check("profile lists the pinned post", pinnedUser.pinned_items?.tweet_ids_str?.[0] === postA);
const profile = (await b.get("UserOriginalsTimeline", { userId: userA.rest_id, count: 20 })).data.user.result.timeline.timeline;
const first = entriesOf(profile).find((e: any) => e.content?.itemContent);
check(
	"posts tab starts with the pinned post, labelled",
	first?.content.itemContent.tweet_results.result.rest_id === postA && first.content.itemContent.socialContext?.contextType === "Pin",
);
check("the pinned post is not listed twice", entriesOf(profile).filter((e: any) => e.entryId === `tweet-${postA}`).length === 1);

const repostsTab = results(entriesOf((await a.get("UserRepostsTimeline", { userId: userB.rest_id, count: 20 })).data.user.result.timeline.timeline));
check("Reposts tab has only reposts", repostsTab.length > 0 && repostsTab.every((r) => r.legacy?.retweeted_status_result), repostsTab.map((r) => r.rest_id));
const postsTabB = results(entriesOf((await a.get("UserOriginalsTimeline", { userId: userB.rest_id, count: 20 })).data.user.result.timeline.timeline));
check("Posts tab includes the account's reposts", postsTabB.some((r) => r.rest_id === repostId));

// clean up
await a.gql("UnpinTweet", {});
await a.rest("friendships/destroy.json", { user_id: userB.rest_id });
await b.gql("DeleteRetweet", { source_tweet_id: postA });
for (const [s, id] of created.reverse()) await s.gql("DeleteTweet", { tweet_id: id });

console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);
