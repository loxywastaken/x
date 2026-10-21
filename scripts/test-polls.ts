// End-to-end check of polls against a running server: card creation, posting
// with the card, voting, counts and the one-vote rule. Removes its posts.
// usage: bun scripts/test-polls.ts <user A> <user B> <password of both>

export {};

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const [nameA, nameB, password] = process.argv.slice(2);
if (!nameA || !nameB || !password) throw new Error("usage: bun scripts/test-polls.ts <user A> <user B> <password>");

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
	const form = async (path: string, body: Record<string, string>) =>
		(await fetch(`${origin}/i/api${path}`, { method: "POST", headers, body: new URLSearchParams(body) })).json();
	// one photo through the chunked upload, for image polls
	const upload = async (bytes: Uint8Array, type: string) => {
		const init = await (await fetch(`${origin}/i/media/upload.json?command=INIT&total_bytes=${bytes.length}&media_type=${type}&media_category=tweet_image`, { method: "POST", headers })).json();
		const body = new FormData();
		body.set("media", new Blob([bytes]));
		await fetch(`${origin}/i/media/upload.json?command=APPEND&media_id=${init.media_id_string}&segment_index=0`, { method: "POST", headers, body });
		await fetch(`${origin}/i/media/upload.json?command=FINALIZE&media_id=${init.media_id_string}`, { method: "POST", headers });
		return init.media_id_string as string;
	};
	return { gql, get, form, upload };
}

let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${JSON.stringify(detail)}`}`);
}

const binding = (card: any, key: string) => card?.legacy?.binding_values?.find((b: any) => b.key === key)?.value;

const a = await session(nameA);
const b = await session(nameB);

const bad = await a.form("/v2/cards/create.json", { card_data: JSON.stringify({ "twitter:card": "poll2choice_text_only", "twitter:string:choice1_label": "Only one" }) });
check("a poll needs every label", !!bad.errors);

const card = await a.form("/v2/cards/create.json", {
	card_data: JSON.stringify({
		"twitter:card": "poll3choice_text_only",
		"twitter:api:api:endpoint": "1",
		"twitter:long:duration_minutes": 60,
		"twitter:string:choice1_label": "Red",
		"twitter:string:choice2_label": "Green",
		"twitter:string:choice3_label": "Blue",
	}),
});
check("create card", card.status === "OK" && /^card:\/\/\d+$/.test(card.card_uri), card);

const post = (await a.gql("CreateTweet", { tweet_text: "Pick a color", card_uri: card.card_uri })).data.create_tweet.tweet_results.result;
check("the post carries the poll card", post.card?.legacy?.name === "poll3choice_text_only" && binding(post.card, "choice3_label")?.string_value === "Blue");
check("counts start at zero and the poll is open", binding(post.card, "choice1_count")?.string_value === "0" && binding(post.card, "counts_are_final")?.boolean_value === false);
check("the clock starts with the post", !!binding(post.card, "end_datetime_utc")?.string_value && binding(post.card, "duration_minutes")?.string_value === "60");

const reuse = await a.gql("CreateTweet", { tweet_text: "again", card_uri: card.card_uri });
check("a card can't be used twice", !!reuse.errors?.length);

const vote = (choice: number, s = b) =>
	s.form("/v2/capi/passthrough/1", {
		"twitter:string:card_uri": card.card_uri,
		"twitter:long:original_tweet_id": post.rest_id,
		"twitter:string:response_card_name": "poll3choice_text_only",
		"twitter:string:cards_platform": "Web-12",
		"twitter:string:selected_choice": String(choice),
	});

const voted = await vote(2);
check("vote answers with the updated card", voted.card?.binding_values?.choice2_count?.string_value === "1" && voted.card.binding_values.selected_choice?.string_value === "2", voted);
const second = await vote(1);
check("a second vote doesn't change the first", second.card?.binding_values?.choice1_count?.string_value === "0" && second.card.binding_values.selected_choice?.string_value === "2");
const outOfRange = await vote(4);
check("a choice that doesn't exist is refused", !!outOfRange.errors);

const asB = (await b.get("TweetResultByRestId", { tweetId: post.rest_id })).data?.tweetResult?.result;
check("the voter sees their choice", binding(asB?.card, "selected_choice")?.string_value === "2", asB && Object.keys(asB).length);
const asA = (await a.get("TweetResultByRestId", { tweetId: post.rest_id })).data?.tweetResult?.result;
check("the author sees the count and no choice", binding(asA?.card, "choice2_count")?.string_value === "1" && !binding(asA?.card, "selected_choice"));

await a.gql("DeleteTweet", { tweet_id: post.rest_id });

// image polls: a photo per choice, under the composer's own card name
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const IMAGE_POLL = "1906814671912599552:poll_choice_images";
const img1 = await a.upload(PNG, "image/png");
const img2 = await a.upload(PNG, "image/png");
const imgCard = await a.form("/v2/cards/create.json", { card_data: JSON.stringify({ "twitter:card": IMAGE_POLL, "twitter:api:api:endpoint": "1", "twitter:long:duration_minutes": 60,
	"twitter:string:choice1_label": "first", "twitter:image:choice1_image:src:id": `mis://${img1}`, "twitter:string:choice2_label": "second", "twitter:image:choice2_image:src:id": `mis://${img2}` }) });
check("an image poll card is made", /^card:\/\/\d+$/.test(imgCard.card_uri ?? ""), imgCard);
const stolen = await b.form("/v2/cards/create.json", { card_data: JSON.stringify({ "twitter:card": IMAGE_POLL, "twitter:string:choice1_label": "x", "twitter:image:choice1_image:src:id": `mis://${img1}`, "twitter:string:choice2_label": "y" }) });
check("someone else's upload can't be used", !stolen.card_uri);
const imgPost = (await a.gql("CreateTweet", { tweet_text: "image poll test", card_uri: imgCard.card_uri })).data?.create_tweet?.tweet_results?.result;
const imgSeen = (await b.get("TweetResultByRestId", { tweetId: imgPost?.rest_id })).data?.tweetResult?.result;
check("it renders as an image poll", imgSeen?.card?.legacy?.name === IMAGE_POLL && binding(imgSeen?.card, "choice_count")?.string_value === "2", imgSeen?.card?.legacy?.name);
check("with each choice's photo", !!binding(imgSeen?.card, "choice1_image")?.image_value?.url && !!binding(imgSeen?.card, "choice2_image")?.image_value?.url);
await a.gql("DeleteTweet", { tweet_id: imgPost?.rest_id });
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
