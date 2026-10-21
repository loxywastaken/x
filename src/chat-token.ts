import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyChatToken(token: string, key: string): Record<string, unknown> | undefined {
	try {
		const parts = token.split(".");
		if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return;
		const [header, payload, signature] = parts;
		const expected = createHmac("sha256", key).update(`${header}.${payload}`).digest();
		const supplied = Buffer.from(signature, "base64url");
		if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return;
		if (JSON.parse(Buffer.from(header, "base64url").toString()).alg !== "HS256") return;
		const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
		if (!claims || typeof claims !== "object" || Array.isArray(claims)) return;
		if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= Date.now() / 1000) return;
		if (typeof claims.sub !== "string" || !/^[1-9]\d{0,18}$/.test(claims.sub)) return;
		return claims;
	} catch {
		return;
	}
}
