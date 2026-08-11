// 実行: bun --install=auto run index.test.ts
//
// note-command 拡張機能の振る舞いを検証する。
// 出典: ./BEHAVIORS.md
// factory をモック pi で起動し、/note コマンドの handler と
// pi.sendMessage への呼び出し（メッセージ本文・配信モード）を検証する。
// 各 it のタイトルが要件仕様。
import assert from "node:assert/strict";
import noteCommandExtension from "./index";

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

interface SentMessage {
	message: { customType: string; content: string; display: boolean };
	options: { triggerTurn?: boolean; deliverAs?: string };
}

interface CapturedExtension {
	registeredCommandNames: string[];
	runNote: (args: string) => Promise<void>;
	sentMessages: SentMessage[];
}

// factory をモック pi で起動し、/note の handler と sendMessage 呼び出しを捕捉する。
function captureNoteExtension(): CapturedExtension {
	const registeredCommandNames: string[] = [];
	const commands = new Map<string, (args: string) => Promise<void>>();
	const sentMessages: SentMessage[] = [];

	noteCommandExtension({
		registerCommand: (name: string, def: { handler: (args: string) => Promise<void> }) => {
			registeredCommandNames.push(name);
			commands.set(name, def.handler);
		},
		sendMessage: (
			message: { customType: string; content: string; display: boolean },
			options: { triggerTurn?: boolean; deliverAs?: string },
		) => {
			sentMessages.push({ message, options });
		},
	} as never);

	return {
		registeredCommandNames,
		async runNote(args: string) {
			await commands.get("note")?.(args);
		},
		sentMessages,
	};
}

describe("コマンドの登録", () => {
	it("/note という名前のコマンドが1つだけ登録される", () => {
		const extension = captureNoteExtension();
		assert.deepEqual(extension.registeredCommandNames, ["note"]);
	});
});

describe("履歴への追記", () => {
	it("/note 認証完成 は、認証完成 をメッセージ本文として履歴に append する", async () => {
		const extension = captureNoteExtension();
		await extension.runNote("認証完成");

		const appendedContent = extension.sentMessages[0]?.message.content;
		assert.equal(appendedContent, "認証完成");
	});
	it("/note （テキストなし）は、空テキストをメッセージ本文として履歴に append する", async () => {
		const extension = captureNoteExtension();
		await extension.runNote("");

		const appendedContent = extension.sentMessages[0]?.message.content;
		assert.equal(appendedContent, "");
	});
});

describe("AI 応答の抑制", () => {
	it("/note を打っても LLM は呼ばれずトークンを消費しない（deliverAs が nextTurn）", async () => {
		const extension = captureNoteExtension();
		await extension.runNote("認証完成");

		const deliveryMode = extension.sentMessages[0]?.options.deliverAs;
		assert.equal(deliveryMode, "nextTurn");
	});
	it("/note を打っても即時の LLM 呼び出しは起こらない（triggerTurn が未設定）", async () => {
		const extension = captureNoteExtension();
		await extension.runNote("認証完成");

		const triggeredTurn = extension.sentMessages[0]?.options.triggerTurn;
		assert.equal(triggeredTurn, undefined);
	});
});

describe("メッセージの永続性", () => {
	it("append したメッセージは LLM context に参加するメッセージとして送られる（sendMessage 経由）", async () => {
		const extension = captureNoteExtension();
		await extension.runNote("認証完成");

		assert.equal(extension.sentMessages.length, 1);
	});
	it("append したメッセージはセッション画面に表示される（display が true）", async () => {
		const extension = captureNoteExtension();
		await extension.runNote("認証完成");

		const isDisplayed = extension.sentMessages[0]?.message.display;
		assert.equal(isDisplayed, true);
	});
});

describe("複数 append の順序", () => {
	it("/note A → /note B は、A・B の順でメッセージが append される", async () => {
		const extension = captureNoteExtension();
		await extension.runNote("A");
		await extension.runNote("B");

		const appendedOrder = extension.sentMessages.map((call) => call.message.content);
		assert.deepEqual(appendedOrder, ["A", "B"]);
	});
});

let passed = 0;
const failures: string[] = [];
for (const test of tests) {
	try {
		await test.fn();
		passed++;
	} catch (error) {
		failures.push(
			`  ✗ ${test.name}\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
		);
	}
}

if (failures.length > 0) {
	console.error(`\n${failures.length} test(s) FAILED:\n${failures.join("\n")}\n`);
	process.exitCode = 1;
}
console.log(`\n${passed} passed, ${failures.length} failed`);
