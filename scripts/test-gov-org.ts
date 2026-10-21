// Government accounts (grey badge) are organisations like business ones: they
// take affiliates from the admin panel and from their own Organisation page.
// usage: bun scripts/test-gov-org.ts   (needs pozo as admin, password testpass123)
import { createUser } from "../src/auth";
import { sql } from "../src/db";

const origin = "http://localhost:3000", password = "testpass123";
let checks = 0;
const check = (ok: unknown, label: string) => { if (!ok) throw new Error(label); checks++; console.log("ok  ", label); };
async function session(username: string) {
	const r = await fetch(origin + "/login", { method: "POST", body: new URLSearchParams({ username, password }), redirect: "manual" });
	const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
	const headers = { cookie: cookies.join("; "), "x-csrf-token": cookies.find((c) => c.startsWith("ct0="))!.slice(4) };
	return {
		headers,
		admin: async (action: string, body: any = {}) => { const r = await fetch(origin + "/admin/api/" + action, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, data: await r.json() as any }; },
		get: async (op: string, variables: object) => (await (await fetch(`${origin}/i/api/graphql/q/${op}?variables=${encodeURIComponent(JSON.stringify(variables))}`, { headers })).json()) as any,
	};
}
const made: string[] = [];
try {
	const stamp = Date.now().toString().slice(-8);
	const gov = "gv" + stamp, person = "gp" + stamp;
	made.push(await createUser(gov, "Test Ministry", password), await createUser(person, "Test Official", password));
	const admin = await session("pozo");
	check((await admin.admin("setBadge", { id: made[0], badge: "government" })).status === 200, "grey badge given");
	check((await admin.admin("orgs")).data.orgs?.some((o: any) => o.id === made[0]), "a government account is listed as an organisation");
	const added = await admin.admin("addAffiliate", { orgId: made[0], screen_name: person });
	check(added.status === 200, "the admin panel adds an affiliate to it: " + JSON.stringify(added.data));
	const profile = (await admin.get("UserByScreenName", { screen_name: gov })).data.user.result;
	check(profile.business_account?.affiliates_count === 1, "its profile counts the affiliate");
	const own = await session(gov);
	const page = await fetch(origin + "/account/organisation", { headers: own.headers });
	check(page.status === 200 && (await page.text()).includes(person), "its own Organisation page manages affiliates");
	check((await admin.admin("addAffiliate", { orgId: made[1], screen_name: gov })).status >= 400, "a plain account still isn't an organisation");
	await admin.admin("setBadge", { id: made[0], badge: "blue" });
	check(!(await sql`select 1 from affiliations where org_id = ${made[0]}::bigint`).length, "losing the grey badge ends its affiliations");
	console.log(`all passed (${checks})`);
} finally {
	for (const id of made) await sql`delete from users where id = ${id}::bigint`;
	await sql.end();
}
