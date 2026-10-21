// Prints new invite codes, until the admin panel does this.
// usage: bun scripts/invite.ts [count=1] [--uses N] [--days N]

import { migrate, sql } from "../src/db";
import { createInvite } from "../src/invites";

const args = process.argv.slice(2);
const flag = (name: string) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? Number(args.splice(i, 2)[1]) : undefined;
};
const uses = flag("uses");
const days = flag("days");
const count = Number(args[0] ?? 1);
if (!Number.isInteger(count) || count < 1 || (uses !== undefined && !(uses >= 1)) || (days !== undefined && !(days > 0))) {
	console.error("usage: bun scripts/invite.ts [count=1] [--uses N] [--days N]");
	process.exit(1);
}

await migrate();
const expiresAt = days ? new Date(Date.now() + days * 86400e3) : undefined;
for (let i = 0; i < count; i++) console.log(await createInvite({ maxUses: uses, expiresAt }));
await sql.close();
