import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { verifyChatToken } from "../src/chat-token";

const key = "local-test-key";
function token(payload: unknown, algorithm = "HS256", raw = false) {
	const header = Buffer.from(JSON.stringify({ alg: algorithm })).toString("base64url");
	const body = Buffer.from(raw ? String(payload) : JSON.stringify(payload)).toString("base64url");
	const input = `${header}.${body}`;
	return `${input}.${createHmac("sha256", key).update(input).digest("base64url")}`;
}
const claims = { sub: "123", exp: Math.floor(Date.now() / 1000) + 3600 };
test("accepts a valid signed socket token", () => expect(verifyChatToken(token(claims), key)?.sub).toBe("123"));
test("rejects invalid signatures and extra segments", () => {
	expect(verifyChatToken(token(claims), "wrong-key")).toBeUndefined();
	expect(verifyChatToken(token(claims) + ".extra", key)).toBeUndefined();
});
test("malformed signed payloads cannot throw", () => {
	for (const body of ["{", "null", "[]", '"text"']) expect(verifyChatToken(token(body, "HS256", true), key)).toBeUndefined();
	for (const body of ["", ".", "a.b.c", "a.b.!"]) expect(verifyChatToken(body, key)).toBeUndefined();
});
test("requires expiry and a numeric user identity", () => {
	for (const change of [{ exp: 0 }, { exp: Date.now() / 1000 - 1 }, { exp: "9999999999" }, { exp: null }, { sub: 123 }, { sub: "other" }, { sub: "" }])
		expect(verifyChatToken(token({ ...claims, ...change }), key)).toBeUndefined();
	expect(verifyChatToken(token({ sub: "123" }), key)).toBeUndefined();
	expect(verifyChatToken(token(claims, "none"), key)).toBeUndefined();
});
