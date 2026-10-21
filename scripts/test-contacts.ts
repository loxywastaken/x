// Similar accounts and contacts: "accounts like this one" ranks by shared
// followers; an uploaded address book lists in Settings, puts its people first
// in who-to-follow only if they let themselves be found by email, and can be
// removed. Restores what it changes.
// usage: bun scripts/test-contacts.ts <viewer> <profile> <similar> <bridge> <password>

import { sql } from "../src/db";

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const [viewerName, profileName, similarName, bridgeName, password] = process.argv.slice(2);
if (!password) throw new Error("usage: bun scripts/test-contacts.ts <viewer> <profile> <similar> <bridge> <password>");

async function session(username: string) {
	const r = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username, password }), redirect: "manual" });
	const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
	const csrf = cookies.find((c) => c.startsWith("ct0="))?.slice(4);
	if (!csrf) throw new Error(`login ${username} failed`);
	const headers = { cookie: cookies.join("; "), "x-csrf-token": csrf };
	const get = async (op: string, variables: object) =>
		(await fetch(`${origin}/i/api/graphql/q/${op}?variables=${encodeURIComponent(JSON.stringify(variables))}`, { headers })).json();
	const rest = async (path: string, init: { form?: Record<string, string>; json?: object } = {}) =>
		fetch(`${origin}/i/api${path}`, init.form ? { method: "POST", headers, body: new URLSearchParams(init.form) } : init.json ? { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(init.json) } : { headers });
	return { get, rest };
}
let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${JSON.stringify(detail)}`}`);
}

const viewer = await session(viewerName);
const similar = await session(similarName);
const ids = Object.fromEntries(
	((await sql`select screen_name, id::text, email from users where screen_name in (${viewerName}, ${profileName}, ${similarName}, ${bridgeName})`) as any[]).map((r) => [r.screen_name, r]),
);
const [viewerId, profileId, similarId, bridgeId] = [viewerName, profileName, similarName, bridgeName].map((n) => ids[n].id);
const added: [string, string][] = [];
const follow = async (a: string, b: string) => {
	const r = await sql`insert into follows (follower_id, followee_id) values (${a}::bigint, ${b}::bigint) on conflict do nothing returning 1`;
	if (r.length) added.push([a, b]);
};
const mail = `contacts-${Date.now()}@example.test`;

try {
	// the bridge follows both the profile and the similar account
	await follow(bridgeId, profileId);
	await follow(bridgeId, similarId);
	const recs = await (await viewer.rest(`/1.1/users/recommendations.json?display_location=profile-cluster-follow&limit=5&user_id=${profileId}`)).json();
	check("accounts like a profile come back as recommendations", Array.isArray(recs) && recs[0]?.user?.screen_name === similarName, recs.map?.((r: any) => r.user.screen_name));
	check("without the profile itself or the viewer", !recs.some((r: any) => r.user_id === profileId || r.user_id === viewerId));
	check("each with its user id", recs.every((r: any) => r.user_id === r.user.id_str));
	const side = await viewer.get("SidebarUserRecommendations", { profileUserId: profileId });
	check("the profile side bar's 'You might like' does the same", side.data.sidebar_user_recommendations[0]?.user_results.result.rest_id === similarId);

	// contacts
	await sql`update users set email = ${mail} where id = ${similarId}::bigint`;
	check("the address book starts empty", (await (await viewer.rest("/1.1/contacts/addressbook.json?count=100")).json()).contacts.length === 0);
	const up = await (await viewer.rest("/1.1/contacts/upload_v2.json", { json: { contacts: [{ name: "Friend; One", email_addresses: [mail.toUpperCase()], phone_numbers: ["+1 555 0100"] }, { name: "" }] } })).json();
	check("uploading keeps the real contacts", up.uploaded === 1, up);
	const book = await (await viewer.rest("/1.1/contacts/addressbook.json?count=100")).json();
	const card: string = book.contacts[0]?.vcard ?? "";
	check("the dashboard lists it as a vCard", book.contacts.length === 1 && card.startsWith("BEGIN:VCARD") && card.includes(`EMAIL:${mail}`) && card.includes("FN:Friend\\; One"), book);

	const firstSuggestion = async () => (await viewer.get("ConnectTabTimeline", {})).data.connect_tab_timeline.timeline.instructions[0].entries.find((e: any) => e.entryId.startsWith("user-"))?.content.itemContent.user_results.result.rest_id;
	const before = await firstSuggestion();
	await similar.rest("/1.1/account/settings.json", { form: { discoverable_by_email: "true" } });
	check("the setting reads back", (await (await similar.rest("/1.1/account/settings.json")).json()).discoverable_by_email === true);
	check("a contact who can be found by email comes first in Who to follow", (await firstSuggestion()) === similarId);
	await similar.rest("/1.1/account/settings.json", { form: { discoverable_by_email: "false" } });
	check("and not once they turn that off", (await firstSuggestion()) === before);

	await viewer.rest("/1.1/contacts/destroy/all.json", { form: {} });
	check("removing contacts empties the address book", (await (await viewer.rest("/1.1/contacts/addressbook.json")).json()).contacts.length === 0);
} finally {
	for (const [a, b] of added) await sql`delete from follows where follower_id = ${a}::bigint and followee_id = ${b}::bigint`;
	await sql`update users set email = ${ids[similarName].email}, preferences = preferences - 'discoverable_by_email' where id = ${similarId}::bigint`;
	await sql`delete from contacts where user_id = ${viewerId}::bigint`;
}

console.log(failures ? `${failures} failed` : "all checks passed");
await sql.close();
process.exit(failures ? 1 : 0);
