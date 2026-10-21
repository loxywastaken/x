// The profile bell and "Turn off reposts", both through friendships/update:
// the bell makes an account's new posts (not replies, not older posts) arrive
// as notifications; turning reposts off keeps its reposts out of the home feeds.
// Cleans up. usage: bun scripts/test-bell.ts <viewer> <target> <password>

import { sql } from "../src/db";

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const [viewerName, targetName, password] = process.argv.slice(2);
if (!password) throw new Error("usage: bun scripts/test-bell.ts <viewer> <target> <password>");

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
	const rest = async (path: string, body?: Record<string, string>) =>
		fetch(`${origin}/i/api${path}`, body ? { method: "POST", headers, body: new URLSearchParams(body) } : { headers });
	return { gql, get, rest };
}
let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${JSON.stringify(detail)}`}`);
}

const viewer = await session(viewerName);
const target = await session(targetName);
const [{ id: viewerId }] = await sql`select id::text from users where screen_name = ${viewerName}`;
const [{ id: targetId }] = await sql`select id::text from users where screen_name = ${targetName}`;
const hadFollow = (await sql`select 1 from follows where follower_id = ${viewerId}::bigint and followee_id = ${targetId}::bigint`).length > 0;
if (!hadFollow) await sql`insert into follows (follower_id, followee_id) values (${viewerId}::bigint, ${targetId}::bigint)`;
const made: string[] = [];
const post = async (text: string, replyTo?: string) => {
	const r = await target.gql("CreateTweet", { tweet_text: `${text} ${Date.now()}`, ...(replyTo ? { reply: { in_reply_to_tweet_id: replyTo } } : {}) });
	const id = r.data.create_tweet.tweet_results.result.rest_id as string;
	made.push(id);
	return id;
};
const bellEntries = async () => {
	const r = await viewer.get("NotificationsTimeline", { timeline_type: "All", count: 40 });
	const instructions = r.data.viewer_v2.user_results.result.notification_timeline.timeline.instructions;
	return instructions.find((i: any) => i.type === "TimelineAddEntries").entries.filter((e: any) => e.entryId.startsWith("notification-bell-"));
};
const profile = async () => (await viewer.get("UserByScreenName", { screen_name: targetName })).data.user.result;

try {
	const before = await post("before the bell");
	check("the bell starts off", (await profile()).notifications_settings.notifications_enabled === false);
	const rung = await (await viewer.rest("/1.1/friendships/update.json", { id: targetId, device: "true" })).json();
	check("ringing it", rung.relationship?.source?.notifications_enabled === true, rung);
	check("the profile shows it on", (await profile()).notifications_settings.notifications_enabled === true);

	const after = await post("after the bell");
	await post("a reply", after);
	const entries = await bellEntries();
	const mine = entries.filter((e: any) => made.includes(e.entryId.slice("notification-bell-".length)));
	check("a new post arrives as a notification", mine.length === 1 && mine[0].entryId === `notification-bell-${after}`, mine.map((e: any) => e.entryId));
	const item = mine[0]?.content.itemContent;
	check("with the bell icon and the post", item?.notification_icon === "bell_icon" && item?.template.target_objects[0]?.tweet_results.result.rest_id === after);
	check("saying who posted", item?.rich_message.text.startsWith("New post from ") && item?.rich_message.entities.length === 1, item?.rich_message);
	check("opening the post in the app", item?.notification_url.url.endsWith(`/${targetName}/status/${after}`));
	check("older posts and replies don't", !entries.some((e: any) => e.entryId.endsWith(before)));

	await viewer.rest("/1.1/friendships/update.json", { id: targetId, device: "false" });
	check("turning it off", (await profile()).notifications_settings.notifications_enabled === false);
	await post("after it was turned off");
	check("then nothing more arrives", !(await bellEntries()).some((e: any) => made.slice(-1).includes(e.entryId.slice("notification-bell-".length))));

	// reposts
	const other = (await viewer.gql("CreateTweet", { tweet_text: `to be reposted ${Date.now()}` })).data.create_tweet.tweet_results.result.rest_id;
	await target.gql("CreateRetweet", { tweet_id: other });
	const following = async () => {
		const t = (await viewer.get("HomeLatestTimeline", { count: 40 })).data.home.home_timeline_urt.instructions[0].entries;
		return t.some((e: any) => e.content?.itemContent?.tweet_results?.result?.legacy?.retweeted_status_result?.result?.rest_id === other);
	};
	check("their repost is in Following", await following());
	const shown = await (await viewer.rest(`/1.1/friendships/show.json?target_id=${targetId}`)).json();
	check("reposts start on", shown.relationship.source.want_retweets === true);
	await viewer.rest("/1.1/friendships/update.json", { id: targetId, retweets: "false" });
	const listed = await (await viewer.rest(`/1.1/friendships/list.json?user_id=${targetId}`)).json();
	check("turned off", listed[0]?.relationship?.source?.want_retweets === false, listed);
	check("the repost leaves Following", !(await following()));
	await viewer.rest("/1.1/friendships/update.json", { id: targetId, retweets: "true" });
	check("turned back on, it returns", await following());
	await target.gql("DeleteRetweet", { source_tweet_id: other });
	await viewer.gql("DeleteTweet", { tweet_id: other });
} finally {
	for (const id of made.reverse()) await target.gql("DeleteTweet", { tweet_id: id });
	await sql`delete from post_notifications where user_id = ${viewerId}::bigint and target_id = ${targetId}::bigint`;
	await sql`delete from repost_mutes where user_id = ${viewerId}::bigint and target_id = ${targetId}::bigint`;
	if (!hadFollow) await sql`delete from follows where follower_id = ${viewerId}::bigint and followee_id = ${targetId}::bigint`;
}

console.log(failures ? `${failures} failed` : "all checks passed");
await sql.close();
process.exit(failures ? 1 : 0);
