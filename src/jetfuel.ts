// Jetfuel: the binary, server-driven UI format of X's sign-in and sign-up
// screens (jf.x.com, which patch.ts points at this instance). A response is a
// sequence of length-prefixed frames; each frame is one message: a tree of
// elements with their properties, a reference, or an action to run.
//
// The schema follows emusks' decoder (AGPL-3.0, https://code.lgbt/tiago/emusks,
// src/parsers/jetfuel-messages.js); here every part of it can also write, so
// captured screens can be decoded, edited and sent again.

type Codec<T = any> = { read: (r: Reader) => T; write: (w: Writer, v: T) => void };

class Reader {
	offset = 0;
	end: number;
	view: DataView;
	constructor(public bytes: Uint8Array) {
		this.end = bytes.length;
		this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	}
	take(n: number) {
		if (this.offset + n > this.end) throw new Error("truncated jetfuel message");
		const at = this.offset;
		this.offset += n;
		return at;
	}
}

class Writer {
	chunks: number[] = [];
	bytes(b: ArrayLike<number>) {
		for (let i = 0; i < b.length; i++) this.chunks.push(b[i]);
	}
	fixed(n: number, set: (v: DataView) => void) {
		const b = new Uint8Array(n);
		set(new DataView(b.buffer));
		this.bytes(b);
	}
	out() {
		return Uint8Array.from(this.chunks);
	}
}

const u8: Codec<number> = { read: (r) => r.view.getUint8(r.take(1)), write: (w, v) => w.bytes([v]) };
const uint: Codec<number> = {
	read: (r) => {
		let value = 0;
		for (let shift = 0; shift < 49; shift += 7) {
			const byte = u8.read(r);
			value += (byte & 127) * 2 ** shift;
			if (!(byte & 128)) return value;
		}
		throw new Error("invalid jetfuel integer");
	},
	write: (w, v) => {
		do {
			let byte = v % 128;
			v = Math.floor(v / 128);
			if (v > 0) byte |= 128;
			w.bytes([byte]);
		} while (v > 0);
	},
};
const i16: Codec<number> = { read: (r) => r.view.getInt16(r.take(2), true), write: (w, v) => w.fixed(2, (d) => d.setInt16(0, v, true)) };
const i32: Codec<number> = { read: (r) => r.view.getInt32(r.take(4), true), write: (w, v) => w.fixed(4, (d) => d.setInt32(0, v, true)) };
const i64: Codec<bigint> = { read: (r) => r.view.getBigInt64(r.take(8), true), write: (w, v) => w.fixed(8, (d) => d.setBigInt64(0, BigInt(v), true)) };
const f64: Codec<number> = { read: (r) => r.view.getFloat64(r.take(8), true), write: (w, v) => w.fixed(8, (d) => d.setFloat64(0, v, true)) };
const bool: Codec<boolean> = { read: (r) => Boolean(u8.read(r)), write: (w, v) => u8.write(w, v ? 1 : 0) };
const str: Codec<string> = {
	read: (r) => {
		const n = uint.read(r);
		const at = r.take(n);
		return new TextDecoder("utf-8", { fatal: true }).decode(r.bytes.subarray(at, at + n));
	},
	write: (w, v) => {
		const b = new TextEncoder().encode(v);
		uint.write(w, b.length);
		w.bytes(b);
	},
};
const tuple = (...parts: Codec[]): Codec<any[]> => ({
	read: (r) => parts.map((p) => p.read(r)),
	write: (w, v) => parts.forEach((p, i) => p.write(w, v[i])),
});
const list = <T>(item: Codec<T>): Codec<T[]> => ({
	read: (r) => {
		const n = uint.read(r);
		if (n > r.end - r.offset) throw new Error("invalid jetfuel list length");
		return Array.from({ length: n }, () => item.read(r));
	},
	write: (w, v) => {
		uint.write(w, v.length);
		for (const x of v) item.write(w, x);
	},
});
const dict = <K, V>(key: Codec<K>, value: Codec<V>): Codec<Map<K, V>> => {
	const pairs = list(tuple(key, value));
	return { read: (r) => new Map(pairs.read(r) as [K, V][]), write: (w, v) => pairs.write(w, [...v]) };
};
const optional = <T>(c: Codec<T>): Codec<T | null> => ({
	read: (r) => (bool.read(r) ? c.read(r) : null),
	write: (w, v) => {
		bool.write(w, v !== null && v !== undefined);
		if (v !== null && v !== undefined) c.write(w, v);
	},
});
const record = (fields: Record<string, Codec>): Codec<Record<string, any>> => ({
	read: (r) => Object.fromEntries(Object.entries(fields).map(([k, c]) => [k, c.read(r)])),
	write: (w, v) => Object.entries(fields).forEach(([k, c]) => c.write(w, v[k])),
});
const constant = <T>(value: T): Codec<T> => ({ read: () => value, write: () => {} });
// a one-byte tag, then that tag's value; read as [tag, value]
const variant = (schema: Record<number, Codec> | ((self: Codec) => Record<number, Codec>)): Codec<[number, any]> => {
	let codecs: Record<number, Codec>;
	const self: Codec<[number, any]> = {
		read: (r) => {
			const tag = u8.read(r);
			if (!codecs[tag]) throw new Error(`unknown jetfuel tag ${tag}`);
			return [tag, codecs[tag].read(r)];
		},
		write: (w, [tag, v]) => {
			if (!codecs[tag]) throw new Error(`unknown jetfuel tag ${tag}`);
			u8.write(w, tag);
			codecs[tag].write(w, v);
		},
	};
	codecs = typeof schema === "function" ? schema(self) : schema;
	return self;
};
const tags = (list: number[], c: Codec) => Object.fromEntries(list.map((t) => [t, c]));

