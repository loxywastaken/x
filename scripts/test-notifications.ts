// End-to-end check of notifications against a running server: user B likes,
// reposts, quotes, replies to and mentions user A, and follows them; A's badge,
// All and Mentions tabs and read marker are checked. Removes what it creates
// unless KEEP=1, which leaves the activity for looking at it in the client.
// usage: bun scripts/test-notifications.ts <user A> <user B> <password of both>

export {};

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const [nameA, nameB, password] = process.argv.slice(2);
if (!nameA || !nameB || !password) throw new Error("usage: bun scripts/test-notifications.ts <user A> <user B> <password>");

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
		(await fetch(`${origin}/i/api/${path}`, { method: "POST", headers, body: new URLSearchParams(form) })).json();
	return { gql, get, rest };
}

let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${JSON.stringify(detail)}`}`);
}

const a = await session(nameA);
const b = await session(nameB);
const userA = (await a.get("UserByScreenName", { screen_name: nameA })).data.user.result;
const userB = (await a.get("UserByScreenName", { screen_name: nameB })).data.user.result;
const badge = async () => (await a.get("ViewerBadgeCounts", {})).data.viewer_v2.user_results.result.badge_counts.ntab_unread_count;
const timeline = async (type: string) =>
	(await a.get("NotificationsTimeline", { timeline_type: type, count: 40 })).data.viewer_v2.user_results.result.notification_timeline.timeline.instructions;
const entries = (instructions: any[]) => instructions.flatMap((i: any) => i.entries ?? []).filter((e: any) => !e.entryId.startsWith("cursor"));

// start from a read state
await a.rest("2/notifications/all/last_seen_cursor.json", { cursor: `t${Date.now()}` });
check("nothing unread after marking all read", (await badge()) === 0);

const created: [typeof a, string][] = [];
const post = (await a.gql("CreateTweet", { tweet_text: "notify me" })).data.create_tweet.tweet_results.result.rest_id;
created.push([a, post]);
await b.gql("FavoriteTweet", { tweet_id: post });
await b.gql("CreateRetweet", { tweet_id: post });
await b.rest("1.1/friendships/create.json", { user_id: userA.rest_id });
const reply = (await b.gql("CreateTweet", { tweet_text: "a reply", reply: { in_reply_to_tweet_id: post } })).data.create_tweet.tweet_results.result.rest_id;
created.push([b, reply]);
const quote = (await b.gql("CreateTweet", { tweet_text: "quoting", attachment_url: `${origin}/${nameA}/status/${post}` })).data.create_tweet.tweet_results.result.rest_id;
created.push([b, quote]);
const mentionPost = (await b.gql("CreateTweet", { tweet_text: `hello @${nameA} and @nobody_here` })).data.create_tweet.tweet_results.result;
created.push([b, mentionPost.rest_id]);
check("the mention becomes a link in the post", mentionPost.legacy.entities.user_mentions?.[0]?.screen_name === userA.core.screen_name, mentionPost.legacy.entities.user_mentions);

check("badge counts the new activity", (await badge()) === 6, await badge());
const all = entries(await timeline("All"));
const kinds = all.map((e: any) => e.content.itemContent.notification_icon ?? e.content.clientEventInfo.element);
check("All has like, repost, follow, reply, quote and mention", ["heart_icon", "retweet_icon", "person_icon", "user_replied_to_your_tweet", "user_quoted_your_tweet", "user_mentioned_you"].every((k) => kinds.includes(k)), kinds);
const like = all.find((e: any) => e.content.itemContent.notification_icon === "heart_icon")?.content.itemContent;
check("like reads '<name> liked your post' and links the name", like?.rich_message?.text === `${userB.core.name} liked your post` && like.rich_message.entities[0]?.toIndex === userB.core.name.length, like?.rich_message);
check("like points at the post", like?.template?.target_objects?.[0]?.tweet_results?.result?.rest_id === post);
// only this run's posts: earlier runs with KEEP=1 may have left others
const ours = new Set([reply, quote, mentionPost.rest_id]);
const mentions = entries(await timeline("Mentions"))
	.filter((e: any) => ours.has(e.content.itemContent.tweet_results?.result?.rest_id))
	.map((e: any) => e.content.clientEventInfo.element);
check("Mentions has the reply and the mention only", mentions.length === 2 && mentions.includes("user_replied_to_your_tweet") && mentions.includes("user_mentioned_you"), mentions);

const top = (await timeline("All")).flatMap((i: any) => i.entries ?? []).find((e: any) => e.content.cursorType === "Top").content.value;
await a.rest("2/notifications/all/last_seen_cursor.json", { cursor: top });
check("opening the page clears the badge", (await badge()) === 0);
await b.gql("FavoriteTweet", { tweet_id: reply === post ? post : post }).catch(() => {});
const c = (await b.gql("CreateTweet", { tweet_text: `again @${nameA}` })).data.create_tweet.tweet_results.result.rest_id;
created.push([b, c]);
check("new activity after that is unread again", (await badge()) === 1, await badge());
const own = (await a.gql("CreateTweet", { tweet_text: `talking to myself @${nameA}` })).data.create_tweet.tweet_results.result.rest_id;
created.push([a, own]);
check("mentioning yourself does not notify", (await badge()) === 1);

if (process.env.KEEP) console.log("kept the activity");
else {
	await b.gql("UnfavoriteTweet", { tweet_id: post });
	await b.gql("DeleteRetweet", { source_tweet_id: post });
	await b.rest("1.1/friendships/destroy.json", { user_id: userA.rest_id });
	for (const [s, id] of created.reverse()) await s.gql("DeleteTweet", { tweet_id: id });
}

console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);
