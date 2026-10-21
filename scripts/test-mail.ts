// Mail: test mails and notification digests are logged (as skipped without a
// Resend key); digests go only to accounts that turned them on, only while
// they're away, at most every few hours. Restores what it changes.
// usage: bun scripts/test-mail.ts <admin> <recipient> <sender> <password>
// The recipient is never signed in (that would make it "here").

import { sql } from "../src/db";
import { newId } from "../src/ids";

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const [adminName, toName, fromName, password] = process.argv.slice(2);
if (!password) throw new Error("usage: bun scripts/test-mail.ts <admin> <recipient> <sender> <password>");

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
	return { admin, gql };
}
let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${JSON.stringify(detail)}`}`);
}

const staff = await session(adminName);
const sender = await session(fromName);
const [to] = await sql`select id::text, email, email_settings, last_seen_at, notifications_seen_at, activity_mailed_at, messages_mailed_at from users where screen_name = ${toName}`;
const [from] = await sql`select id::text from users where screen_name = ${fromName}`;
const mail = `mail-test-${Date.now()}@example.test`;
const testTo = `admin-test-${Date.now()}@example.test`;
const postId = newId();
const conv = `${to.id}:${from.id}`;
const mails = async () => (await sql`select kind, subject, status from mail_log where to_addr = ${mail} order by created_at`) as any[];

try {
	const status = await staff.admin("mail");
	check("the Email page says whether mail is on", typeof status.enabled === "boolean" && typeof status.from === "string");
	const test = await staff.admin("sendTestMail", { to: testTo });
	const [logged] = await sql`select status, error from mail_log where to_addr = ${testTo}`;
	check("a test mail is tried and logged", status.enabled ? test.status === 200 || test.status === 400 : test.status === 400 && logged?.status === "skipped", { test, logged });
	check("a plain account can't send one", (await sender.admin("sendTestMail", { to: testTo })).status === 403);

	await sql`update users set email = ${mail}, email_settings = email_settings || '{"send_network_activity_email": true, "send_new_direct_text_email": true}'::jsonb,
		last_seen_at = now() - interval '2 hours', notifications_seen_at = now() - interval '2 hours', activity_mailed_at = null, messages_mailed_at = null where id = ${to.id}::bigint`;
	await sql`insert into posts (id, user_id, text, conversation_id) values (${postId}::bigint, ${to.id}::bigint, 'mail test post', ${postId}::bigint)`;
	await sender.gql("FavoriteTweet", { tweet_id: postId });
	await sql`insert into chat_members (conversation_id, user_id) values (${conv}, ${to.id}::bigint), (${conv}, ${from.id}::bigint) on conflict do nothing`;
	await sql`insert into chat_events (seq, conversation_id, sender_id, kind, event) values (${newId()}::bigint, ${conv}, ${from.id}::bigint, 1, ${Buffer.from([0])})`;

	await staff.admin("runMailDigests");
	let got = await mails();
	check("an activity digest goes out", got.some((m) => m.kind === "activity_digest" && /1 new notification/.test(m.subject)), got);
	check("and a message digest naming the sender", got.some((m) => m.kind === "message_digest" && m.subject.includes(`@${fromName}`)), got);
	await staff.admin("runMailDigests");
	check("not twice in a row", (await mails()).length === got.length);

	await sql`update users set activity_mailed_at = null, messages_mailed_at = null, last_seen_at = now() where id = ${to.id}::bigint`;
	await staff.admin("runMailDigests");
	check("nothing while the account is around", (await mails()).length === got.length);

	await sql`update users set last_seen_at = now() - interval '2 hours', email_settings = email_settings || '{"send_network_activity_email": false, "send_new_direct_text_email": false}'::jsonb where id = ${to.id}::bigint`;
	await staff.admin("runMailDigests");
	check("nor once the settings are off", (await mails()).length === got.length);
} finally {
	await sender.gql("UnfavoriteTweet", { tweet_id: postId });
	await sql`delete from posts where id = ${postId}::bigint`;
	await sql`delete from chat_events where conversation_id = ${conv}`;
	await sql`delete from chat_members where conversation_id = ${conv}`;
	await sql`update users set email = ${to.email}, email_settings = ${JSON.stringify(to.email_settings)}::text::jsonb, last_seen_at = ${to.last_seen_at},
		notifications_seen_at = ${to.notifications_seen_at}, activity_mailed_at = ${to.activity_mailed_at}, messages_mailed_at = ${to.messages_mailed_at} where id = ${to.id}::bigint`;
	await sql`delete from mail_log where to_addr in (${mail}, ${testTo})`;
}

console.log(failures ? `${failures} failed` : "all checks passed");
await sql.close();
process.exit(failures ? 1 : 0);
