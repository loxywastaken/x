// Turns captured sign-in screens (samples/login, from a HAR) into the templates
// src/onboarding.ts serves: decoded to JSON, with the capturing account's
// details replaced by {{placeholders}}.
// usage: bun scripts/jf-templates.ts <your x.com username in the capture> [template...]

import { mkdirSync, writeFileSync } from "node:fs";
import { decode, mapStrings } from "../src/jetfuel";
import { toJson } from "../src/jetfuel-json";

const [capturedName, ...only] = process.argv.slice(2);
if (!capturedName) throw new Error("usage: bun scripts/jf-templates.ts <username in the capture>");

const SOURCES: Record<string, string> = {
	// the sign-in dialog of the signed-in client (/i/jfapi/onboarding/web?mode=login)
	landing: "samples/add-account/add-account/055-GET-jfapi_onboarding_web.json",
	// the same form inside the signed-out home page (/onboarding/web/landing)
	page: "samples/signup/signup/039-GET-onboarding_web_landing.json",
	// "Forgot password?": where to send the code
	recovery: "samples/add-account/add-account/011-POST-web_actions_begin_password_recovery.json",
	password: "samples/login/017-POST-web_actions_begin_login.json",
	// sign-up: "We sent you a security code" (reused for the invite code) and
	// "Set up your account" (name, username, password)
	code: "samples/signup/signup/063-POST-web_actions_begin_login.json",
	setup: "samples/signup/signup/071-POST-web_actions_verify_age.json",
	success: "samples/login/019-POST-web_actions_login_enter_password.json",
	passkey: "samples/login/014-GET-web_remotes_passkey_one_fa.json",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

mkdirSync("src/jf", { recursive: true });
for (const [name, file] of Object.entries(SOURCES)) {
	if (only.length && !only.includes(name)) continue;
	const j = JSON.parse(await Bun.file(file).text());
	let messages = decode(Buffer.from(j.response, "latin1"));
	messages = mapStrings(messages, (s) => {
		if (s.toLowerCase() === capturedName.toLowerCase()) return "{{username}}";
		if (UUID.test(s)) return "{{session_token}}";
		// the phone sign-up's per-visit id
		if (/^sdk_\w+$/.test(s)) return "";
		// the capture's birth date and age, kept in hidden fields
		if (/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(s)) return "";
		if (name === "setup" && /^\d{1,3}$/.test(s)) return "";
		if (/^\d{15,20}$/.test(s)) return "{{user_id}}";
		// masked contact details on the recovery screen
		if (/^[^*\s]{0,4}\*{3,}[^\s]*@/.test(s)) return "{{email_masked}}";
		if (/^\*{4,}\d{1,4}$/.test(s)) return "{{phone_masked}}";
		return s;
	});
	writeFileSync(`src/jf/${name}.json`, JSON.stringify(toJson(messages)));
	console.log(`src/jf/${name}.json`);
}
