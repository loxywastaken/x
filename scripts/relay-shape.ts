// Prints the response field tree of a relay operation from the pinned client
// bundle. The compiled artifacts are webpack modules; this runs the one
// module that declares the operation and walks its `operation` selections.
// usage: bun scripts/relay-shape.ts <OperationOrQueryName> [maxDepth] [chunk filter]
// Output: `field` (scalar), `field {` (object), `... on Type` (inline fragment).

import { readdirSync, readFileSync } from "node:fs";

const [name, depthArg, only] = process.argv.slice(2);
if (!name) throw new Error("usage: bun scripts/relay-shape.ts <name> [maxDepth] [chunk filter]");
const maxDepth = Number(depthArg) || 12;
const dir = "client/abs/responsive-web/client-web/";

// Relay artifacts share sub-trees through short hoisted variables (`lu`, `nq`,
// ...). Each use is replaced by the text of its nearest earlier assignment.
function matchBrace(s: string, open: number): number {
	const closer: Record<string, string> = { "{": "}", "[": "]" };
	const stack: string[] = [];
	let quote = "";
	for (let i = open; i < s.length; i++) {
		const c = s[i];
		if (quote) {
			if (c === "\\") i++;
			else if (c === quote) quote = "";
			continue;
		}
		if (c === '"' || c === "'" || c === "`") quote = c;
		else if (c === "{" || c === "[") stack.push(closer[c]);
		else if (c === "}" || c === "]") {
			stack.pop();
			if (!stack.length) return i;
		}
	}
	return -1;
}

const isId = (c: string) => /[\w$]/.test(c);

const inline = new Map<string, string>();

function resolve(src: string, text: string, before: number, depth = 0): string {
	if (depth > 40) throw new Error("variable chain too deep");
	let out = "";
	let quote = "";
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quote) {
			out += c;
			if (c === "\\") out += text[++i];
			else if (c === quote) quote = "";
			continue;
		}
		if (c === '"' || c === "'") {
			quote = c;
			out += c;
			continue;
		}
		if (/[A-Za-z_$]/.test(c) && !isId(text[i - 1] ?? "") && text[i - 1] !== ".") {
			let j = i;
			while (j < text.length && isId(text[j])) j++;
			const word = text.slice(i, j);
			const key = text[j] === ":" || text[j] === "(";
			if (key || /^(null|true|false|void|undefined|function|new)$/.test(word)) {
				out += word;
				i = j - 1;
				continue;
			}
			// an assignment inside the artifact: `name=[...]` defines it for later uses
			if (text[j] === "=" && text[j + 1] !== "=" && (text[j + 1] === "[" || text[j + 1] === "{")) {
				const stop = matchBrace(text, j + 1);
				const value = `(${resolve(src, text.slice(j + 1, stop + 1), before, depth + 1)})`;
				inline.set(word, value);
				out += value;
				i = stop;
				continue;
			}
			if (inline.has(word)) {
				out += inline.get(word);
				i = j - 1;
				continue;
			}
			// nearest assignment `word=` or `word=[` before this artifact
			const re = new RegExp(`(?<![\\w$.])${word.replace(/\$/g, "\\$")}=([\\[{])`, "g");
			let last = -1;
			let m: RegExpExecArray | null;
			const window = src.slice(Math.max(0, before - 400000), before);
			const base = Math.max(0, before - 400000);
			while ((m = re.exec(window))) last = base + m.index + word.length + 1;
			if (last < 0) {
				out += JSON.stringify({ __unresolved: word });
				i = j - 1;
				continue;
			}
			const end = matchBrace(src, last);
			out += `(${resolve(src, src.slice(last, end + 1), last, depth + 1)})`;
			i = j - 1;
			continue;
		}
		out += c;
	}
	return out;
}

function find(): any {
	for (const f of readdirSync(dir)) {
		if (!f.endsWith(".js") || (only && !f.includes(only))) continue;
		const s = readFileSync(dir + f, "utf8");
		const key = `name:"${name}",operationKind`;
		let i = -1;
		while ((i = s.indexOf(key, i + 1)) >= 0) {
			// aliased inline fragments nest their own `{fragment:{`, so walk back to
			// the one that encloses the name
			let start = s.lastIndexOf("{fragment:{", i);
			let end = start < 0 ? -1 : matchBrace(s, start);
			while (start > 0 && (end < 0 || end < i)) {
				start = s.lastIndexOf("{fragment:{", start - 1);
				end = start < 0 ? -1 : matchBrace(s, start);
			}
			if (start < 0 || end < i) continue;
			const text = s.slice(start, end + 1);
			try {
				inline.clear();
				return new Function(`return (${resolve(s, text, start)})`)();
			} catch (e) {
				if (process.env.DEBUG) console.error(f.slice(0, 30), String(e).slice(0, 200));
			}
		}
	}
}

const art = find();
if (!art) {
	console.error("no artifact found for", name);
	process.exit(1);
}

function walk(sels: any[] | undefined, indent: number, depth: number, out: string[]) {
	if (!sels) return;
	for (const s of sels) {
		const pad = "  ".repeat(indent);
		if (s.kind === "ScalarField") out.push(`${pad}${s.alias && s.alias !== s.name ? `${s.alias}: ` : ""}${s.name}`);
		else if (s.kind === "LinkedField") {
			out.push(`${pad}${s.alias && s.alias !== s.name ? `${s.alias}: ` : ""}${s.name}${s.plural ? "[]" : ""} {`);
			if (depth < maxDepth) walk(s.selections, indent + 1, depth + 1, out);
		} else if (s.kind === "InlineFragment") {
			out.push(`${pad}... on ${s.type} {`);
			if (depth < maxDepth) walk(s.selections, indent + 1, depth + 1, out);
		} else if (s.kind === "FragmentSpread") {
			out.push(`${pad}...${s.name ?? "(fragment)"}`);
		} else if (s.kind === "ModuleImport") out.push(`${pad}@module ${s.documentName}`);
		else if (s.kind === "Condition" || s.kind === "Defer" || s.kind === "Stream") walk(s.selections, indent, depth, out);
		else if (s.kind === "ClientExtension") walk(s.selections, indent, depth, out);
	}
}

const out: string[] = [`# ${art.params?.name ?? name} (${art.params?.operationKind ?? "?"})`];
for (const top of art.operation.selections ?? []) {
	const vars = (top.args ?? []).filter((x: any) => x.kind === "Variable").map((x: any) => `${x.name}<-${x.variableName}`);
	if (vars.length) out.push(`# ${top.name} args: ${vars.join(", ")}`);
}
walk(art.operation.selections, 0, 0, out);
console.log(out.join("\n"));
