// Pinned replies: the author of a conversation's first post pins one reply,
// which then leads the replies with a "Pinned" label; only the author gets the
// pin menu item. Cleans up its posts.
// usage: bun scripts/test-pinned-replies.ts <author> <other> <password>

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const [authorName, otherName, password] = process.argv.slice(2);
if (!password) throw new Error("usage: bun scripts/test-pinned-replies.ts <author> <other> <password>");

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

const author = await session(authorName);
const other = await session(otherName);
const made: [typeof author, string][] = [];
const post = async (s: typeof author, text: string, replyTo?: string) => {
	const r = await s.gql("CreateTweet", { tweet_text: `${text} ${Date.now()}`, ...(replyTo ? { reply: { in_reply_to_tweet_id: replyTo } } : {}) });
	const id = r.data.create_tweet.tweet_results.result.rest_id as string;
	made.push([s, id]);
	return id;
};
const detail = async (s: typeof author, id: string) => {
	const t = (await s.get("TweetDetail", { focalTweetId: id })).data.threaded_conversation_with_injections_v2;
	const entries = t.instructions.find((i: any) => i.type === "TimelineAddEntries").entries;
	const replies = entries.filter((e: any) => e.entryId.startsWith("conversationthread-")).map((e: any) => e.content.items[0].item);
	return {
		order: replies.map((i: any) => i.itemContent.tweet_results.result.rest_id),
		labels: replies.map((i: any) => i.itemContent.socialContext?.contextType ?? null),
		keys: replies.map((i: any) => i.feedbackInfo?.feedbackKeys?.[0] ?? null),
		actions: Object.fromEntries((t.responseObjects?.feedbackActions ?? []).map((a: any) => [a.key, a.value.richBehavior?.replyPinState])),
	};
};
const pin = (s: typeof author, op: "PinReply" | "UnpinReply", conversationId: string, tweetId: string) =>
	s.gql(op, { conversationId, tweetId }).then((r) => r.data?.[op === "PinReply" ? "create_conversation_pinned_tweet" : "delete_conversation_pinned_tweet"]?.success);

try {
	const root = await post(author, "pin a reply here");
	const first = await post(other, "first reply", root);
	const second = await post(other, "second reply", root);
	const nested = await post(author, "nested", first);

	let d = await detail(author, root);
	check("replies start in posting order", d.order[0] === first && d.order[1] === second, d.order);
	check("the author gets a pin item on every reply", d.keys.every((k: string) => d.actions[k] === "Pinnable"), d);
	check("the other account gets none", (await detail(other, root)).keys.every((k: string | null) => k === null));

	check("someone else can't pin in the author's conversation", (await pin(other, "PinReply", root, second)) === false);
	check("a nested reply can't be pinned", (await pin(author, "PinReply", root, nested)) === false);
	check("the author pins a direct reply", (await pin(author, "PinReply", root, second)) === true);

	d = await detail(author, root);
	check("the pinned reply leads", d.order[0] === second, d.order);
	check("it is labelled as pinned", d.labels[0] === "ReplyPin" && d.labels[1] === null, d.labels);
	check("its menu item unpins", d.actions[d.keys[0]] === "Pinned" && d.actions[d.keys[1]] === "Pinnable", d);
	const seen = await detail(other, root);
	check("other viewers see it pinned too", seen.order[0] === second && seen.labels[0] === "ReplyPin");
	check("a reply's own page has no pinned reply", (await detail(author, first)).labels.every((l: string | null) => l === null));

	check("pinning another replaces it", (await pin(author, "PinReply", root, first)) === true && (await detail(author, root)).order[0] === first);
	check("unpinning a reply that isn't pinned fails", (await pin(author, "UnpinReply", root, second)) === false);
	check("unpinning works", (await pin(author, "UnpinReply", root, first)) === true);
	d = await detail(author, root);
	check("then no reply is labelled", d.labels.every((l: string | null) => l === null), d.labels);
} finally {
	for (const [s, id] of made.reverse()) await s.gql("DeleteTweet", { tweet_id: id });
}

console.log(failures ? `${failures} failed` : "all checks passed");
process.exit(failures ? 1 : 0);
