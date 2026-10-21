// Turns raw HAR captures into cleaned per-request samples.
// usage: bun scripts/har-extract.ts [har-raw] [samples]
//
// Raw HARs hold live cookies and the account password, so nothing from them is
// written verbatim: credential-bearing headers are dropped, every cookie value is
// scrubbed from all text, login request bodies are reduced to their shape, and
// sensitive JSON keys and e-mail addresses are masked.

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const rawDir = process.argv[2] ?? "har-raw";
const outDir = process.argv[3] ?? "samples";

const STATIC_EXT = /\.(js|css|png|jpe?g|gif|webp|svg|woff2?|mp4|m4s|m3u8|ico|map)$/i;
const STATIC_HOST = /(^|\.)twimg\.com$|gstatic\.com$/;
const OWN_HOST = /(^|\.)x\.com$|(^|\.)twitter\.com$/;
const DROP_HEADERS = new Set([
	"cookie",
	"set-cookie",
	"authorization",
	"x-csrf-token",
	"x-guest-token",
	"x-client-transaction-id",
	"x-xp-forwarded-for",
	"x-client-uuid",
]);
const SENSITIVE_KEY = /pass(word)?|e?mail|phone|jwt|secret|(^|_)token$|^auth_|session/i;
// request bodies of these carry the login name and password
const SHAPE_ONLY = /\/onboarding\/|\/flow\/|login|password|account\/settings/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]{2,}/g;
// pages set some cookies from inline script, with values that never show up in a header
const COOKIE_ASSIGN =
	/\b(ct0|auth_token|twid|kdt|att|gt|guest_id(?:_\w+)?|personalization_id|cf_clearance|__cf_bm|__cuid)=([^;"'\s&<\\]{4,})/g;
// sensitive fields inside JSON embedded in HTML, where maskKeys cannot reach
const INLINE_FIELD = /("[A-Za-z_]*(?:phone|e?mail|password|auth_token|jwt)[A-Za-z_]*"\s*:\s*)"[^"]*"/gi;

type Header = { name: string; value: string };
type Entry = {
	startedDateTime: string;
	request: {
		method: string;
		url: string;
		headers: Header[];
		cookies?: Header[];
		postData?: { mimeType?: string; text?: string };
	};
	response: {
		status: number;
		headers: Header[];
		cookies?: Header[];
		content?: { mimeType?: string; text?: string; encoding?: string };
	};
};

function collectSecrets(entries: Entry[]): string[] {
	const secrets = new Set<string>();
	const add = (v?: string) => {
		if (!v || v.length < 8) return;
		secrets.add(v);
		try {
			const d = decodeURIComponent(v);
			if (d.length >= 8) secrets.add(d);
		} catch {}
	};
	for (const e of entries) {
		for (const c of e.request.cookies ?? []) add(c.value);
		for (const c of e.response.cookies ?? []) add(c.value);
		for (const h of [...e.request.headers, ...e.response.headers]) {
			const n = h.name.toLowerCase();
			if (n === "cookie") for (const part of h.value.split(/;\s*/)) add(part.slice(part.indexOf("=") + 1));
			if (n === "set-cookie")
				for (const line of h.value.split("\n")) add(line.split(";")[0].slice(line.indexOf("=") + 1));
			if (n === "x-csrf-token" || n === "x-guest-token") add(h.value);
		}
	}
	// longest first so a secret containing another one is replaced whole
	return [...secrets].sort((a, b) => b.length - a.length);
}

function makeScrubber(secrets: string[]) {
	return (text: string) => {
		let out = text;
		for (const s of secrets) if (out.includes(s)) out = out.split(s).join("<scrubbed>");
		return out.replace(COOKIE_ASSIGN, "$1=<scrubbed>").replace(INLINE_FIELD, '$1"<masked>"').replace(EMAIL, "<email>");
	};
}

function maskKeys(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(maskKeys);
	if (v && typeof v === "object") {
		const o: Record<string, unknown> = {};
		for (const [k, val] of Object.entries(v)) {
			if (SENSITIVE_KEY.test(k) && (typeof val === "string" || typeof val === "number")) o[k] = "<masked>";
			else o[k] = maskKeys(val);
		}
		return o;
	}
	return v;
}

// structure of a value with every leaf replaced by its type
function shapeOf(v: unknown): unknown {
	if (Array.isArray(v)) return v.length ? [shapeOf(v[0]), `(${v.length} items)`] : [];
	if (v && typeof v === "object")
		return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, shapeOf(val)]));
	if (typeof v === "string") return `<string ${v.length}>`;
	return `<${v === null ? "null" : typeof v}>`;
}