const element = record({ type: i16, props: dict(i16, uint), children: list(uint), id: optional(i64), extend: optional(uint) });
const ref = variant({
	0: record({ id: i64 }),
	4: record({ id: i64, root: uint }),
	1: record({ key: i16, root: uint }),
	...tags([2, 3, 7, 8], record({ key: str, root: uint })),
	...tags([5, 6, 9, 10, 11], record({ root: uint })),
});
const mutation = variant({
	0: ref,
	1: tuple(ref, uint),
	2: tuple(ref, i16),
	3: tuple(ref, str),
	4: tuple(ref, uint, optional(i16)),
	5: tuple(ref, uint),
	6: tuple(ref, optional(tuple(uint, uint))),
	7: tuple(ref, uint),
	8: tuple(ref, uint),
});
const navigation = variant({
	0: record({ url: uint, preview: optional(uint), replace: bool }),
	9: record({ url: uint, preview: optional(uint), replace: bool }),
	1: record({ url: uint, body: optional(uint), preview: optional(uint), replace: bool }),
	8: record({ url: uint }),
	7: record({ id: uint }),
	...tags([2, 3, 4, 5, 6], constant(null)),
});
const action = variant((self) => ({
	0: mutation,
	1: record({ ref: uint, action: self, cancel: optional(self) }),
	2: list(self),
	3: record({ url: uint, body: uint, complete: optional(self), error: optional(self), optimistic: optional(self) }),
	4: record({ action: self, intensity: i16 }),
	5: record({ ref: uint, type: u8 }),
	21: record({ ref: uint, duration: i16, animation: bool }),
	19: record({ ref: uint, type: u8, allowsRotation: bool }),
	20: record({ ref: uint, overlay: uint, mode: str }),
	6: navigation,
	7: record({ type: u8, id: optional(i64) }),
	8: str,
	9: record({ urls: list(str), priority: u8 }),
	10: record({ action: str, ref: uint }),
	11: record({ type: u8, ref: uint }),
	12: record({ action: self, delaySeconds: i16 }),
	13: record({ data: str, secret: str, knownDeviceToken: str }),
	14: record({ text: str, dismissText: optional(str) }),
	15: record({ ref: uint, to: uint }),
	16: record({ ref: uint, fields: list(str) }),
	17: record({ ref: uint, using: uint }),
	18: record({ ref: uint, field: str }),
}));
const condition = variant((self) => ({
	0: record({ ref }),
	15: record({ ref }),
	...tags([1, 2, 5, 6, 7, 8], record({ ref, value: uint })),
	3: record({ ref, value: list(uint) }),
	4: record({ ref, value: list(uint) }),
	...tags([9, 10, 11], record({ ref, value: str })),
	12: tuple(self, self),
	13: tuple(self, self),
	14: self,
}));
const matrix = list(list(i32));
const property = variant({
	0: str,
	1: i32,
	3: matrix,
	25: list(tuple(matrix, condition)),
	4: i64,
	5: f64,
	6: bool,
	7: uint,
	8: list(uint),
	10: uint,
	11: str,
	12: list(tuple(u8, str, optional(str))),
	14: i64,
	15: uint,
	16: dict(i16, uint),
	17: dict(str, str),
	18: record({ ref, prop_ref: uint, is_default: bool }),
	31: record({ ref }),
	19: action,
	21: list(uint),
	22: condition,
	24: list(uint),
	26: list(str),
	27: list(i32),
	28: list(f64),
	29: list(bool),
	30: tuple(str, dict(str, str), dict(str, str), str, u8),
	13: constant(undefined),
});
const message = variant({
	0: record({ els: list(element), props: list(property), ts: i32 }),
	1: record({ ref: uint, t: optional(i32) }),
	2: action,
});

