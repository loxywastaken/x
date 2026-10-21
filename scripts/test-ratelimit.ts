// End-to-end check of the rate limits against a running server (started
// without RATE_LIMITS=off). Uses one existing non-staff account and removes the
// posts it makes. Restart the server afterwards: the windows it used up last
// 15 minutes.
// usage: bun scripts/test-ratelimit.ts <user> <password>

import { RULES } from "../src/ratelimit";

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const [username, password] = process.argv.slice(2);
if (!username || !password) throw new Error("usage: bun scripts/test-ratelimit.ts <user> <password>");

let failed = 0;
const check = (ok: boolean, what: string, detail?: unknown) => {
	console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
	if (!ok) failed++;
};

const r = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username, password }), redirect: "manual" });
const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
const csrf = cookies.find((c) => c.startsWith("ct0="))?.slice(4);
if (!csrf) throw new Error(`login ${username} failed`);
const headers = { cookie: cookies.join("; "), "x-csrf-token": csrf, "content-type": "application/json" };
const gql = (op: string, variables: object) => fetch(`${origin}/i/api/graphql/q/${op}`, { method: "POST", headers, body: JSON.stringify({ variables }) });

// posts: the limit's worth go through, the next one is refused like X does
const made: string[] = [];
let refused: Response | undefined;
for (let i = 0; i <= RULES.post.limit; i++) {
	const res = await gql("CreateTweet", { tweet_text: `rate limit test ${i}` });
	if (res.status === 429) {
		refused = res;
		break;
	}
	const id = (await res.json())?.data?.create_tweet?.tweet_results?.result?.rest_id;
	if (id) made.push(id);
}
check(made.length === RULES.post.limit, "the limit's worth of posts go through", made.length);
check(refused?.status === 429, "the next post gets 429");
const body = refused ? await refused.json() : undefined;
check(body?.errors?.[0]?.code === 88, "with X's code 88", body);
check(Number(refused?.headers.get("x-rate-limit-remaining")) === 0 && Number(refused?.headers.get("x-rate-limit-reset")) > Date.now() / 1000, "and the x-rate-limit headers");

// the client's own background posts (event logging) don't use up writes:
// more of them than the write limit, then a real write still goes through
for (let i = 0; i < RULES.write.limit + 100; i++)
	await fetch(`${origin}/i/api/1.1/flow/timeline.json`, { method: "POST", headers: { cookie: headers.cookie, "x-csrf-token": headers["x-csrf-token"] }, body: "log=x" });
const write = await gql("DeleteTweet", { tweet_id: made.pop()! });
check(write.status === 200, "background event logging doesn't use up the write limit", write.status);

// other buckets are untouched: a like still works
const like = await gql("FavoriteTweet", { tweet_id: made[0] });
check(like.status === 200, "a like still goes through", like.status);

// one endpoint used up leaves the others working
const stuck = (op: string) => fetch(`${origin}/i/api/graphql/q/${op}?variables=%7B%7D`, { headers });
let stuckStatus = 0;
for (let i = 0; i <= RULES.endpoint.limit; i++) stuckStatus = (await stuck("DataSaverMode")).status;
check(stuckStatus === 429, "one endpoint asked for past its limit gets 429", stuckStatus);
const other = await stuck("ViewerBadgeCounts");
check(other.status === 200, "another endpoint still answers", other.status);

// the right password doesn't use up the account's tries
const enterPassword = (user: string, pass: string) =>
	fetch(`${origin}/onboarding/web/actions/login_enter_password`, { method: "POST", body: new URLSearchParams({ username: user, password: pass }) }).then(async (res) => new TextDecoder("latin1").decode(await res.arrayBuffer()));
let signedIn = "";
for (let i = 0; i <= RULES.password.limit; i++) signedIn = await enterPassword(username, password);
check(!signedIn.includes("Too many tries") && !signedIn.includes("Wrong username"), "signing in more often than the limit still works");

// the name check while typing doesn't use up the address's sign-in tries
for (let i = 0; i <= RULES.auth.limit; i++)
	await fetch(`${origin}/onboarding/web/remotes/suggest_username?form_atom_id=x`, { method: "POST", body: new URLSearchParams({ username: `typing${i}`, name: "" }) });
const begin = await fetch(`${origin}/onboarding/web/actions/begin_login`, { method: "POST", body: new URLSearchParams({ username_or_email: username }) });
check(begin.status === 200, "typing doesn't count as sign-in tries", begin.status);

// password tries count per account, also for names that don't exist
const name = `nobody_${Date.now() % 1e6}`;
let lastText = "";
for (let i = 0; i <= RULES.password.limit; i++) {
	const res = await fetch(`${origin}/onboarding/web/actions/login_enter_password`, { method: "POST", body: new URLSearchParams({ username: name, password: "wrong" }) });
	lastText = new TextDecoder("latin1").decode(await res.arrayBuffer());
}
check(lastText.includes("Too many tries"), "password tries stop after the limit");

// clean up: deleting is a write, its own bucket
for (const id of made) await gql("DeleteTweet", { tweet_id: id });
const left = await (await fetch(`${origin}/i/api/graphql/q/TweetResultByRestId?variables=${encodeURIComponent(JSON.stringify({ tweetId: made[0] }))}`, { headers })).json();
check(!left?.data?.tweetResult, "test posts removed");

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
