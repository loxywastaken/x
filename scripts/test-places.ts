// Checks the location picker's endpoints and posting with a place.
// usage: bun scripts/test-places.ts <user> <password>

export {};

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const [name, password] = process.argv.slice(2);
if (!name || !password) throw new Error("usage: bun scripts/test-places.ts <user> <password>");

const r = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username: name, password }), redirect: "manual" });
const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
const csrf = cookies.find((c) => c.startsWith("ct0="))?.slice(4);
if (!csrf) throw new Error("login failed");
const headers = { cookie: cookies.join("; "), "x-csrf-token": csrf };
const rest = async (path: string) => (await fetch(`${origin}/i/api${path}`, { headers })).json();
const gql = async (op: string, variables: object) =>
	(await fetch(`${origin}/i/api/graphql/q/${op}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ variables }) })).json();

let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${JSON.stringify(detail)}`}`);
}

const byName = await rest("/1.1/geo/places.json?query=par");
check("search by name prefix", byName.places?.[0]?.name === "Paris" && !!byName.geo_search_request_id, byName.places?.map((p: any) => p.name));
const near = await rest("/1.1/geo/places.json?lat=52.5&long=13.4&max_results=3");
check("nearest to a point", near.places?.[0]?.name === "Berlin", near.places?.map((p: any) => p.name));
const place = byName.places[0];
const byId = await rest(`/1.1/geo/id/${place.id}.json`);
check("lookup by id", byId.full_name === "Paris, France");
check("an unknown id is a 404", (await rest("/1.1/geo/id/0000000000000000.json")).errors?.[0]?.code === 34);

const post = (await gql("CreateTweet", { tweet_text: "from somewhere", geo: { place_id: place.id, geo_search_request_id: byName.geo_search_request_id } })).data.create_tweet.tweet_results.result;
check("the post carries the place", post.legacy.place?.full_name === "Paris, France");
const ignored = (await gql("CreateTweet", { tweet_text: "nowhere", geo: { place_id: "ffffffffffffffff" } })).data.create_tweet.tweet_results.result;
check("an unknown place is ignored", !ignored.legacy.place);

await gql("DeleteTweet", { tweet_id: post.rest_id });
await gql("DeleteTweet", { tweet_id: ignored.rest_id });
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