export type Message = [number, any];

// Element types and property keys are names hashed to 16 bits: MurmurHash3
// (x86, 32-bit, seed 0) of the UTF-8 name, low half, signed. As the client does.
export function nameId(name: string): number {
	const b = new TextEncoder().encode(name);
	const mul = (x: number, y: number) => Math.imul(x, y);
	const rotl = (x: number, r: number) => (x << r) | (x >>> (32 - r));
	let h = 0;
	const tail = b.length & ~3;
	for (let i = 0; i < tail; i += 4) {
		let k = b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);
		k = mul(rotl(mul(k, 0xcc9e2d51), 15), 0x1b873593);
		h = (mul(rotl(h ^ k, 13), 5) + 0xe6546b64) | 0;
	}
	let k = 0;
	switch (b.length & 3) {
		case 3:
			k ^= b[tail + 2] << 16;
		case 2:
			k ^= b[tail + 1] << 8;
		case 1:
			k ^= b[tail];
			h ^= mul(rotl(mul(k, 0xcc9e2d51), 15), 0x1b873593);
	}
	h ^= b.length;
	h = mul(h ^ (h >>> 16), 0x85ebca6b);
	h = mul(h ^ (h >>> 13), 0xc2b2ae35);
	h ^= h >>> 16;
	return (h << 16) >> 16;
}

export function decode(bytes: Uint8Array): Message[] {
	const r = new Reader(bytes);
	const out: Message[] = [];
	while (r.offset < bytes.length) {
		r.end = bytes.length;
		const length = r.view.getUint32(r.take(4), true);
		r.end = r.offset + length;
		if (r.end > bytes.length) throw new Error("truncated jetfuel frame");
		out.push(message.read(r));
		if (r.offset !== r.end) throw new Error("unexpected jetfuel frame data");
	}
	return out;
}

export function encode(messages: Message[]): Uint8Array {
	const frames: number[] = [];
	for (const m of messages) {
		const w = new Writer();
		message.write(w, m);
		const body = w.out();
		const head = new Uint8Array(4);
		new DataView(head.buffer).setUint32(0, body.length, true);
		frames.push(...head, ...body);
	}
	return Uint8Array.from(frames);
}

// Every string property, wherever it sits, for edits by value: a screen's
// texts, field names, form urls and links.
export function mapStrings(messages: Message[], fn: (s: string) => string): Message[] {
	const walk = (v: any): any => {
		if (typeof v === "string") return fn(v);
		if (Array.isArray(v)) return v.map(walk);
		if (v instanceof Map) return new Map([...v].map(([k, x]) => [walk(k), walk(x)]));
		if (v && typeof v === "object" && !(typeof v === "bigint")) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
		return v;
	};
	return walk(messages);
}