function tryJson(text: string): unknown | undefined {
	const t = text.trim();
	if (!t || (t[0] !== "{" && t[0] !== "[")) return undefined;
	try {
		return JSON.parse(t);
	} catch {
		return undefined;
	}
}

function headersOf(list: Header[], scrub: (s: string) => string) {
	const o: Record<string, string> = {};
	for (const h of list) {
		const n = h.name.toLowerCase();
		if (DROP_HEADERS.has(n) || n.startsWith(":")) continue;
		o[n] = scrub(h.value);
	}
	return o;
}

function nameOf(url: URL): string {
	const parts = url.pathname.split("/").filter(Boolean);
	const gql = parts.indexOf("graphql");
	if (gql >= 0) return parts[parts.length - 1];
	return (
		parts
			.slice(-3)
			.join("_")
			.replace(/[^A-Za-z0-9._-]/g, "")
			.slice(0, 60) || "root"
	);
}

function processHar(file: string) {
	const label = basename(file, ".har");
	const har = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
	const entries: Entry[] = har.log.entries;
	const scrub = makeScrubber(collectSecrets(entries));
	const dir = join(outDir, label);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });

	const index: string[] = ["seq\ttime\tmethod\tstatus\thost\tname\trespBytes\tfile"];
	const clientFiles = new Set<string>();
	let seq = 0;

	for (const e of entries) {
		let url: URL;
		try {
			url = new URL(e.request.url);
		} catch {
			continue;
		}
		if (STATIC_HOST.test(url.hostname) || STATIC_EXT.test(url.pathname)) {
			if (url.hostname === "abs.twimg.com" || url.hostname.endsWith("x.com")) clientFiles.add(url.origin + url.pathname);
			continue;
		}
		if (e.request.method === "OPTIONS" || !OWN_HOST.test(url.hostname)) continue;
		seq++;

		const query: Record<string, unknown> = {};
		for (const [k, v] of url.searchParams) query[k] = maskKeys(tryJson(v) ?? scrub(v));

		const shapeOnly = SHAPE_ONLY.test(url.pathname);
		const post = e.request.postData?.text;
		let requestBody: unknown;
		if (post) {
			const parsed = tryJson(post);
			if (shapeOnly) {
				const mime = e.request.postData?.mimeType ?? "";
				let shape: unknown = `<${post.length} bytes>`;
				if (parsed) shape = shapeOf(parsed);
				else if (/urlencoded/.test(mime))
					shape = Object.fromEntries([...new URLSearchParams(post)].map(([k, v]) => [k, shapeOf(tryJson(v) ?? v)]));
				requestBody = { shapeOnly: true, mime, shape };
			}
			else requestBody = parsed ? maskKeys(JSON.parse(scrub(JSON.stringify(parsed)))) : scrub(post);
		}

		const content = e.response.content ?? {};
		let body = content.text ?? "";
		if (content.encoding === "base64" && body) body = Buffer.from(body, "base64").toString("utf8");
		const respBytes = body.length;
		const parsedBody = tryJson(body);
		const isHtml = /html/.test(content.mimeType ?? "");
		const name = nameOf(url);
		const stem = `${String(seq).padStart(3, "0")}-${e.request.method}-${name}`;

		const record = {
			time: e.startedDateTime,
			method: e.request.method,
			host: url.hostname,
			path: url.pathname,
			query,
			requestHeaders: headersOf(e.request.headers, scrub),
			requestBody,
			status: e.response.status,
			responseHeaders: headersOf(e.response.headers, scrub),
			responseMime: content.mimeType,
			response: parsedBody !== undefined ? maskKeys(JSON.parse(scrub(JSON.stringify(parsedBody)))) : isHtml ? `<see ${stem}.html>` : scrub(body),
		};
		writeFileSync(join(dir, `${stem}.json`), JSON.stringify(record, null, "\t"));
		if (isHtml && body) writeFileSync(join(dir, `${stem}.html`), scrub(body));
		index.push([seq, e.startedDateTime.slice(11, 23), e.request.method, e.response.status, url.hostname, name, respBytes, `${stem}.json`].join("\t"));
	}

	writeFileSync(join(dir, "_index.tsv"), index.join("\n") + "\n");
	writeFileSync(join(dir, "_client-files.txt"), [...clientFiles].sort().join("\n") + "\n");
	console.log(`${label}: ${seq} samples, ${clientFiles.size} client files -> ${dir}`);
}

mkdirSync(outDir, { recursive: true });
for (const f of readdirSync(rawDir).filter((f) => f.endsWith(".har"))) processHar(join(rawDir, f));
