// Checks the reset page against a running server: a good token sets the new
// password once and signs everything out; bad and used tokens are refused.
// Makes its own account (no mail is sent) and removes it.
// usage: bun scripts/test-password-reset.ts

import { createHash } from "node:crypto";
import { sql } from "../src/db";
import { createUser } from "../src/auth";

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const name = `r${Date.now() % 1e8}`;
let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${JSON.stringify(detail)}`}`);
}
const signIn = async (password: string) =>
	(await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username: name, password }), redirect: "manual" })).headers.getSetCookie().some((c) => c.startsWith("ct0="));

const id = await createUser(name, "Reset Test", "testpass123");
try {
	const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
	await sql`insert into password_resets (token_hash, user_id) values (${createHash("sha256").update(token).digest("hex")}, ${id}::bigint)`;

	check("the page opens for a good token", (await fetch(`${origin}/account/reset?token=${token}`)).status === 200);
	check("a made-up token is refused", (await fetch(`${origin}/account/reset?token=${"a".repeat(64)}`)).status === 410);
	const post = (password: string, confirm = password) =>
		fetch(`${origin}/account/reset`, { method: "POST", body: new URLSearchParams({ token, password, confirm }) });
	check("a short password is refused", (await (await post("short")).text()).includes("at least 8"));
	check("mismatch is refused", (await (await post("newpass456", "other12345")).text()).includes("don't match"));
	check("the new password is accepted", (await (await post("newpass456")).text()).includes("Password changed"));
	check("it signs in", await signIn("newpass456"));
	check("the old one does not", !(await signIn("testpass123")));
	check("the token works once", (await post("another789")).status === 410);
	check("the forgot page opens", (await fetch(`${origin}/account/forgot`)).status === 200);
} finally {
	await sql`delete from users where id = ${id}::bigint`;
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
