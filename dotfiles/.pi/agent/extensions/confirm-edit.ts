import { type ExtensionAPI, isToolCallEventType } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	let askConfirm = true;
	let skipOnce = false;

	pi.registerCommand("confirm", {
		description: "Toggle edit confirmation. /confirm off = auto-apply, /confirm on = ask before edits",
		handler: async (args, ctx) => {
			const val = args.trim().toLowerCase();
			if (val === "off") {
				askConfirm = false;
				ctx.ui.setStatus("confirm", "confirm: off");
				ctx.ui.notify("確認OFF — 編集を自動適用します", "info");
			} else {
				askConfirm = true;
				ctx.ui.setStatus("confirm", "confirm: on");
				ctx.ui.notify("確認ON — 編集前に確認します", "info");
			}
		},
	});

	pi.on("input", (event, _ctx) => {
		if (event.text.startsWith("!!")) {
			skipOnce = true;
			return { action: "transform", text: event.text.replace(/^!!\s*/, "") };
		}
	});

	pi.on("agent_settled", () => {
		skipOnce = false;
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!ctx.hasUI) return;
		if (!askConfirm && !skipOnce) return;

		const shouldSkip = skipOnce || !askConfirm;

		if (isToolCallEventType("edit", event) || isToolCallEventType("write", event)) {
			if (shouldSkip) return;
			const summary = isToolCallEventType("edit", event)
				? `edit ${event.input.path}`
				: `write ${event.input.path}`;
			const ok = await ctx.ui.confirm("Apply changes?", summary);
			if (!ok) return { block: true, reason: "User declined" };
			return;
		}

		if (isToolCallEventType("bash", event)) {
			const cmd = (event.input.command ?? "").trim();
			if (/\brm\s+-rf\b|\bdd\s+if=|\bmkfs\.|\bgit\s+push\s+--force\b/.test(cmd)) {
				if (shouldSkip) return;
				const ok = await ctx.ui.confirm("Dangerous command?", cmd.slice(0, 120));
				if (!ok) return { block: true, reason: "Blocked by user" };
			}
		}
	});

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setStatus("confirm", "confirm: on");
	});
}
