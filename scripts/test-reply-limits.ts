// Who can reply: the three policies, enforced on replies and shown to the
// viewer as a limited action. Needs an author, an account the author follows,
// a plain account and a verified one, all with the same password. Cleans up.
// usage: bun scripts/test-reply-limits.ts <author> <followed> <plain> <verified> <password>

import { sql } from "../src/db";

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const [authorName, followedName, plainName, verifiedName, password] = process.argv.slice(2);
if (!password) throw new Error("usage: bun scripts/test-reply-limits.ts <author> <followed> <plain> <verified> <password>");

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
const followed = await session(followedName);
const plain = await session(plainName);
const verified = await session(verifiedName);
const ids = (await sql`select id::text, screen_name from users where screen_name in (${authorName}, ${followedName})`) as any[];
const authorId = ids.find((r) => r.screen_name === authorName).id;
const followedId = ids.find((r) => r.screen_name === followedName).id;
const hadFollow = (await sql`select 1 from follows where follower_id = ${authorId}::bigint and followee_id = ${followedId}::bigint`).length > 0;
if (!hadFollow) await sql`insert into follows (follower_id, followee_id) values (${authorId}::bigint, ${followedId}::bigint)`;

const made: string[] = [];
const post = async (text: string, mode?: string) => {
	const r = await author.gql("CreateTweet", { tweet_text: text, ...(mode ? { conversation_control: { mode } } : {}) });
	const id = r.data.create_tweet.tweet_results.result.rest_id;
	made.push(id);
	return id as string;
};
const reply = async (s: typeof author, to: string, text = "reply") => {
	const r = await s.gql("CreateTweet", { tweet_text: text, reply: { in_reply_to_tweet_id: to } });
	const id = r.data?.create_tweet?.tweet_results?.result?.rest_id;
	if (id) made.push(id);
	return { ok: !!id, errors: r.errors };
};
const limited = async (s: typeof author, id: string) => {
	const r = (await s.get("TweetResultByRestId", { tweetId: id })).data?.tweetResult?.result;
	return { limited: !!r?.limitedActionResults?.limited_actions?.length, policy: (r?.tweet ?? r)?.conversation_control?.policy };
};

try {
	const open = await post("anyone can reply " + Date.now());
	check("an open post takes replies from anyone", (await reply(plain, open)).ok);

	const community = await post("accounts I follow " + Date.now(), "Community");
	check("followed account may reply", (await reply(followed, community)).ok);
	check("plain account may not", !(await reply(plain, community)).ok);
	check("the author may", (await reply(author, community)).ok);
	check("the plain viewer sees the limit", (await limited(plain, community)).limited);
	check("the followed viewer does not", !(await limited(followed, community)).limited);
	check("the policy is reported", (await limited(plain, community)).policy === "Community");

	const invite = await post(`only @${plainName} may reply ${Date.now()}`, "ByInvitation");
	check("a mentioned account may reply", (await reply(plain, invite)).ok);
	check("an account that wasn't mentioned may not", !(await reply(followed, invite)).ok);

	const check2 = await post("verified only " + Date.now(), "Verified");
	check("a verified account may reply", (await reply(verified, check2)).ok);
	check("a plain account may not", !(await reply(plain, check2)).ok);

	// replies inherit the conversation's policy
	const nested = await reply(followed, community, "inside");
	check("a nested reply is held to the same policy", nested.ok && !(await reply(plain, community, "nope")).ok);
} finally {
	for (const id of made.reverse()) await author.gql("DeleteTweet", { tweet_id: id }).catch(() => {});
	await sql`delete from posts where id = any(${sql.array(made, "INT8")})`;
	if (!hadFollow) await sql`delete from follows where follower_id = ${authorId}::bigint and followee_id = ${followedId}::bigint`;
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
