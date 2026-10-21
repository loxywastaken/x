// Topics: staff make one, a viewer follows it from the sidebar, and a matching
// post from an account they don't follow shows in "For you" with the topic's
// label and menu items; "Not interested" takes it out. Cleans up.
// usage: bun scripts/test-topics.ts <admin> <viewer> <stranger> <password>

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const [adminName, viewerName, strangerName, password] = process.argv.slice(2);
if (!password) throw new Error("usage: bun scripts/test-topics.ts <admin> <viewer> <stranger> <password>");

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
	const gql = async (op: string, variables: object) =>
		(await fetch(`${origin}/i/api/graphql/q/${op}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ variables }) })).json();
	const get = async (op: string, variables: object) =>
		(await fetch(`${origin}/i/api/graphql/q/${op}?variables=${encodeURIComponent(JSON.stringify(variables))}`, { headers })).json();
	return { admin, gql, get };
}
let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${JSON.stringify(detail)}`}`);
}

const staff = await session(adminName);
const viewer = await session(viewerName);
const stranger = await session(strangerName);
const tag = `zq${Date.now().toString(36)}`;
const made: string[] = [];
let topicId = "";

const forYou = async () => {
	const t = (await viewer.get("HomeTimeline", { count: 40 })).data.home.home_timeline_urt;
	const entries = t.instructions.find((i: any) => i.type === "TimelineAddEntries").entries;
	const actions = Object.fromEntries((t.responseObjects?.feedbackActions ?? []).map((a: any) => [a.key, a.value.richBehavior]));
	return { entries, actions };
};
const entryFor = (entries: any[], id: string) => entries.find((e: any) => e.content?.itemContent?.tweet_results?.result?.rest_id === id);

try {
	check("a plain account can't make topics", (await viewer.admin("saveTopic", { name: "x", keywords: "x" })).status === 403);
	check("a topic needs keywords", (await staff.admin("saveTopic", { name: `T ${tag}`, keywords: "!!!" })).status === 400);
	const created = await staff.admin("saveTopic", { name: `Topic ${tag}`, description: "a test topic", keywords: `#${tag}, other phrase` });
	topicId = created.id;
	check("staff make a topic", created.status === 200 && !!topicId, created);
	const listed = (await staff.admin("topics")).topics.find((t: any) => t.id === topicId);
	check("its keywords are cleaned", JSON.stringify(listed?.keywords) === JSON.stringify([tag, "other phrase"]), listed?.keywords);

	const sidebar = await viewer.get("TopicToFollowSidebar", { userId: "1" });
	const module = sidebar.data.user.result.timeline.timeline.instructions[0].entries[0];
	const pill = module?.content.items.find((i: any) => i.item.itemContent.topic.topic_id === topicId)?.item.itemContent;
	check("the sidebar suggests it", pill?.topicDisplayType === "Pill" && pill?.topic.following === false, pill);

	const followed = await viewer.gql("TopicFollow", { topicId });
	check("following it", followed.data.topic.topic_id === topicId && followed.data.topic.following === true, followed);
	check("TopicByRestId reports it", (await viewer.get("TopicByRestId", { topicId })).data.topic.following === true);
	const after = await viewer.get("TopicToFollowSidebar", { userId: "1" });
	const stillThere = (after.data.user.result.timeline.timeline.instructions[0].entries[0]?.content.items ?? []).some((i: any) => i.item.itemContent.topic.topic_id === topicId);
	check("a followed topic leaves the suggestions", !stillThere);
	check("an unknown topic is an error", !!(await viewer.gql("TopicFollow", { topicId: "1" })).errors);

	const match = (await stranger.gql("CreateTweet", { tweet_text: `about #${tag.toUpperCase()} today` })).data.create_tweet.tweet_results.result.rest_id;
	const unrelated = (await stranger.gql("CreateTweet", { tweet_text: `nothing to see ${tag}x` })).data.create_tweet.tweet_results.result.rest_id;
	made.push(match, unrelated);

	let feed = await forYou();
	const e = entryFor(feed.entries, match);
	check("the matching post is in For you", !!e);
	check("it carries the topic label", e?.content.itemContent.socialContext?.type === "TimelineTopicContext" && e.content.itemContent.socialContext.topic.topic_id === topicId, e?.content.itemContent.socialContext);
	const keys = e?.content.feedbackInfo?.feedbackKeys ?? [];
	check("and topic menu items", keys.length === 2 && feed.actions[keys[0]]?.type === "TimelineRichFeedbackBehaviorToggleFollowTopicV2" && feed.actions[keys[1]]?.type === "TimelineRichFeedbackBehaviorMarkNotInterestedTopic", keys);
	check("a post that only contains the word inside another isn't labelled", !entryFor(feed.entries, unrelated)?.content.itemContent.socialContext);

	await viewer.gql("TopicNotInterested", { topicId });
	feed = await forYou();
	check("not interested: the stranger's post leaves For you", !entryFor(feed.entries, match));
	check("and the topic isn't followed any more", (await viewer.get("TopicByRestId", { topicId })).data.topic.following === false);
	await viewer.gql("TopicUndoNotInterested", { topicId });
	check("undo brings it back", !!entryFor((await forYou()).entries, match));
	await viewer.gql("TopicUnfollow", { topicId });
	check("unfollowed: no label", !entryFor((await forYou()).entries, match)?.content.itemContent.socialContext);
} finally {
	for (const id of made) await stranger.gql("DeleteTweet", { tweet_id: id });
	if (topicId) check("staff delete the topic", (await staff.admin("deleteTopic", { id: topicId })).status === 200);
}

console.log(failures ? `${failures} failed` : "all checks passed");
process.exit(failures ? 1 : 0);
