// Gives an account a staff role, for the first admin before the panel can.
// usage: bun scripts/make-admin.ts <screen_name> [admin|moderator|support|none]

import { migrate, sql } from "../src/db";

const [screenName, role = "admin"] = process.argv.slice(2);
if (!screenName || !["admin", "moderator", "support", "none"].includes(role)) {
	console.error("usage: bun scripts/make-admin.ts <screen_name> [admin|moderator|support|none]");
	process.exit(1);
}
await migrate();
const rows = await sql`update users set role = ${role === "none" ? null : role} where lower(screen_name) = lower(${screenName}) returning screen_name`;
console.log(rows.length ? `@${rows[0].screen_name} is now ${role === "none" ? "not staff" : role}` : `no account @${screenName}`);
await sql.close();
