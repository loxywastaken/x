// The instance name in place of X's: page titles and the client's text (patch.ts),
// the admin panel, and the app posts are sent from. The name is put back afterwards.
// usage: bun scripts/test-instance-name.ts <admin> <user> <password>
import { sql } from "../src/db";

const [adminName = "pozo", userName = "goldcorp", password = "testpass123"] = process.argv.slice(2);
const origin = "http://localhost:3000";
let checks = 0;
const check = (ok: unknown, label: string) => {
	if (!ok) throw new Error(label);
	checks++;
};
async function session(username: string) {
	const r = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username, password }), redirect: "manual" });
	const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
	const headers = { cookie: cookies.join("; "), "x-csrf-token": cookies.find((c) => c.startsWith("ct0="))!.slice(4), "content-type": "application/json" };
	return {
		headers,
		admin: async (action: string, body: any = {}) => {
			const r = await fetch(`${origin}/admin/api/${action}`, { method: "POST", headers, body: JSON.stringify(body) });
			return { status: r.status, data: (await r.json()) as any };
		},
		gql: async (op: string, vars: any) => (await (await fetch(`${origin}/i/api/graphql/q/${op}`, { method: "POST", headers, body: JSON.stringify({ variables: vars }) })).json()) as any,
	};
}

const admin = await session(adminName);
const user = await session(userName);
const before: string = (await admin.admin("settings")).data.settings.instance_name;
const name = `Acme ${Date.now().toString(36)}`;
const posts: string[] = [];
// the client's English translations, as the shell lists them
const i18n = async () => {
	const html = await (await fetch(`${origin}/`)).text();
	const src = /src="([^"]*\/i18n\/en\.[^"]+\.js)"/.exec(html)?.[1];
	if (!src) throw new Error("no i18n script in the shell");
	const r = await fetch(new URL(src, origin));
	return { text: await r.text(), etag: r.headers.get("etag") };
};
const post = async (text: string) => {
	const id = (await user.gql("CreateTweet", { tweet_text: text })).data.create_tweet.tweet_results.result.rest_id;
	posts.push(id);
	return id;
};
const source = async (id: string) => (await sql`select source from posts where id = ${id}::bigint`)[0].source;

try {
	check((await admin.admin("saveSettings", { instance_name: "Bad {name}" })).status === 400, "ICU syntax refused in the name");
	const old = await i18n();
	const earlier = await post(`posted under the old name ${Date.now()}`);
	check((await source(earlier)) === `${before} for Web`, "web posts name the instance");

	check((await admin.admin("saveSettings", { instance_name: name })).status === 200, "rename");
	const now = await i18n();
	check(now.etag !== old.etag, "translations revalidate after a rename");
	check(now.text.includes(`"Sign up for ${name}"`), "client sentences use the name");
	check(now.text.includes(`"${name}"`), "the brand string (page titles) is the name");
	check(now.text.includes(`"X.com`) === old.text.includes(`"X.com`), "X.com addresses kept");
	check((await source(earlier)) === `${name} for Web`, "earlier posts follow the rename");
	check((await source(await post(`posted under the new name ${Date.now()}`))) === `${name} for Web`, "new posts use the new name");
	check((await (await fetch(`${origin}/admin`, { headers: admin.headers })).text()).includes(`<title>Admin · ${name}</title>`), "admin panel title");
	check((await (await fetch(`${origin}/`)).text()).includes(`<title>${name}</title>`), "shell title");
} finally {
	await admin.admin("saveSettings", { instance_name: before });
	for (const id of posts) await user.gql("DeleteTweet", { tweet_id: id });
	await sql.close();
}
console.log(`all ${checks} instance name checks passed`);
