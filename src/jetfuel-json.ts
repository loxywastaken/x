// Decoded Jetfuel messages hold bigints and Maps, which JSON can't; these mark
// them so templates can be stored as JSON and read back unchanged.

export function toJson(v: any): any {
	if (typeof v === "bigint") return { $big: v.toString() };
	if (v instanceof Map) return { $map: [...v].map(([k, x]) => [toJson(k), toJson(x)]) };
	if (Array.isArray(v)) return v.map(toJson);
	if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toJson(x)]));
	return v;
}

export function fromJson(v: any): any {
	if (Array.isArray(v)) return v.map(fromJson);
	if (v && typeof v === "object") {
		if ("$big" in v) return BigInt(v.$big);
		if ("$map" in v) return new Map(v.$map.map(([k, x]: [any, any]) => [fromJson(k), fromJson(x)]));
		return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fromJson(x)]));
	}
	return v;
}
