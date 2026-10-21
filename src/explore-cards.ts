// News and sports cards at the top of Explore: staff write them (Admin >
// Explore cards), there being no news wire or score feed behind an instance.
// A card opens a search for its query. News cards are X's event summaries
// (the first one with a picture as the large "hero"); sports cards are score
// event cards, which the client draws as a scoreboard.

import { PUBLIC_ORIGIN } from "./config";
import { sql } from "./db";
import { isId, newId } from "./ids";
import { sniffImage } from "./media";

export class CardError extends Error {}

const STATES = ["Scheduled", "InProgress", "Completed", "Postponed", "Cancelled"] as const;
type State = (typeof STATES)[number];

type Card = {
	id: string;
	kind: "news" | "sports";
	title: string;
	summary: string;
	category: string;
	query: string;
	has_image: boolean;
	image_width: number | null;
	image_height: number | null;
	home: string;
	away: string;
	home_score: string;
	away_score: string;
	state: State | null;
	clock: string;
	starts_at: Date | null;
	created_at: Date;
};

const cols = sql`id::text as id, kind, title, summary, category, query, image is not null as has_image, image_width, image_height,
	home, away, home_score, away_score, state, clock, starts_at, created_at`;

export async function activeCards(): Promise<Card[]> {
	return (await sql`select ${cols} from explore_cards where not hidden and (ends_at is null or ends_at > now()) order by position, created_at desc limit 10`) as Card[];
}

export async function listCards() {
	return sql`select ${cols}, hidden, ends_at, position from explore_cards order by position, created_at desc`;
}

export async function cardImage(id: string) {
	if (!isId(id)) return new Response(null, { status: 404 });
	const [c] = await sql`select image, image_mime from explore_cards where id = ${id}::bigint and image is not null`;
	if (!c) return new Response(null, { status: 404 });
	return new Response(new Uint8Array(c.image), { headers: { "content-type": c.image_mime, "cache-control": "no-cache", "x-content-type-options": "nosniff" } });
}

const text = (v: unknown, max: number, what: string, required = false) => {
	const s = typeof v === "string" ? v.trim() : "";
	if ((required && !s) || [...s].length > max) throw new CardError(`${what}: ${required ? "1" : "0"}–${max} characters.`);
	return s;
};

export async function saveCard(b: Record<string, any>): Promise<string> {
	const kind = b.kind === "sports" ? "sports" : "news";
	const row: Record<string, unknown> = {
		kind,
		title: text(b.title, 100, "Title", true),
		summary: text(b.summary, 280, "Summary"),
		category: text(b.category, 40, "Category"),
		query: text(b.query, 200, "Search", true),
		home: text(b.home, 40, "Home team", kind === "sports"),
		away: text(b.away, 40, "Away team", kind === "sports"),
		home_score: text(b.home_score, 8, "Home score"),
		away_score: text(b.away_score, 8, "Away score"),
		state: kind === "sports" ? (STATES.includes(b.state) ? b.state : "Scheduled") : null,
		clock: text(b.clock, 20, "Clock"),
		starts_at: b.starts_at ? new Date(b.starts_at) : null,
		ends_at: b.ends_at ? new Date(b.ends_at) : null,
		hidden: !!b.hidden,
		position: Number.isFinite(Number(b.position)) ? Math.trunc(Number(b.position)) : 0,
	};
	for (const k of ["starts_at", "ends_at"]) if (row[k] && Number.isNaN((row[k] as Date).getTime())) throw new CardError("Use a valid date.");
	if (typeof b.image === "string" && b.image) {
		if (b.image.length > 1_400_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b.image)) throw new CardError("Pictures are up to 1 MB.");
		const image = Buffer.from(b.image, "base64");
		const info = sniffImage(image);
		if (!info || !["image/png", "image/jpeg", "image/webp"].includes(info.mime)) throw new CardError("Use a PNG, JPEG or WebP picture.");
		Object.assign(row, { image, image_mime: info.mime, image_width: info.width, image_height: info.height });
	}
	if (b.removeImage) Object.assign(row, { image: null, image_mime: null, image_width: null, image_height: null });
	if (b.id) {
		if (!isId(b.id)) throw new CardError("No such card.");
		const done = await sql`update explore_cards set ${sql(row)} where id = ${b.id}::bigint returning id`;
		if (!done.length) throw new CardError("No such card.");
		return b.id;
	}
	const id = newId();
	await sql`insert into explore_cards ${sql({ id, ...row })}`;
	return id;
}

export async function deleteCard(id: string) {
	const done = await sql`delete from explore_cards where id = ${id}::bigint returning id`;
	if (!done.length) throw new CardError("No such card.");
}

const searchUrl = (q: string) => ({ url: `twitter://search/?query=${encodeURIComponent(q)}&src=trend_click&vertical=trends`, urlType: "DeepLink" });

function ago(d: Date) {
	const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
	if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
	if (s < 86400) return `${Math.round(s / 3600)} hours ago`;
	return `${Math.round(s / 86400)} days ago`;
}

function scoreEvent(c: Card) {
	const teams = [
		{ id: `${c.id}-home`, fullName: c.home, shortName: c.home, score: c.home_score || "0" },
		{ id: `${c.id}-away`, fullName: c.away, shortName: c.away, score: c.away_score || "0" },
	];
	const [h, a] = [Number(c.home_score), Number(c.away_score)];
	const winner = c.state === "Completed" && Number.isFinite(h) && Number.isFinite(a) && h !== a ? teams[h > a ? 0 : 1].id : undefined;
	return {
		id: c.id,
		category: c.category || "Sports",
		eventState: c.state ?? "Scheduled",
		...(c.clock ? { gameClockPeriod: c.clock } : {}),
		participants: teams,
		...(c.starts_at ? { startTimeMillis: String(c.starts_at.getTime()) } : {}),
		...(winner ? { winnerId: winner } : {}),
		summary: c.summary,
		url: searchUrl(c.query),
	};
}

// Explore's first entries: one module of cards
export function cardsEntry(cards: Card[], sortIndex: string) {
	const hero = cards.find((c) => c.kind === "news" && c.has_image);
	const items = cards.map((c) => ({
		entryId: `explore-cards-event-${c.id}`,
		item: {
			itemContent: c.kind === "sports" ? { __typename: "TimelineScoreEventCard", itemType: "TimelineScoreEventCard", score_event: scoreEvent(c) } : {
				__typename: "TimelineEventSummary",
				itemType: "TimelineEventSummary",
				event: { rest_id: c.id, id: Buffer.from(`ApiLiveEvent:${c.id}`).toString("base64") },
				eventSummaryDisplayType: c === hero ? "Hero" : "Cell",
				eventSummaryUrl: searchUrl(c.query),
				title: c.title,
				supportingText: c.summary,
				timeString: c.kind === "sports" ? c.category || "Sports" : `${c.category ? `${c.category} · ` : ""}${ago(c.created_at)}`,
				...(c.has_image ? { image: { url: `${PUBLIC_ORIGIN}/public/card-${c.id}.img`, width: c.image_width ?? 1200, height: c.image_height ?? 675 } } : {}),
			},
			clientEventInfo: { component: "event_summary", element: c.kind === "sports" ? "score_event" : "news" },
		},
	}));
	return {
		entryId: "explore-cards",
		sortIndex,
		content: { __typename: "TimelineTimelineModule", entryType: "TimelineTimelineModule", displayType: "Vertical", items },
	};
}
