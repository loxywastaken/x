// Sticker packs: staff upload them in the admin panel, people pick one from
// the composer's sticker button and it is attached like any uploaded image
// (tidy.ts STICKER_SCRIPT). The images are public, like the logos.

import { type Action, AdminError, audit, idOf } from "./admin";
import { sql } from "./db";
import { newId } from "./ids";
import { sniffImage } from "./media";

const MAX_BYTES = 1024 * 1024;
const MAX_SIDE = 1024;
const EXT: Record<string, string> = { "image/png": "png", "image/gif": "gif", "image/webp": "webp" };

const nameOf = (value: unknown, max: number, what: string) => {
	const s = typeof value === "string" ? value.trim() : "";
	if ([...s].length > max) throw new AdminError(`${what} is at most ${max} characters.`);
	return s;
};

export async function stickerImage(id: string) {
	if (BigInt(id) > 9223372036854775807n) return new Response(null, { status: 404 });
	const [s] = await sql`select image, mime from stickers where id = ${id}::bigint`;
	if (!s) return new Response(null, { status: 404 });
	// a sticker never changes: a new image is a new id
	return new Response(new Uint8Array(s.image), { headers: { "content-type": s.mime, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" } });
}

export const stickerUrl = (id: string, mime: string) => `/public/sticker-${id}.${EXT[mime] ?? "png"}`;

// what the picker shows: packs in order, each with its stickers
export async function stickerPacks() {
	const packs = await sql`select id::text, name from sticker_packs order by position, id`;
	const stickers = await sql`select id::text, pack_id::text, name, mime from stickers order by position, id`;
	return packs.map((p: any) => ({
		id: p.id,
		name: p.name,
		stickers: stickers.filter((s: any) => s.pack_id === p.id).map((s: any) => ({ id: s.id, name: s.name, url: stickerUrl(s.id, s.mime) })),
	}));
}

export const stickerActions: Record<string, Action> = {
	stickers: { role: "support", run: async () => ({ packs: await stickerPacks() }) },
	createStickerPack: {
		role: "admin",
		run: async (a, b) => {
			const name = nameOf(b.name, 40, "A pack name");
			if (!name) throw new AdminError("Name the pack.");
			const id = newId();
			await sql`insert into sticker_packs (id, name, position) values (${id}::bigint, ${name}, (select coalesce(max(position), 0) + 1 from sticker_packs))`;
			await audit(a, "create_sticker_pack", id, { name });
			return { id };
		},
	},
	renameStickerPack: {
		role: "admin",
		run: async (a, b) => {
			const id = idOf(b.id);
			const name = nameOf(b.name, 40, "A pack name");
			if (!name) throw new AdminError("Name the pack.");
			await sql`update sticker_packs set name = ${name} where id = ${id}::bigint`;
			await audit(a, "rename_sticker_pack", id, { name });
			return {};
		},
	},
	// up or down one place
	moveStickerPack: {
		role: "admin",
		run: async (_a, b) => {
			const id = idOf(b.id);
			const packs = (await sql`select id::text from sticker_packs order by position, id`).map((p: any) => p.id);
			const i = packs.indexOf(id);
			const j = i + (b.dir === "up" ? -1 : 1);
			if (i < 0 || j < 0 || j >= packs.length) return {};
			[packs[i], packs[j]] = [packs[j], packs[i]];
			await sql.begin(async (tx) => {
				for (const [pos, pid] of packs.entries()) await tx`update sticker_packs set position = ${pos} where id = ${pid}::bigint`;
			});
			return {};
		},
	},
	deleteStickerPack: {
		role: "admin",
		run: async (a, b) => {
			const id = idOf(b.id);
			await sql`delete from sticker_packs where id = ${id}::bigint`;
			await audit(a, "delete_sticker_pack", id);
			return {};
		},
	},
	addSticker: {
		role: "admin",
		run: async (a, b) => {
			const pack = idOf(b.pack, "pack");
			const name = nameOf(b.name, 40, "A sticker name");
			const encoded = typeof b.image === "string" ? b.image : "";
			if (!encoded || encoded.length > Math.ceil(MAX_BYTES / 3) * 4 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new AdminError("Upload an image up to 1 MB.");
			const image = Buffer.from(encoded, "base64");
			const info = sniffImage(image);
			if (image.length > MAX_BYTES || !info || !EXT[info.mime] || info.width > MAX_SIDE || info.height > MAX_SIDE)
				throw new AdminError(`Use a PNG, GIF or WebP up to ${MAX_SIDE}×${MAX_SIDE} and 1 MB.`);
			const [p] = await sql`select 1 from sticker_packs where id = ${pack}::bigint`;
			if (!p) throw new AdminError("No such pack.", 404);
			const id = newId();
			await sql`insert into stickers (id, pack_id, name, image, mime, position)
				values (${id}::bigint, ${pack}::bigint, ${name}, ${image}, ${info.mime}, (select coalesce(max(position), 0) + 1 from stickers where pack_id = ${pack}::bigint))`;
			await audit(a, "add_sticker", id, { pack, name });
			return { id };
		},
	},
	deleteSticker: {
		role: "admin",
		run: async (a, b) => {
			const id = idOf(b.id);
			await sql`delete from stickers where id = ${id}::bigint`;
			await audit(a, "delete_sticker", id);
			return {};
		},
	},
};
