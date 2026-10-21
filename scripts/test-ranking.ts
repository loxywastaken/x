// End-to-end check of the ranked "For you" feed against a running server. Uses
// two existing accounts and removes what it creates.
// usage: bun scripts/test-ranking.ts <user A> <user B> <password of both>

export {};

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const [nameA, nameB, password] = process.argv.slice(2);
if (!nameA || !nameB || !password) throw new Error("usage: bun scripts/test-ranking.ts <user A> <user B> <password>");

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

type Entry = { entryId: string; sortIndex: string; content: any };
const entriesOf = (r: any): Entry[] => (r.data?.home?.home_timeline_urt?.instructions ?? []).flatMap((i: any) => i.entries ?? []);
const tweetOf = (e: Entry) => {
	const t = e.content?.itemContent?.tweet_results?.result;
	return t?.legacy?.retweeted_status_result?.result ?? t;
};
const cursorOf = (entries: Entry[], type: "Top" | "Bottom") => entries.find((e) => e.content?.cursorType === type)?.content?.value;

const a = await session(nameA);
const b = await session(nameB);
const created: [typeof a, string][] = [];
const post = async (s: typeof a, text: string, extra: object = {}) => {
	const id = (await s.gql("CreateTweet", { tweet_text: text, ...extra })).data.create_tweet.tweet_results.result.rest_id;
	created.push([s, id]);
	return id as string;
};

// the whole ranked feed, page by page
async function wholeFeed(pageSize: number) {
	const posts: { id: string; author: string; sort: string }[] = [];
	let cursor: string | undefined;
	for (let pages = 0; pages < 100; pages++) {
		const entries = entriesOf(await a.get("HomeTimeline", { count: pageSize, ...(cursor ? { cursor } : {}) }));
		for (const e of entries) {
			const t = tweetOf(e);
			if (t) posts.push({ id: t.rest_id, author: e.content.itemContent.tweet_results.result.core?.user_results?.result?.core?.screen_name ?? "", sort: e.sortIndex });
		}
		cursor = cursorOf(entries, "Bottom");
		if (!cursor) break;
	}
	return posts;
}

const popular = await post(b, "ranking test: everyone talks about this one");
const quiet = await post(b, "ranking test: nobody cares about this one");
await a.gql("FavoriteTweet", { tweet_id: popular });
await post(a, "ranking test: a reply", { reply: { in_reply_to_tweet_id: popular } });

const feed = await wholeFeed(5);
const ids = feed.map((p) => p.id);
check("the popular post ranks above the newer quiet one", ids.includes(popular) && ids.includes(quiet) && ids.indexOf(popular) < ids.indexOf(quiet), {
	popular: ids.indexOf(popular),
	quiet: ids.indexOf(quiet),
});
check("paging gives every post once", new Set(ids).size === ids.length, ids.length);
check("sort indexes fall in ranked order", feed.every((p, i) => i === 0 || BigInt(feed[i - 1].sort) > BigInt(p.sort)));
check("replies stay out of the feed", !feed.some((p) => created.some(([s, id]) => s === a && id === p.id)));

// more than two in a row by one author only when nobody else is left
let spreadOk = true;
for (let i = 2; i < feed.length; i++) {
	if (feed[i].author === feed[i - 1].author && feed[i].author === feed[i - 2].author && feed.slice(i).some((p) => p.author !== feed[i].author)) spreadOk = false;
}
check("no author fills more than two places in a row", spreadOk, feed.map((p) => p.author).join(" "));

// a post made after the first page arrives through the client's poll for newer posts
const first = entriesOf(await a.get("HomeTimeline", { count: 20 }));
const fresh = await post(b, "ranking test: brand new");
const polled = entriesOf(await a.get("HomeTimeline", { count: 20, cursor: cursorOf(first, "Top") }));
const freshEntry = polled.find((e) => tweetOf(e)?.rest_id === fresh);
check("a new post comes through the poll", !!freshEntry);
check("and sorts above the ranked page", !!freshEntry && first.every((e) => BigInt(freshEntry.sortIndex) > BigInt(e.sortIndex)));

const following = entriesOf(await a.get("HomeLatestTimeline", { count: 40 })).filter((e) => tweetOf(e));
check("Following stays newest first", following.every((e, i) => i === 0 || BigInt(following[i - 1].sortIndex) > BigInt(e.sortIndex)));

await a.gql("UnfavoriteTweet", { tweet_id: popular });
for (const [s, id] of created.reverse()) await s.gql("DeleteTweet", { tweet_id: id });
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
