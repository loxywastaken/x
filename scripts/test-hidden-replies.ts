// End-to-end check of Hide reply against a running server: only the
// conversation's author hides, a hidden reply leaves the conversation for
// everyone and shows under "Hidden replies", unhiding brings it back.
// usage: bun scripts/test-hidden-replies.ts <user A> <user B> <password of both>

export {};

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const [nameA, nameB, password] = process.argv.slice(2);
if (!nameA || !nameB || !password) throw new Error("usage: bun scripts/test-hidden-replies.ts <user A> <user B> <password>");

async function session(username: string) {
	const r = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username, password }), redirect: "manual" });
	const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
	const csrf = cookies.find((c) => c.startsWith("ct0="))?.slice(4);
	if (!csrf) throw new Error(`login ${username} failed`);
	const headers = { cookie: cookies.join("; "), "x-csrf-token": csrf };
	const gql = async (op: string, variables: object) =>
		(await fetch(`${origin}/i/api/graphql/q/${op}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ variables }) })).json() as any;
	const get = async (op: string, variables: object) =>
		(await fetch(`${origin}/i/api/graphql/q/${op}?variables=${encodeURIComponent(JSON.stringify(variables))}`, { headers })).json() as any;
	return { gql, get };
}

let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` ${JSON.stringify(detail)}`}`);
	if (!ok) failures++;
}

const a = await session(nameA);
const b = await session(nameB);
const idOf = (r: any) => r.data?.create_tweet?.tweet_results?.result?.rest_id as string;
const root = idOf(await a.gql("CreateTweet", { tweet_text: "hidden replies test root" }));
const reply = idOf(await b.gql("CreateTweet", { tweet_text: "a reply to hide", reply: { in_reply_to_tweet_id: root } }));
const kept = idOf(await b.gql("CreateTweet", { tweet_text: "a reply that stays", reply: { in_reply_to_tweet_id: root } }));

const entries = (r: any) => (r.data?.threaded_conversation_with_injections_v2?.instructions ?? []).flatMap((i: any) => i.entries ?? []);
const ids = (r: any) => { const all = JSON.stringify(entries(r)); return { includes: (key: string) => all.includes(`"rest_id":"${key.replace("tweet-", "")}"`) }; };
const detail = (s: typeof a) => s.get("TweetDetail", { focalTweetId: root });
const hiddenList = async (s: typeof a) =>
	((await s.get("ModeratedTimeline", { rootTweetId: root, count: 20 })).data?.tweet?.result?.timeline_response?.timeline?.instructions ?? [])
		.flatMap((i: any) => i.entries ?? []).map((e: any) => e.entryId as string);

check("both replies show at first", ids(await detail(a)).includes(`tweet-${reply}`) && ids(await detail(a)).includes(`tweet-${kept}`));
const empty = await a.get("ModeratedTimeline", { rootTweetId: root, count: 20 });
check("the hidden replies page answers with an empty timeline", empty.data?.tweet?.result?.__typename === "Tweet" && (await hiddenList(a)).length === 0, empty);

const notMine = await b.gql("ModerateTweet", { tweetId: reply });
check("only the conversation's author can hide", !!notMine.errors?.length);
const hid = await a.gql("ModerateTweet", { tweetId: reply });
check("hide reply answers Done", hid.data?.tweet_moderate_put === "Done", hid);

for (const [who, s] of [["author", a], ["replier", b]] as const) {
	const r = await detail(s);
	check(`hidden reply is gone from the conversation (${who})`, !ids(r).includes(`tweet-${reply}`) && ids(r).includes(`tweet-${kept}`));
	const first = entries(r).find((e: any) => e.entryId === `tweet-${root}`);
	check(`the first post links to hidden replies (${who})`, first?.content?.itemContent?.hasModeratedReplies === true);
	check(`and the hidden replies page lists it (${who})`, (await hiddenList(s)).includes(`tweet-${reply}`));
}

const unhid = await a.gql("UnmoderateTweet", { tweetId: reply });
check("unhide answers Done", unhid.data?.tweet_unmoderate_put === "Done", unhid);
const back = await detail(b);
check("an unhidden reply is back", ids(back).includes(`tweet-${reply}`));
check("and the link is gone", entries(back).find((e: any) => e.entryId === `tweet-${root}`)?.content?.itemContent?.hasModeratedReplies !== true);
check("hiding a first post isn't possible", !!(await a.gql("ModerateTweet", { tweetId: root })).errors?.length);

for (const id of [reply, kept]) await b.gql("DeleteTweet", { tweet_id: id });
await a.gql("DeleteTweet", { tweet_id: root });

console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
