// Explore cards: staff make a news card (with a picture) and a sports card;
// Explore shows them first, the news card large, the sports card with its
// scoreboard; hidden and expired cards don't show. Cleans up.
// usage: bun scripts/test-explore-cards.ts <admin> <viewer> <password> <image>

import { readFileSync } from "node:fs";

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const [adminName, viewerName, password, imagePath] = process.argv.slice(2);
if (!imagePath) throw new Error("usage: bun scripts/test-explore-cards.ts <admin> <viewer> <password> <image>");

async function session(username: string) {
	const r = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username, password }), redirect: "manual" });
	const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
	const csrf = cookies.find((c) => c.startsWith("ct0="))?.slice(4);
	if (!csrf) throw new Error(`login ${username} failed`);
	const headers = { cookie: cookies.join("; "), "x-csrf-token": csrf };
	const admin = async (action: string, body: object = {}) => {
		const res = await fetch(`${origin}/admin/api/${action}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
		return { status: res.status, ...(await res.json()) };
	};
	const get = async (op: string, variables: object) =>
		(await fetch(`${origin}/i/api/graphql/q/${op}?variables=${encodeURIComponent(JSON.stringify(variables))}`, { headers })).json();
	return { admin, get, headers };
}
let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${JSON.stringify(detail)}`}`);
}

const staff = await session(adminName);
const viewer = await session(viewerName);
const made: string[] = [];
const cardsModule = async () => {
	const entries = (await viewer.get("ExplorePage", {})).data.explore_page.body.timeline.instructions[0].entries;
	return entries[0]?.entryId === "explore-cards" ? entries[0].content.items.map((i: any) => i.item.itemContent) : [];
};

try {
	check("a plain account can't make cards", (await viewer.admin("saveCard", { title: "x", query: "x" })).status === 403);
	check("a card needs a search", (await staff.admin("saveCard", { title: "No search" })).status === 400);
	const news = await staff.admin("saveCard", { kind: "news", title: "Launch day", summary: "The rocket went up", category: "Space", query: "#launch", image: readFileSync(imagePath).toString("base64"), position: 0 });
	made.push(news.id);
	const sports = await staff.admin("saveCard", { kind: "sports", title: "Derby", category: "City League", query: "#derby", home: "Reds", away: "Blues", home_score: "2", away_score: "1", state: "Completed", position: 1 });
	made.push(sports.id);
	const hidden = await staff.admin("saveCard", { kind: "news", title: "Secret", query: "#secret", hidden: true, position: 2 });
	made.push(hidden.id);
	const old = await staff.admin("saveCard", { kind: "news", title: "Yesterday", query: "#old", ends_at: new Date(Date.now() - 60_000).toISOString(), position: 3 });
	made.push(old.id);

	const items = await cardsModule();
	check("Explore starts with the cards", items.length === 2, items.map((i: any) => i.title));
	const [n, s] = items;
	check("the news card is large, with its picture", n?.eventSummaryDisplayType === "Hero" && n.image?.url.endsWith(`/public/card-${news.id}.img`) && n.image.width > 0, n?.image);
	check("it opens a search", n?.eventSummaryUrl.url.startsWith("twitter://search/?query=%23launch"));
	check("and says what and when", n?.title === "Launch day" && n.supportingText === "The rocket went up" && n.timeString.startsWith("Space · "));
	const img = await fetch(`${origin}/public/card-${news.id}.img`, { headers: viewer.headers });
	check("the picture is served", img.status === 200 && (img.headers.get("content-type") ?? "").startsWith("image/"));
	const ev = s?.score_event;
	check("the sports card has a scoreboard", ev?.eventState === "Completed" && ev.participants.map((p: any) => `${p.fullName} ${p.score}`).join(", ") === "Reds 2, Blues 1", ev);
	check("with the winner", ev?.winnerId === ev?.participants[0].id);

	await staff.admin("saveCard", { id: sports.id, kind: "sports", title: "Derby", category: "City League", query: "#derby", home: "Reds", away: "Blues", home_score: "2", away_score: "3", state: "InProgress", clock: "88'", position: 1 });
	const live = (await cardsModule())[1]?.score_event;
	check("updating the score", live?.eventState === "InProgress" && live.gameClockPeriod === "88'" && live.participants[1].score === "3" && !live.winnerId, live);
} finally {
	for (const id of made) if (id) await staff.admin("deleteCard", { id });
}
check("deleted cards are gone", (await cardsModule()).length === 0);

console.log(failures ? `${failures} failed` : "all checks passed");
process.exit(failures ? 1 : 0);
