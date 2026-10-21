// Settings > Privacy > Content you see > Explore settings: where trends come
// from. Places are "Worldwide" and the countries accounts are based in (the
// edge's country header, see countries.ts). Kept in users.preferences.explore.

import { allCountries, countryName, isCountry } from "./countries";
import { sql } from "./db";

export const WORLDWIDE = "1";

type Stored = { place?: string; use_current_location?: boolean; use_personalized_trends?: boolean };

async function stored(userId: string): Promise<Stored & { country: string | null }> {
	const [u] = await sql`select preferences->'explore' as explore, country from users where id = ${userId}::bigint`;
	return { ...(u?.explore ?? {}), country: u?.country ?? null };
}

const placeName = (place: string) => (isCountry(place) ? countryName(place)! : "Worldwide");

export async function exploreSettings(userId: string) {
	const s = await stored(userId);
	const place = s.place && isCountry(s.place) ? s.place : WORLDWIDE;
	return {
		places: [{ place_id: place, name: placeName(place) }],
		use_current_location: s.use_current_location ?? false,
		use_personalized_trends: s.use_personalized_trends ?? true,
		is_unified_trends: false,
		is_stories_available: false,
	};
}

export async function setExploreSettings(userId: string, body: Record<string, unknown>) {
	const next: Stored = {};
	const places = Array.isArray(body.places) ? body.places : typeof body.places === "string" ? body.places.split(",") : undefined;
	const place = places?.[0] === undefined ? undefined : String(typeof places[0] === "object" ? (places[0] as any)?.place_id : places[0]);
	if (place !== undefined && (place === WORLDWIDE || isCountry(place))) next.place = place;
	for (const k of ["use_current_location", "use_personalized_trends"] as const)
		if (body[k] !== undefined) next[k] = body[k] === true || body[k] === "true";
	await sql`update users set preferences = jsonb_set(preferences, '{explore}', coalesce(preferences->'explore', '{}') || ${JSON.stringify(next)}::text::jsonb)
		where id = ${userId}::bigint`;
	return exploreSettings(userId);
}

export function searchLocations(q: string) {
	const query = q.trim().toLowerCase();
	const all = [{ place_id: WORLDWIDE, name: "Worldwide" }, ...allCountries().map((c) => ({ place_id: c.code, name: c.name }))];
	return (query ? all.filter((p) => p.name.toLowerCase().includes(query)) : all).slice(0, 60);
}

// What a viewer's trends are counted over: a country (theirs when they use
// their location or personalized trends, else the place they picked), and
// whether the people they follow weigh more.
export async function trendScope(userId: string): Promise<{ country: string | null; followedBy?: string; label: string }> {
	const s = await stored(userId);
	const personalized = s.use_personalized_trends ?? true;
	const country = personalized || s.use_current_location ? s.country : s.place && isCountry(s.place) ? s.place : null;
	const name = country && isCountry(country) ? countryName(country) : undefined;
	return { country: name ? country : null, ...(personalized ? { followedBy: userId } : {}), label: name ? `Trending in ${name}` : "Trending" };
}
