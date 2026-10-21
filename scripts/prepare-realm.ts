import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const output = resolve(process.argv[2] ?? "data/realm-deploy");
const secrets = JSON.parse(readFileSync("data/chat-secrets.json", "utf8"));
const password = randomBytes(32).toString("hex");
const env = {
	POSTGRES_USER: "xitter", POSTGRES_DB: "juicebox", POSTGRES_PASSWORD: password,
	DATABASE_URL: `postgres://xitter:${password}@database:5432/juicebox`,
	TENANT_SECRETS: JSON.stringify({ xitter: { "1": secrets.tenantSecret } }),
	REALM_ID: secrets.realmId,
};
mkdirSync(output, { recursive: true });
writeFileSync(resolve(output, "realm.env"), Object.entries(env).map(([key, value]) => `${key}='${value}'`).join("\n") + "\n", { mode: 0o600, flag: "wx" });
console.log("Wrote private realm configuration.");
