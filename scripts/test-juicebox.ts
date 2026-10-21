import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client, Configuration, setAuthTokenResolver } from "../node_modules/emusks/src/helpers/juicebox/index.js";

const mode = process.argv[2] ?? "register";
const address = process.env.TEST_JUICEBOX_URL ?? "http://localhost:8580/";
const { realmId, tenantSecret } = process.env.REALM_ID && process.env.TENANT_SECRETS
	? { realmId: process.env.REALM_ID, tenantSecret: JSON.parse(process.env.TENANT_SECRETS).xitter["1"] }
	: JSON.parse(readFileSync("data/chat-secrets.json", "utf8"));
const header = Buffer.from(JSON.stringify({ alg: "HS256", kid: "xitter:1" })).toString("base64url");
const body = Buffer.from(JSON.stringify({ iss: "xitter", sub: "xitter-durability-test", aud: realmId, scope: "user", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
const token = `${header}.${body}.${createHmac("sha256", tenantSecret).update(`${header}.${body}`).digest("base64url")}`;
setAuthTokenResolver(() => token);
const client = new Client(new Configuration(JSON.stringify({ realms: [{ id: realmId, address }], register_threshold: 1, recover_threshold: 1, pin_hashing_mode: "Standard2019" })), []);
const pin = new TextEncoder().encode("1234");
const info = new Uint8Array(0);
const secret = new Uint8Array(32).fill(42);
if (mode === "register") await client.register(pin, secret, info, 20);
const recovered = new Uint8Array(await client.recover(pin, info));
if (!Buffer.from(recovered).equals(Buffer.from(secret))) throw new Error("Recovered key differs.");
console.log(mode === "register" ? "realm register/recover passed" : "realm recovery after restart passed");
process.exit(0);
