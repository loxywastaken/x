// Field layout of the Thrift blobs (base64 strings) in captured chat replies
// and requests: ids and wire types, string lengths, no contents.
// usage: bun scripts/thrift-shape.ts <part of a sample name>...   (DIR=samples dir)

import { readdirSync } from "node:fs";
import { type Struct, type Value, decode, encode, fromBase64 } from "../src/thrift";

const dir = process.env.DIR ?? "samples/chat/chat";
const NAMES: Record<number, string> = { 2: "bool", 3: "byte", 4: "double", 6: "i16", 8: "i32", 10: "i64", 11: "str", 12: "struct", 13: "map", 14: "set", 15: "list" };

function layout(s: Struct, depth = 0): any {
	return Object.fromEntries(Object.entries(s).map(([id, v]) => [id, describe(v, depth)]));
}
function describe(v: Value, depth: number): any {
	if (v.t === 12) return depth > 8 ? "struct…" : layout(v.v, depth + 1);
	if (v.t === 15 || v.t === 14) return [`${NAMES[v.e]}×${v.v.length}`, ...(v.v[0] ? [describe(v.v[0], depth + 1)] : [])];
	if (v.t === 13) return `map ${NAMES[v.k]}->${NAMES[v.e]} ×${v.v.length}`;
	if (v.t === 11) {
		// a nested struct sent as bytes?
		try {
			const inner = decode(v.v);
			if (Object.keys(inner).length) return { "bytes(struct)": layout(inner, depth + 1) };
		} catch {}
		const s = new TextDecoder().decode(v.v);
		return /^\d{1,20}$/.test(s) ? "str(num)" : `str${v.v.length}`;
	}
	return NAMES[v.t];
}

// every base64 string in a JSON value that decodes as a Thrift struct
function* blobs(v: any, path: string): Generator<[string, Uint8Array]> {
	if (typeof v === "string") {
		if (v.length >= 16 && /^[A-Za-z0-9+/=]+$/.test(v)) {
			const b = fromBase64(v);
			try {
				decode(b);
				yield [path, b];
			} catch {}
		} else if (/^[[{]/.test(v)) {
			try {
				yield* blobs(JSON.parse(v), path);
			} catch {}
		}
	} else if (Array.isArray(v)) for (const [i, x] of v.entries()) yield* blobs(x, `${path}[${i}]`);
	else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) yield* blobs(x, `${path}.${k}`);
}

const want = process.argv.slice(2);
const seen = new Set<string>();
for (const f of readdirSync(dir).filter((f) => want.some((w) => f.includes(w)))) {
	const j = JSON.parse(await Bun.file(`${dir}/${f}`).text());
	let res: any = j.response;
	try {
		res = JSON.parse(res);
	} catch {}
	for (const [where, v] of [["request", j.requestBody], ["response", res]] as const)
		for (const [path, b] of blobs(v, where)) {
			const key = `${f.replace(/^\d+-/, "")} ${path.replace(/\[\d+\]/g, "[]")}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const roundTrip = Buffer.from(encode(decode(b))).equals(Buffer.from(b));
			console.log(`== ${f} ${path} (${b.length} bytes, round trip ${roundTrip ? "ok" : "DIFFERS"})`);
			console.log(JSON.stringify(layout(decode(b))));
		}
}
