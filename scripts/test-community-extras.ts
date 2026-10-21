// Community banners and topics: the admin sets a banner from an upload and a
// topic from the instance's topics; members can't; the topic carousel and
// Explore by topic follow. Cleans up.
// usage: bun scripts/test-community-extras.ts <admin of the instance and the community> <member> <outsider> <password>

import { sql } from "../src/db";
import { newId } from "../src/ids";

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const [nameA, nameB, nameC, password] = process.argv.slice(2);
if (!password) throw new Error("usage: bun scripts/test-community-extras.ts <admin> <member> <outsider> <password>");

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
	const admin = async (action: string, body: object) =>
		(await fetch(`${origin}/admin/api/${action}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) })).json();
	return { gql, get, admin };
}
let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${JSON.stringify(detail)}`}`);
}

const a = await session(nameA);
const b = await session(nameB);
const [{ id: aId }] = await sql`select id::text from users where screen_name = ${nameA}`;
const [{ id: bId }] = await sql`select id::text from users where screen_name = ${nameB}`;
const stamp = Date.now().toString(36);
const mediaA = newId();
const mediaB = newId();
await sql`insert into media (id, user_id, kind, mime, size, width, height) values (${mediaA}::bigint, ${aId}::bigint, 'photo', 'image/png', 1, 1500, 500), (${mediaB}::bigint, ${bId}::bigint, 'photo', 'image/png', 1, 10, 10)`;
const topic = (await a.admin("saveTopic", { name: `Board games ${stamp}`, keywords: `boardgames${stamp}` })).id as string;
let id = "";

try {
	const created = await a.gql("CreateCommunity", { name: `Extras ${stamp}`, description: "", joinPolicy: "Open", invitesPolicy: "MemberInvitesAllowed", question: "" });
	id = created.data.community_create_v2.id_str;
	await b.gql("JoinCommunity", { communityId: id });

	check("a member can't change the banner", !!(await b.gql("CommunityEditBannerMedia", { communityId: id, mediaId: mediaB })).errors);
	check("nor use someone else's upload", !!(await a.gql("CommunityEditBannerMedia", { communityId: id, mediaId: mediaB })).errors);
	const put = (await a.gql("CommunityEditBannerMedia", { communityId: id, mediaId: mediaA })).data?.community_custom_banner_media_put;
	const info = put?.custom_banner_media?.media_info;
	check("the admin sets a banner from an upload", info?.original_img_url.endsWith(`/media/${mediaA}`) && info.original_img_width === 1500 && info.original_img_height === 500, info);
	const page = (await b.get("CommunityByRestId", { communityId: id })).data.communityResults.result;
	check("everyone sees it", page.custom_banner_media?.media_info?.original_img_url === info?.original_img_url);
	const removed = (await a.gql("CommunityRemoveBannerMedia", { communityId: id })).data?.community_custom_banner_media_delete;
	check("removing it brings back the default", removed?.custom_banner_media === null && !!removed?.default_banner_media);

	const picker = (await a.get("EditTopicQuery", {})).data.fetch_community_topics.community_topics;
	check("the topic picker lists the instance's topics", picker.some((t: any) => t.topic_id === topic && t.subtopics.length === 0));
	check("a member can't set the topic", !!(await b.gql("EditTopicMutation", { communityId: id, topicId: topic })).errors);
	const set = (await a.gql("EditTopicMutation", { communityId: id, topicId: topic })).data?.community_topic_put;
	check("the admin sets it", set?.primary_community_topic?.topic_id === topic, set?.primary_community_topic);
	const carousel = (await b.get("TopicCarouselQuery", {})).data.fetch_user_community_topics.community_topics;
	check("the topic carousel shows topics in use", carousel.some((t: any) => t.topic_id === topic));
	// Explore lists communities the viewer isn't in
	const c = await session(nameC);
	const byTopic = (await c.get("CommunitiesExploreTimeline", { topicId: topic })).data.viewer.explore_communities_timeline.timeline.instructions[0].entries;
	check("Explore by topic finds the community", byTopic.some((e: any) => e.entryId === `community-${id}`));
	const other = (await c.get("CommunitiesExploreTimeline", { topicId: "1" })).data.viewer.explore_communities_timeline.timeline.instructions[0].entries;
	check("and not under another topic", !other.some((e: any) => e.entryId === `community-${id}`));
	const cleared = (await a.gql("EditTopicMutation", { communityId: id })).data?.community_topic_put;
	check("no topic clears it", cleared?.primary_community_topic === null);
} finally {
	if (id) await a.gql("DeleteCommunityMutation", { id, name: "x" });
	await a.admin("deleteTopic", { id: topic });
	await sql`delete from media where id in (${mediaA}::bigint, ${mediaB}::bigint)`;
}

console.log(failures ? `${failures} failed` : "all checks passed");
await sql.close();
process.exit(failures ? 1 : 0);
