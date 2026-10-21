// Branded hashtags, X's "hashflags": staff set a hashtag, a time window and a
// like animation (Lottie JSON, like the client's own heart) and/or an emoji.
// While it runs, liking a post with the hashtag plays the animation instead
// of the heart, the hashtag shows the emoji, and with hashfetti on, the
// emoji rains over its search results. The client reads them all from
// /1.1/hashflags.json at start.

import { type Action, AdminError, audit, idOf } from "./admin";
import { PUBLIC_ORIGIN } from "./config";
import { sql } from "./db";
import { newId } from "./ids";
import { sniffImage } from "./media";

const MAX_ANIMATION = 1024 * 1024;
const MAX_EMOJI = 256 * 1024;
const EXT: Record<string, string> = { "image/png": "png", "image/gif": "gif", "image/webp": "webp" };

const animationUrl = (id: string) => `${PUBLIC_ORIGIN}/public/hashflag-${id}.json`;
const emojiUrl = (id: string, mime: string) => `${PUBLIC_ORIGIN}/public/hashflag-${id}.${EXT[mime] ?? "png"}`;

// what the client fetches: running ones and those starting within a day (it
// drops the rest itself), in the camel-case layout it reads
export async function hashflagsJson() {
	const rows = await sql`select id::text, hashtag, starts_at, ends_at, like_animation is not null as liked, emoji_mime, hashfetti from hashflags
		where ends_at > now() and starts_at < now() + interval '1 day' order by starts_at`;
	return rows.map((r: any) => ({
		hashtag: r.hashtag,
		startingTimestampMs: String(r.starts_at.getTime()),
		endingTimestampMs: String(r.ends_at.getTime()),
		...(r.emoji_mime ? { assetUrl: emojiUrl(r.id, r.emoji_mime) } : {}),
		...(r.hashfetti && r.emoji_mime ? { isHashfettiEnabled: true } : {}),
		...(r.liked ? { animations: [{ context: "Like", assetUrl: animationUrl(r.id), priority: 1 }] } : {}),
	}));
}

// /public/hashflag-<id>.json and .png/.gif/.webp; ids change with every new
// upload, so they can be cached for good
export async function hashflagAsset(id: string, ext: string) {
	if (BigInt(id) > 9223372036854775807n) return new Response(null, { status: 404 });
	const [r] = await sql`select like_animation, emoji, emoji_mime from hashflags where id = ${id}::bigint`;
	const cache = { "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" };
	if (r && ext === "json" && r.like_animation) return new Response(r.like_animation, { headers: { "content-type": "application/json", ...cache } });
	if (r && ext !== "json" && r.emoji && EXT[r.emoji_mime] === ext) return new Response(new Uint8Array(r.emoji), { headers: { "content-type": r.emoji_mime, ...cache } });
	return new Response(null, { status: 404 });
}

const decode = (value: unknown, max: number, what: string) => {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string" || value.length > Math.ceil(max / 3) * 4 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new AdminError(`${what} is up to ${max / 1024} KB.`);
	const buf = Buffer.from(value, "base64");
	if (buf.length > max) throw new AdminError(`${what} is up to ${max / 1024} KB.`);
	return buf;
};

// a Lottie file: an object with a version, a size and layers
function lottie(buf: Buffer) {
	let d: any;
	try {
		d = JSON.parse(buf.toString("utf8"));
	} catch {
		throw new AdminError("The animation isn't JSON. Export it from After Effects (Bodymovin) or LottieFiles as Lottie JSON.");
	}
	if (!d || typeof d !== "object" || typeof d.v !== "string" || !Array.isArray(d.layers) || !(d.w > 0) || !(d.h > 0) || !(d.op > 0))
		throw new AdminError("That JSON isn't a Lottie animation (it needs v, w, h, op and layers).");
	return JSON.stringify(d);
}

function when(value: unknown, what: string) {
	const d = new Date(String(value ?? ""));
	if (Number.isNaN(d.getTime())) throw new AdminError(`Give the ${what} time.`);
	return d;
}

export const hashflagActions: Record<string, Action> = {
	hashflags: {
		role: "support",
		run: async () => ({
			hashflags: (await sql`select id::text, hashtag, starts_at, ends_at, like_animation is not null as has_like, emoji_mime, hashfetti, created_at from hashflags order by ends_at desc`).map((r: any) => ({
				...r,
				like_url: r.has_like ? animationUrl(r.id) : null,
				emoji_url: r.emoji_mime ? emojiUrl(r.id, r.emoji_mime) : null,
			})),
		}),
	},
	createHashflag: {
		role: "admin",
		run: async (a, b) => {
			const hashtag = String(b.hashtag ?? "").trim().replace(/^#/, "");
			if (!/^[\p{L}\p{N}_]{1,100}$/u.test(hashtag)) throw new AdminError("A hashtag is letters, digits and underscores.");
			const starts = when(b.starts_at, "start");
			const ends = when(b.ends_at, "end");
			if (ends <= starts) throw new AdminError("It has to end after it starts.");
			const anim = decode(b.like_animation, MAX_ANIMATION, "The animation");
			const emoji = decode(b.emoji, MAX_EMOJI, "The emoji");
			if (!anim && !emoji) throw new AdminError("Add a like animation, an emoji, or both.");
			const info = emoji ? sniffImage(emoji) : undefined;
			if (emoji && (!info || !EXT[info.mime] || info.width > 512 || info.height > 512)) throw new AdminError("The emoji is a PNG, GIF or WebP up to 512×512.");
			const id = newId();
			await sql`insert into hashflags (id, hashtag, starts_at, ends_at, like_animation, emoji, emoji_mime, hashfetti)
				values (${id}::bigint, ${hashtag}, ${starts}, ${ends}, ${anim ? lottie(anim) : null}, ${emoji ?? null}, ${info?.mime ?? null}, ${!!b.hashfetti && !!emoji})`;
			await audit(a, "create_hashflag", id, { hashtag, starts, ends });
			return { id };
		},
	},
	// end it now, keeping the record
	endHashflag: {
		role: "admin",
		run: async (a, b) => {
			const id = idOf(b.id);
			await sql`update hashflags set ends_at = greatest(starts_at + interval '1 second', now()) where id = ${id}::bigint and ends_at > now()`;
			await audit(a, "end_hashflag", id);
			return {};
		},
	},
	deleteHashflag: {
		role: "admin",
		run: async (a, b) => {
			const id = idOf(b.id);
			await sql`delete from hashflags where id = ${id}::bigint`;
			await audit(a, "delete_hashflag", id);
			return {};
		},
	},
};
