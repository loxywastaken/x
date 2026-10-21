// The structure of captured replies: keys and types, no values (except type
// names and enum-like fields), since chat samples hold other people's data.
// usage: bun scripts/sample-shape.ts <part of a sample name>...   (MAX=chars, DIR=samples dir)
import { readdirSync } from "node:fs";
const dir = process.env.DIR ?? "samples/chat/chat";
const want = process.argv.slice(2);
const ENUMISH = /typename|type$|_type_|state$|status$|^reason$|setting|allow_|filter|shape|method|enum/;
const shape = (v: any, d = 0, key = ""): any => {
	if (d > 11) return "…";
	if (Array.isArray(v)) return v.length ? [shape(v[0], d + 1, key), `×${v.length}`] : [];
	if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x, d + 1, k)]));
	if (typeof v === "string" && /^[[{]/.test(v)) {
		try {
			return shape(JSON.parse(v), d, key);
		} catch {}
	}
	if (typeof v === "string") return /^\d+$/.test(v) ? "numstr" : v.length < 40 && ENUMISH.test(key) ? `"${v}"` : `str${v.length}`;
	return typeof v === "boolean" || v === null ? v : typeof v;
};
for (const f of readdirSync(dir).filter((f) => want.some((w) => f.includes(w)))) {
	const j = JSON.parse(await Bun.file(`${dir}/${f}`).text());
	let body: any = j.response;
	try { body = JSON.parse(j.response); } catch {}
	if (process.env.PICK) {
		const matches: unknown[] = [];
		const visit = (value: any) => { if (!value || typeof value !== "object") return; for (const [key, item] of Object.entries(value)) { if (key === process.env.PICK) matches.push(shape(item)); else visit(item); } };
		visit(body);
		console.log(f, JSON.stringify(matches.slice(0, 4), null, 1).slice(0, Number(process.env.MAX ?? 2500)));
		continue;
	}
	console.log(`== ${f} ${j.status} vars:`, JSON.stringify(shape(Object.fromEntries(Object.entries(j.query ?? {}).map(([k, v]: any) => { try { return [k, JSON.parse(v)]; } catch { return [k, v]; } })))).slice(0, 600));
	if (j.requestBody) console.log("request:", JSON.stringify(shape(j.requestBody), null, 1).slice(0, Number(process.env.MAX ?? 2500)));
	console.log(JSON.stringify(shape(body), null, 1).slice(0, Number(process.env.MAX ?? 2500)));
}
