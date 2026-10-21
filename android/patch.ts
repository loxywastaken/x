// Turns X's Android app (unpacked with apktool) into a client of this
// instance. Edits the smali and manifest in place; safe to run twice.
// usage: bun android/patch.ts <apktool dir>
//
// The app itself is X's and stays out of this repository: android/build.sh
// pulls it from a phone, unpacks it, runs this, then rebuilds and signs it.

import { Glob } from "bun";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) throw new Error("usage: bun android/patch.ts <apktool dir>");

let changed = 0;
const done: string[] = [];

// the first smali file at this class path, in whichever dex folder holds it
async function smali(classPath: string): Promise<string> {
	for await (const f of new Glob(`smali*/${classPath}.smali`).scan(dir)) return join(dir, f);
	throw new Error(`no class ${classPath}`);
}

// replaces the body of one method; `to` changes its signature line too (a
// native method that gets a body must lose "native")
async function replaceMethod(classPath: string, signature: string, body: string, why: string, to = signature) {
	const file = await smali(classPath);
	const text = await Bun.file(file).text();
	const nl = text.includes("\r\n") ? "\r\n" : "\n";
	let start = text.indexOf(`${signature}${nl}`);
	if (start < 0) start = text.indexOf(`${to}${nl}`);
	if (start < 0) throw new Error(`${classPath}: no method ${signature}`);
	const end = text.indexOf(".end method", start);
	const replacement = `${to}${nl}${body.trim().split("\n").map((l) => `    ${l.trim()}`).join(nl)}${nl}`;
	if (text.slice(start, end) === replacement) return;
	await Bun.write(file, text.slice(0, start) + replacement + text.slice(end));
	changed++;
	done.push(why);
}

// Root checks. Sardine (X's anti-fraud SDK, used for payments) loads a native
// root checker and also looks for su binaries and root apps in Java; both
// report the device as never rooted, and the native library is not loaded.
await replaceMethod("com/sardine/ai/mdisdk/utils/rootChecker/RootCheckerNative", ".method static constructor <clinit>()V", ".locals 0\nreturn-void", "Sardine: native root checker not loaded");
await replaceMethod("com/sardine/ai/mdisdk/utils/rootChecker/RootCheckerNative", ".method public final native checkForRoot([Ljava/lang/String;)I", ".locals 1\nconst/4 v0, 0x0\nreturn v0", "Sardine: native root check says no", ".method public final checkForRoot([Ljava/lang/String;)I");
await replaceMethod("com/sardine/ai/mdisdk/utils/rootChecker/RootCheckerNative", ".method public final native setLogDebugMessages(Z)I", ".locals 1\nconst/4 v0, 0x0\nreturn v0", "Sardine: native logging switch is a no-op", ".method public final setLogDebugMessages(Z)I");
// the Java checks (su paths, Magisk and other root apps, test-keys): the
// obfuscator put them in a class it named kotlin.reflect.jvm.internal.calls.c
await replaceMethod("kotlin/reflect/jvm/internal/calls/c", ".method public e()Z", ".locals 1\nconst/4 v0, 0x0\nreturn v0", "Sardine: Java root check says no");

// Certificate pinning. The app pins x.com/twitter.com to X's own CA, so it
// would reject this instance's certificate. check$okhttp is the entry that
// gathers the pins and throws on a mismatch; making it return straight away
// accepts any trusted chain. (Over a plain-http dev server pinning never runs,
// but DMs, media and calls still reach https hosts.)
await replaceMethod("okhttp3/CertificatePinner", ".method public final check$okhttp(Ljava/lang/String;Lkotlin/jvm/functions/Function0;)V", ".locals 0\nreturn-void", "okhttp: certificate pinning disabled");

console.log(changed ? `patched:\n  ${done.join("\n  ")}` : "already patched");
