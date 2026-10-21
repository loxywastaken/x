// Admin > Feature switches: the client's own switches (shell.ts switchReport),
// overridden for everyone from their next page load.

import { type Action, AdminError, audit } from "./admin";
import { setSetting, settings } from "./settings";
import { switchReport } from "./shell";

export const switchActions: Record<string, Action> = {
	// the client's feature switches (shell.ts switchReport); an override wins
	// over the build and Xitter, for everyone, from their next page load
	featureSwitches: { role: "admin", run: async () => ({ switches: switchReport() }) },
	setFeatureSwitch: {
		role: "admin",
		run: async (a, b) => {
			const name = String(b.name ?? "");
			if (!/^[A-Za-z0-9_.-]{1,120}$/.test(name)) throw new AdminError("That isn't a switch name.");
			const overrides = { ...settings().switch_overrides };
			if (b.reset) delete overrides[name];
			else {
				const v = b.value;
				const ok = typeof v === "boolean" || typeof v === "string" || (typeof v === "number" && Number.isFinite(v)) || (Array.isArray(v) && v.every((x) => typeof x === "string" || typeof x === "number"));
				if (!ok || JSON.stringify(v).length > 10_000) throw new AdminError("A switch is true/false, a number, text or a list.");
				overrides[name] = v;
			}
			await setSetting("switch_overrides", overrides);
			await audit(a, "set_feature_switch", null, { name, ...(b.reset ? { reset: true } : { value: b.value }) });
			return {};
		},
	},
};
