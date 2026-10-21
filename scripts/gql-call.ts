// Calls one GraphQL operation as a user and prints the response, for debugging.
// usage: bun scripts/gql-call.ts <user> <password> <operation> [variables json] [--post]
export {};

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const [username, password, op, vars = "{}", method] = process.argv.slice(2);
if (!username || !password || !op) throw new Error("usage: bun scripts/gql-call.ts <user> <password> <operation> [variables json] [--post]");

const r = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username, password }), redirect: "manual" });
const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
const csrf = cookies.find((c) => c.startsWith("ct0="))?.slice(4);
if (!csrf) throw new Error(`login ${username} failed`);
const headers = { cookie: cookies.join("; "), "x-csrf-token": csrf };
const response =
	method === "--post"
		? await fetch(`${origin}/i/api/graphql/q/${op}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ variables: JSON.parse(vars) }) })
		: await fetch(`${origin}/i/api/graphql/q/${op}?variables=${encodeURIComponent(vars)}`, { headers });
console.log(response.status, JSON.stringify(await response.json(), null, 1));
