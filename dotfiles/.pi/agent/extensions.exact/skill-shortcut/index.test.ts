// 実行: bun --install=auto run index.test.ts

import assert from "node:assert/strict";
import skillShortcut, { resolveSlashInput, rewriteCompletionItems } from "./index";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

const tests: { name: string; fn: () => Promise<void> | void }[] = [];
let group = "";

function describe(name: string, fn: () => void): void {
	const previousGroup = group;
	group = name;
	fn();
	group = previousGroup;
}

function it(name: string, fn: () => Promise<void> | void): void {
	tests.push({ name: group ? `${group} > ${name}` : name, fn });
}

type CommandRef = { name: string; source: "extension" | "prompt" | "skill" };

function skillCommand(skillName: string): CommandRef {
	return { name: `skill:${skillName}`, source: "skill" };
}

function extensionCommand(name: string): CommandRef {
	return { name, source: "extension" };
}

function promptCommand(name: string): CommandRef {
	return { name, source: "prompt" };
}

function completionItem(value: string): AutocompleteItem {
	return { value, label: value };
}

describe("補完の表示", () => {
	it("/ の入力では全候補の skill: を剥がして裸名で返す", () => {
		const allCommandItems: AutocompleteItem[] = [
			completionItem("skill:foo"),
			completionItem("skill:bar"),
			completionItem("model"),
		];

		const displayedItems = rewriteCompletionItems(allCommandItems, "");

		assert.deepEqual(displayedItems, [
			{ value: "foo", label: "foo" },
			{ value: "bar", label: "bar" },
			{ value: "model", label: "model" },
		]);
	});

	it("/fo の入力では fo に一致する裸名だけ残る", () => {
		const allCommandItems: AutocompleteItem[] = [
			completionItem("skill:foo"),
			completionItem("skill:bar"),
			completionItem("model"),
		];

		const displayedItems = rewriteCompletionItems(allCommandItems, "fo");

		assert.deepEqual(displayedItems, [{ value: "foo", label: "foo" }]);
	});

	it("/sht の入力では文字が順番に現れる裸名が残る", () => {
		const skillPrefixedItems: AutocompleteItem[] = [completionItem("skill:skill-shortcut")];

		const displayedItems = rewriteCompletionItems(skillPrefixedItems, "sht");

		assert.deepEqual(displayedItems, [{ value: "skill-shortcut", label: "skill-shortcut" }]);
	});

	it("/z の入力では一致する候補がないため空になる", () => {
		const skillPrefixedItems: AutocompleteItem[] = [completionItem("skill:foo"), completionItem("skill:bar")];

		const displayedItems = rewriteCompletionItems(skillPrefixedItems, "z");

		assert.deepEqual(displayedItems, []);
	});
});

describe("コマンドの実行", () => {
	it("/foo が skill に存在するとき /skill:foo へ変換する", () => {
		const commands = [skillCommand("foo")];

		const result = resolveSlashInput("/foo", commands);

		assert.deepEqual(result, { action: "transform", text: "/skill:foo" });
	});

	it("/foo <args> が skill に存在するとき args を保ったまま /skill:foo へ変換する", () => {
		const commands = [skillCommand("foo")];

		const result = resolveSlashInput("/foo some args", commands);

		assert.deepEqual(result, { action: "transform", text: "/skill:foo some args" });
	});

	it("/foo が skill にも prompt にも拡張コマンドにも無いときは変換せず通常処理へ渡す", () => {
		const result = resolveSlashInput("/foo", []);

		assert.deepEqual(result, { action: "continue" });
	});

	it("/skill:foo の直接入力はそのまま通し変換しない", () => {
		const commands = [skillCommand("foo")];

		const result = resolveSlashInput("/skill:foo", commands);

		assert.deepEqual(result, { action: "continue" });
	});
});

describe("名前の衝突", () => {
	it("拡張コマンドと同名の skill では拡張コマンドが優先され skill へ変換しない", () => {
		const commands = [extensionCommand("foo"), skillCommand("foo")];

		const result = resolveSlashInput("/foo", commands);

		assert.deepEqual(result, { action: "continue" });
	});

	it("prompt テンプレートと同名の skill では prompt テンプレートが優先され skill へ変換しない", () => {
		const commands = [promptCommand("foo"), skillCommand("foo")];

		const result = resolveSlashInput("/foo", commands);

		assert.deepEqual(result, { action: "continue" });
	});

	it("skill のみのとき skill へ変換する", () => {
		const commands = [skillCommand("foo")];

		const result = resolveSlashInput("/foo", commands);

		assert.deepEqual(result, { action: "transform", text: "/skill:foo" });
	});
});

describe("起動直後の補完", () => {
	it("session_start のタイミングで登録した provider が /foo 入力に裸名の候補を返す", async () => {
		const currentProvider = {
			triggerCharacters: ["/"],
			async getSuggestions(): Promise<AutocompleteSuggestions | null> {
				return { items: [completionItem("skill:foo"), completionItem("model")], prefix: "/" };
			},
		} as AutocompleteProvider;
		let registeredProviderFactory: ((current: AutocompleteProvider) => AutocompleteProvider) | undefined;
		const fakePi = {
			on(event: string, handler: unknown) {
				if (event !== "session_start") return;
				const ctx = {
					ui: {
						addAutocompleteProvider(factory: (current: AutocompleteProvider) => AutocompleteProvider) {
							registeredProviderFactory = factory;
						},
					},
				};
				(handler as (event: unknown, ctx: unknown) => void)(undefined, ctx);
			},
			getCommands() {
				return [];
			},
		};

		skillShortcut(fakePi as never);

		assert.ok(registeredProviderFactory, "provider factory is registered at session_start");
		const wrappedProvider = registeredProviderFactory(currentProvider);
		const fooSuggestions = await wrappedProvider.getSuggestions(["/foo"], 0, 4, undefined as never);

		assert.deepEqual(fooSuggestions, { items: [{ value: "foo", label: "foo" }], prefix: "/" });
	});
});

let failed = 0;
for (const test of tests) {
	try {
		await test.fn();
		console.log(`ok - ${test.name}`);
	} catch (error) {
		failed += 1;
		console.error(`not ok - ${test.name}`);
		console.error(error);
	}
}

if (failed > 0) {
	console.error(`\n${failed}/${tests.length} tests failed`);
	process.exit(1);
}
console.log(`\n${tests.length} tests passed`);
