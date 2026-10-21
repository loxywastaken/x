// usage: bun scripts/create-user.ts <screen_name> <password> [display name] [blue|business|government|government_individual]

import { createUser } from "../src/auth";
import { migrate, sql } from "../src/db";

const [screenName, password, name, badge] = process.argv.slice(2);
if (!screenName || !password) {
	console.error("usage: bun scripts/create-user.ts <screen_name> <password> [display name] [blue|business|government|government_individual]");
	process.exit(1);
}

await migrate();
try {
	const id = await createUser(screenName, name || screenName, password);
	if (badge) await sql`update users set verified_type = ${badge} where id = ${id}::bigint`;
	console.log(`created @${screenName} (${id})${badge ? ` with ${badge} badge` : ""}`);
} catch (e: any) {
	console.error(/users_screen_name_key/.test(String(e?.message)) ? `@${screenName} is already taken` : (e?.message ?? e));
	process.exitCode = 1;
}
await sql.close();
