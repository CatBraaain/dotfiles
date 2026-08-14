// skill コマンドの /skill: prefix を / に見せかける拡張。
// 詳細は ./SPEC.md。

import type { ExtensionAPI, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import {
	fuzzyFilter,
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
} from "@earendil-works/pi-tui";

const SKILL_PREFIX = "skill:";

export type ResolveResult = { action: "continue" } | { action: "transform"; text: string };

type CommandRef = Pick<SlashCommandInfo, "name" | "source">;

export function resolveSlashInput(text: string, commands: ReadonlyArray<CommandRef>): ResolveResult {
	if (text.startsWith(`/${SKILL_PREFIX}`)) return { action: "continue" };

	const match = text.match(/^\/([^\s/]+)(\s[\s\S]*)?$/);
	if (!match) return { action: "continue" };

	const bareName = match[1] as string;
	const rest = match[2] ?? "";

	const hasCommand = (source: CommandRef["source"], name: string): boolean =>
		commands.some((command) => command.source === source && command.name === name);

	if (hasCommand("extension", bareName)) return { action: "continue" };
	if (hasCommand("prompt", bareName)) return { action: "continue" };
	if (hasCommand("skill", `${SKILL_PREFIX}${bareName}`)) {
		return { action: "transform", text: `/${SKILL_PREFIX}${bareName}${rest}` };
	}
	return { action: "continue" };
}

export function rewriteCompletionItems(
	items: ReadonlyArray<AutocompleteItem>,
	slashPrefix: string,
): AutocompleteItem[] {
	const rewrittenItems = items.map((item) => {
		if (!item.value.startsWith(SKILL_PREFIX)) return item;
		const bareName = item.value.slice(SKILL_PREFIX.length);
		return { ...item, value: bareName, label: bareName };
	});

	return fuzzyFilter(rewrittenItems, slashPrefix, (item) => item.value);
}

function slashPrefixBeforeCursor(textBeforeCursor: string): string | undefined {
	if (!textBeforeCursor.startsWith("/")) return undefined;
	if (textBeforeCursor.includes(" ")) return undefined;
	return textBeforeCursor.slice(1);
}

export default function skillShortcut(pi: ExtensionAPI): void {
	pi.on("input", async (event) => {
		if (event.source === "extension") return { action: "continue" };
		return resolveSlashInput(event.text, pi.getCommands());
	});

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.addAutocompleteProvider((current: AutocompleteProvider): AutocompleteProvider => ({
			triggerCharacters: current.triggerCharacters,
			async getSuggestions(
				lines,
				cursorLine,
				cursorCol,
				options,
			): Promise<AutocompleteSuggestions | null> {
				const currentLine = lines[cursorLine] ?? "";
				const slashPrefix = slashPrefixBeforeCursor(currentLine.slice(0, cursorCol));
				const suggestions = await current.getSuggestions(lines, cursorLine, cursorCol, options);
				if (!suggestions) return null;
				if (slashPrefix === undefined) return suggestions;
				const rewritten = rewriteCompletionItems(suggestions.items, slashPrefix);
				if (rewritten.length === 0) return null;
				return { items: rewritten, prefix: suggestions.prefix };
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			},
			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
			},
		}));
	});
}
