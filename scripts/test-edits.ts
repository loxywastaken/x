// End-to-end check of editing posts: the edit window, the limit, history ids.
// usage: bun scripts/test-edits.ts <user A> <user B> <password of both>

export {};

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const [nameA, nameB, password] = process.argv.slice(2);
if (!nameA || !nameB || !password) throw new Error("usage: bun scripts/test-edits.ts <user A> <user B> <password>");

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

const a = await session(nameA);
const b = await session(nameB);

const post = (await a.gql("CreateTweet", { tweet_text: "first version" })).data.create_tweet.tweet_results.result;
const id = post.rest_id;
check("a new post is eligible", post.edit_control.is_edit_eligible === true && post.edit_control.edits_remaining === "5" && post.edit_control.edit_tweet_ids.length === 1);

const edited = (await a.gql("CreateTweet", { tweet_text: "second version", edit_options: { previous_tweet_id: id } })).data?.create_tweet?.tweet_results?.result;
check("edit keeps the id and changes the text", edited?.rest_id === id && edited.legacy.full_text === "second version");
check("edit_control lists the old version before the post", edited?.edit_control.edit_tweet_ids.length === 2 && edited.edit_control.edit_tweet_ids[1] === id && edited.edit_control.edits_remaining === "4", edited?.edit_control);

const oldId = edited.edit_control.edit_tweet_ids[0];
const old = (await a.get("TweetResultByRestId", { tweetId: oldId })).data?.tweetResult?.result;
check("the old version id shows the old text", old?.legacy?.full_text === "first version" && old.rest_id === oldId && old.edit_control.is_edit_eligible === false, old?.legacy?.full_text);
check("and points at the same list", old?.edit_control?.edit_tweet_ids?.[1] === id);

const stranger = await b.gql("CreateTweet", { tweet_text: "hijack", edit_options: { previous_tweet_id: id } });
check("only the author edits", !!stranger.errors?.length);
const same = await a.gql("CreateTweet", { tweet_text: "second version", edit_options: { previous_tweet_id: id } });
check("an unchanged text is refused", !!same.errors?.length);

for (let i = 3; i <= 6; i++) await a.gql("CreateTweet", { tweet_text: `version ${i}`, edit_options: { previous_tweet_id: id } });
const last = (await a.get("TweetResultByRestId", { tweetId: id })).data.tweetResult.result;
check("five edits is the limit", last.legacy.full_text === "version 6" && last.edit_control.edits_remaining === "0" && last.edit_control.is_edit_eligible === false && last.edit_control.edit_tweet_ids.length === 6, last.edit_control);
const over = await a.gql("CreateTweet", { tweet_text: "one too many", edit_options: { previous_tweet_id: id } });
check("a sixth edit is refused", !!over.errors?.length);

const aged = (await a.gql("CreateTweet", { tweet_text: "old post" })).data.create_tweet.tweet_results.result.rest_id;
await a.gql("DeleteTweet", { tweet_id: id });
await a.gql("DeleteTweet", { tweet_id: aged });
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
