import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { parse } from "shell-quote";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  Text,
  TuiAltScreen,
  TuiMainScreen,
  stripTerminalSequences,
  visibleWidth,
  type Component,
  type Terminal,
  type TUI,
} from "@earendil-works/pi-tui";
import { NewagentApprovalDialog, showNewagentApproval } from "./newagent-approval.ts";
import { registerNewagentTool } from "./newagent.ts";

const QUESTION = "Allow creating a new main-agent session?";
const OPTIONS = [
  "Allow once",
  "Allow in this turn",
  "Allow in this session",
  "No, deny (reason next)",
];
const theme = {
  fg(_color: string, text: string): string {
    return `\x1b[90m${text}\x1b[39m`;
  },
};

class MemoryTerminal implements Terminal {
  columns = 80;
  rows = 24;
  kittyProtocolActive = false;
  input: (data: string) => void = () => {};
  resize: () => void = () => {};
  output = "";
  start(input: (data: string) => void, resize: () => void): void {
    this.input = input;
    this.resize = resize;
  }
  write(data: string): void {
    this.output += data;
  }
  stop(): void {}
  async drainInput(): Promise<void> {}
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  setProgramStatus(): void {}
}

function approvalHarness(mode: "regular" | "fullscreen", prompt: string, cwd?: string) {
  const terminal = new MemoryTerminal();
  const tui = mode === "regular" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
  tui.addChild(new Text(Array.from({ length: 70 }, () => "BACKGROUND CHAT").join("\n")));
  const answers: (string | undefined)[] = [];
  const component = new NewagentApprovalDialog(
    tui,
    theme,
    QUESTION,
    { prompt, cwd },
    OPTIONS,
    (answer) => {
      answers.push(answer);
    },
  );
  tui.start();
  const overlay = tui.showOverlay(component, {
    width: "100%",
    maxHeight: "100%",
    anchor: "top-left",
    margin: 0,
  });
  function frame(): string[] {
    tui.renderNow();
    const lines =
      tui instanceof TuiAltScreen ? tui.getScreenLines() : tui.captureRenderState().previousLines;
    return lines.slice(-terminal.rows).map(stripTerminalSequences);
  }
  return { terminal, tui, overlay, component, answers, frame };
}

for (const mode of ["regular", "fullscreen"] as const) {
  describe(`${mode} approval overlay`, () => {
    it("puts field labels on separate frame tops and only values inside matching frames", () => {
      const harness = approvalHarness(mode, "first line\nsecond line", "/repo/child");
      try {
        const lines = harness.frame();
        const cells = lines.map((line) => line.slice(2, -2));
        const promptIndex = cells.findIndex((line) => line.startsWith("┌─ prompt "));
        const cwdIndex = cells.findIndex((line) => line.startsWith("┌─ cwd "));
        const cellWidth = harness.terminal.columns - 4;
        const bottom = "└" + "─".repeat(cellWidth - 2) + "┘";
        assert.equal(promptIndex, 3);
        assert.equal(cwdIndex, promptIndex + 5);
        assert.equal(cells[promptIndex + 1]?.slice(2, -2).trimEnd(), "first line");
        assert.equal(cells[promptIndex + 2]?.slice(2, -2).trimEnd(), "second line");
        assert.equal(cells[promptIndex + 3], bottom);
        assert.equal(cells[promptIndex + 4]?.trim(), "");
        assert.equal(cells[cwdIndex + 1]?.slice(2, -2).trimEnd(), "/repo/child");
        assert.equal(cells[cwdIndex + 2], bottom);
        assert.equal(visibleWidth(cells[promptIndex]!), cellWidth);
        assert.equal(visibleWidth(cells[cwdIndex]!), cellWidth);
        assert.equal(lines.filter((line) => line.startsWith("├")).length, 2);
        assert.equal(
          lines.some((line) => /prompt:|cwd:/.test(line)),
          false,
        );
      } finally {
        harness.tui.stop();
      }
    });

    it("keeps cwd-like prompt text inside the prompt cell when cwd is omitted", () => {
      const harness = approvalHarness(mode, "first line\ncwd: prompt text");
      try {
        const lines = harness.frame();
        const promptIndex = lines.findIndex((line) => line.includes("┌─ prompt "));
        assert.ok(promptIndex > 0);
        assert.ok(lines[promptIndex + 1]?.includes("first line"));
        assert.ok(lines[promptIndex + 2]?.includes("cwd: prompt text"));
        assert.equal(
          lines.some((line) => line.includes("┌─ cwd ")),
          false,
        );
        assert.equal(lines.filter((line) => line.startsWith("├")).length, 2);
      } finally {
        harness.tui.stop();
      }
    });

    it("fits field titles and values within narrow and resized terminal widths", () => {
      const harness = approvalHarness(mode, "日本語🙂".repeat(30), "/repo/child");
      try {
        harness.terminal.rows = 200;
        for (const columns of [42, 16, 10, 8, 6, 4, 2, 1, 0, 80]) {
          harness.terminal.columns = columns;
          harness.terminal.resize();
          const lines = harness.component.render(columns).map(stripTerminalSequences);
          assert.ok(
            lines.every((line) => visibleWidth(line) <= columns),
            `columns: ${columns}`,
          );
          if (columns >= 16) {
            assert.ok(lines.some((line) => line.includes("┌─ prompt ")));
            assert.ok(lines.some((line) => line.includes("┌─ cwd ")));
          }
          if (columns === 10) assert.ok(lines.some((line) => line.includes("┌─ pr┐")));
        }
      } finally {
        harness.tui.stop();
      }
    });

    it("shows untrusted conceal, clear-screen and OSC sequences literally in raw terminal output", () => {
      const details =
        "benign \x1b[8mHIDDEN DANGEROUS REQUEST\x1b[28m done \x1b[2J\n\nlast\r\t\x1b]2;FAKE TITLE\x07\n";
      const harness = approvalHarness(mode, details);
      try {
        harness.terminal.columns = 160;
        harness.frame();
        const raw = harness.terminal.output;
        assert.ok(raw.includes("benign \\x1b[8mHIDDEN DANGEROUS REQUEST\\x1b[28m done \\x1b[2J"));
        assert.ok(raw.includes("last\\x0d\\x09\\x1b]2;FAKE TITLE\\x07"));
        assert.equal(raw.includes("\x1b[8m"), false);
        assert.equal(raw.includes("\x1b[28m"), false);
        assert.equal(raw.includes("done \x1b[2J"), false);
        assert.equal(raw.includes("\x1b]2;FAKE TITLE"), false);
        const lines = harness.component.render(160).map(stripTerminalSequences);
        assert.equal(lines[5]!.slice(4, -4).trim(), "");
        assert.ok(lines[6]?.includes("last\\x0d"));
        assert.equal(lines[7]!.slice(4, -4).trim(), "");
      } finally {
        harness.tui.stop();
      }
    });

    it("escapes every C0, DEL and C1 control except LF before rendering", () => {
      const controlCodes = [
        ...Array.from({ length: 32 }, (_, index) => index).filter((code) => code !== 10),
        ...Array.from({ length: 33 }, (_, index) => index + 127),
      ];
      for (const code of controlCodes) {
        const control = String.fromCharCode(code);
        const literal = `BEFORE\\x${code.toString(16).padStart(2, "0")}AFTER`;
        const harness = approvalHarness(mode, `BEFORE${control}AFTER`);
        try {
          harness.frame();
          const rawComponent = harness.component.render(80).join("\n");
          assert.ok(rawComponent.includes(literal), `control: ${code}`);
          assert.ok(harness.terminal.output.includes(literal), `control: ${code}`);
          assert.equal(
            harness.terminal.output.includes(`BEFORE${control}AFTER`),
            false,
            `control: ${code}`,
          );
        } finally {
          harness.tui.stop();
        }
      }
    });

    for (const rows of [16, 24, 40]) {
      it(`keeps the question, borders and all choices visible through the final prompt line at ${rows} rows`, () => {
        const details =
          Array.from({ length: 100 }, (_, index) => `body-${index}`).join("\n") +
          "\n\nFINAL LINE\n";
        const harness = approvalHarness(mode, details);
        try {
          harness.terminal.rows = rows;
          const first = harness.frame();
          assert.equal(first.length, rows);
          assert.ok(first[0]?.startsWith("┌"));
          assert.ok(first.at(-1)?.startsWith("└"));
          assert.equal(first.filter((line) => line.startsWith("├")).length, 2);
          assert.ok(first[1]?.includes(QUESTION));
          assert.equal(
            first.some((line) => line.includes("BACKGROUND")),
            false,
          );
          const choiceRows = OPTIONS.map((option) =>
            first.findIndex((line) => line.includes(option)),
          );
          assert.ok(choiceRows.every((index) => index > 0));
          for (let page = 0; page < 110; page++) {
            harness.terminal.input("\x1b[6~");
            const current = harness.frame();
            assert.ok(current[1]?.includes(QUESTION));
            assert.deepEqual(
              OPTIONS.map((option) => current.findIndex((line) => line.includes(option))),
              choiceRows,
            );
          }
          const last = harness.frame();
          assert.ok(last.some((line) => line.includes("FINAL LINE")));
          assert.equal(
            last.some((line) => line.includes("body-0 ")),
            false,
          );
          harness.terminal.input("\r");
          assert.deepEqual(harness.answers, ["Allow once"]);
        } finally {
          harness.tui.stop();
        }
      });
    }

    it("scrolls one line and one page in both directions without changing selection", () => {
      const harness = approvalHarness(
        mode,
        Array.from({ length: 100 }, (_, index) => `line-${index}`).join("\n"),
      );
      try {
        const start = harness.frame();
        harness.terminal.input("\x1b[B");
        const down = harness.frame();
        assert.ok(start[3]?.includes("┌─ prompt "));
        assert.ok(start[4]?.includes("line-0"));
        assert.ok(down[3]?.includes("line-0"));
        harness.terminal.input("\x1b[A");
        assert.deepEqual(harness.frame(), start);
        harness.terminal.input("\x1b[6~");
        assert.notDeepEqual(harness.frame(), start);
        harness.terminal.input("\x1b[5~");
        assert.deepEqual(harness.frame(), start);
        harness.terminal.input("\r");
        assert.deepEqual(harness.answers, [OPTIONS[0]]);
      } finally {
        harness.tui.stop();
      }
    });

    it("scrolls through a long prompt into the cwd cell while keeping choices fixed", () => {
      const prompt = Array.from({ length: 100 }, (_, index) => `line-${index}`).join("\n");
      const harness = approvalHarness(mode, prompt, "/repo/child");
      try {
        const first = harness.frame();
        const choiceRows = OPTIONS.map((option) =>
          first.findIndex((line) => line.includes(option)),
        );
        assert.ok(first[3]?.includes("┌─ prompt "));
        assert.ok(first[4]?.includes("line-0"));
        for (let page = 0; page < 110; page++) {
          harness.terminal.input("\x1b[6~");
          harness.frame();
        }
        const last = harness.frame();
        const cwdIndex = last.findIndex((line) => line.includes("/repo/child"));
        assert.ok(cwdIndex > 0);
        assert.ok(last[cwdIndex - 1]?.includes("┌─ cwd "));
        assert.equal(last[cwdIndex - 2]?.slice(2, -2).trim(), "");
        assert.ok(last[cwdIndex - 3]?.includes("└"));
        assert.ok(last[cwdIndex - 4]?.includes("line-99"));
        assert.deepEqual(
          OPTIONS.map((option) => last.findIndex((line) => line.includes(option))),
          choiceRows,
        );
        harness.terminal.input("\r");
        assert.deepEqual(harness.answers, [OPTIONS[0]]);
      } finally {
        harness.tui.stop();
      }
    });

    it("reflows wide text on resize and keeps the final line reachable with fixed choices", () => {
      const harness = approvalHarness(mode, "日本語🙂".repeat(250) + "\n\nLAST\n");
      try {
        for (const [columns, rows] of [
          [80, 24],
          [42, 40],
          [100, 16],
          [55, 24],
        ]) {
          harness.terminal.columns = columns!;
          harness.terminal.rows = rows!;
          harness.terminal.resize();
          const first = harness.frame();
          assert.equal(first.length, rows);
          assert.ok(first.every((line) => visibleWidth(line) === columns));
          let last: string[] = [];
          for (let page = 0; page < 100; page++) {
            harness.terminal.input("\x1b[6~");
            last = harness.frame();
            if (last.some((line) => line.includes("LAST"))) break;
          }
          assert.ok(last.some((line) => line.includes("LAST")));
          for (const option of OPTIONS) assert.ok(last.some((line) => line.includes(option)));
        }
      } finally {
        harness.tui.stop();
      }
    });

    for (const [index, keys] of [
      [0, []],
      [1, ["\t"]],
      [2, ["\t", "\t"]],
      [3, ["\x1b[Z"]],
    ] as const) {
      it(`confirms choice ${index} with Tab or Shift+Tab`, () => {
        const harness = approvalHarness(mode, "prompt: test");
        try {
          const first = harness.frame();
          for (const key of keys) harness.terminal.input(key);
          const selected = harness.frame();
          assert.ok(selected.some((line) => line.includes(`→ ${OPTIONS[index]}`)));
          assert.equal(selected[3], first[3]);
          harness.terminal.input("\r");
          assert.deepEqual(harness.answers, [OPTIONS[index]]);
        } finally {
          harness.tui.stop();
        }
      });
    }

    it("returns cancellation on Escape", () => {
      const harness = approvalHarness(mode, "prompt: test");
      try {
        harness.frame();
        harness.terminal.input("\x1b");
        assert.deepEqual(harness.answers, [undefined]);
      } finally {
        harness.tui.stop();
      }
    });
  });
}

function customUi(tui: TUI) {
  let component: Component | undefined;
  const opened = Promise.withResolvers<void>();
  const calls = { custom: 0, select: 0, reasons: 0 };
  const ui = {
    async custom<T>(
      factory: Parameters<ExtensionUIContext["custom"]>[0],
      options: Parameters<ExtensionUIContext["custom"]>[1],
    ): Promise<T> {
      calls.custom++;
      return new Promise<T>((resolve) => {
        function done(answer: unknown): void {
          handle?.hide();
          resolve(answer as T);
        }
        let handle: ReturnType<TUI["showOverlay"]> | undefined;
        component = factory(
          tui,
          theme as Theme,
          {} as Parameters<typeof factory>[2],
          done,
        ) as Component;
        assert.equal(options?.overlay, true);
        const layout =
          typeof options?.overlayOptions === "function"
            ? options.overlayOptions()
            : options?.overlayOptions;
        handle = tui.showOverlay(component, layout);
        opened.resolve();
      });
    },
    async select(): Promise<string> {
      calls.select++;
      return OPTIONS[0]!;
    },
    async input(): Promise<string> {
      calls.reasons++;
      return "not now";
    },
  };
  return {
    ui: ui as unknown as ExtensionUIContext,
    calls,
    opened: opened.promise,
    getComponent: () => component,
  };
}

describe("approval lifecycle and tool routing", () => {
  for (const answer of ["once", "turn", "session", "deny", "escape", "abort"] as const) {
    it(`preserves execution and approval state for a TUI ${answer} answer`, async () => {
      const previousAgent = process.env.PI_AGENT_NAME;
      process.env.PI_AGENT_NAME = "main";
      const tui = new TuiMainScreen(new MemoryTerminal());
      const harness = customUi(tui);
      const handlers = new Map<string, (event: any) => unknown>();
      const tools: any[] = [];
      registerNewagentTool({
        registerTool(tool: unknown) {
          tools.push(tool);
        },
        on(event: string, handler: (event: any) => unknown) {
          handlers.set(event, handler);
        },
      } as any);
      let executions = 0;
      const context = {
        mode: "tui",
        hasUI: true,
        cwd: "/repo",
        ui: harness.ui,
        async executeTool() {
          executions++;
          return { isError: false, result: { content: [{ type: "text", text: "created" }] } };
        },
      };
      const controller = new AbortController();
      try {
        const first = tools[0].execute(
          "test",
          { prompt: "test" },
          controller.signal,
          undefined,
          context,
        );
        await harness.opened;
        const dialog = harness.getComponent()!;
        dialog.render(80);
        if (answer === "abort") controller.abort();
        else if (answer === "escape") dialog.handleInput!("\x1b");
        else {
          const index = ["once", "turn", "session", "deny"].indexOf(answer);
          for (let tab = 0; tab < index; tab++) dialog.handleInput!("\t");
          dialog.handleInput!("\r");
        }
        if (answer === "abort") await assert.rejects(first, { name: "AbortError" });
        else {
          const result = await first;
          assert.equal(
            result.structuredContent.status,
            answer === "deny" || answer === "escape" ? "denied" : "created",
          );
          if (answer === "deny" || answer === "escape")
            assert.match(result.content[0].text, /not now/);
        }
        assert.equal(executions, ["once", "turn", "session"].includes(answer) ? 1 : 0);
        assert.equal(tui.hasOverlay(), false);
        const second = tools[0].execute("test", { prompt: "next" }, undefined, undefined, context);
        if (answer !== "turn" && answer !== "session") harness.getComponent()!.handleInput!("\r");
        await second;
        assert.equal(harness.calls.custom, answer === "turn" || answer === "session" ? 1 : 2);
        if (answer === "turn" || answer === "session") {
          handlers.get("input")!({ source: "interactive" });
          const third = tools[0].execute(
            "test",
            { prompt: "third" },
            undefined,
            undefined,
            context,
          );
          if (answer === "turn") harness.getComponent()!.handleInput!("\r");
          await third;
          assert.equal(harness.calls.custom, answer === "turn" ? 2 : 1);
        }
      } finally {
        if (previousAgent === undefined) delete process.env.PI_AGENT_NAME;
        else process.env.PI_AGENT_NAME = previousAgent;
      }
    });
  }

  it("closes the overlay on abort and removes the signal listener", async () => {
    const terminal = new MemoryTerminal();
    const tui = new TuiMainScreen(terminal);
    const harness = customUi(tui);
    const controller = new AbortController();
    let listeners = 0;
    const add = controller.signal.addEventListener.bind(controller.signal);
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = (...args) => {
      listeners++;
      return add(...args);
    };
    controller.signal.removeEventListener = (...args) => {
      listeners--;
      return remove(...args);
    };
    const pending = showNewagentApproval(
      harness.ui,
      QUESTION,
      { prompt: "test" },
      OPTIONS,
      controller.signal,
    );
    await harness.opened;
    assert.equal(tui.hasOverlay(), true);
    controller.abort();
    assert.equal(await pending, undefined);
    assert.equal(tui.hasOverlay(), false);
    assert.equal(listeners, 0);
  });

  it("does not open a dialog for an already aborted signal", async () => {
    const tui = new TuiMainScreen(new MemoryTerminal());
    const harness = customUi(tui);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      showNewagentApproval(harness.ui, QUESTION, { prompt: "x" }, OPTIONS, controller.signal),
      { name: "AbortError" },
    );
    assert.equal(harness.calls.custom, 0);
  });

  for (const mode of ["tui", "rpc"] as const) {
    it(`routes ${mode} approval through its own UI and preserves full prompt and cwd`, async () => {
      const oldAgent = process.env.PI_AGENT_NAME;
      process.env.PI_AGENT_NAME = "main";
      const terminal = new MemoryTerminal();
      const tui = new TuiMainScreen(terminal);
      const harness = customUi(tui);
      const tools: any[] = [];
      registerNewagentTool({
        registerTool(tool: unknown) {
          tools.push(tool);
        },
        on() {},
      } as any);
      const commands: string[] = [];
      const prompt = "x".repeat(100) + "\n\nFINAL\x1b[8m hidden\x1b[28m\r\t\n";
      try {
        const pending = tools[0].execute("test", { prompt, cwd: "child" }, undefined, undefined, {
          mode,
          hasUI: true,
          cwd: "/repo",
          ui: harness.ui,
          async executeTool(_name: string, args: { command: string }) {
            commands.push(args.command);
            return { isError: false, result: { content: [{ type: "text", text: "created" }] } };
          },
        });
        if (mode === "tui") {
          await harness.opened;
          const rendered = harness
            .getComponent()!
            .render(80)
            .map(stripTerminalSequences)
            .join("\n");
          assert.ok(rendered.includes("FINAL\\x1b[8m hidden\\x1b[28m\\x0d\\x09"));
          assert.ok(rendered.includes("┌─ cwd "));
          assert.ok(rendered.includes("/repo/child"));
          assert.equal(rendered.includes("cwd:"), false);
          harness.getComponent()!.handleInput!("\r");
        }
        const result = await pending;
        assert.equal(result.structuredContent.status, "created");
        assert.equal(harness.calls.custom, mode === "tui" ? 1 : 0);
        assert.equal(harness.calls.select, mode === "rpc" ? 1 : 0);
        assert.equal(commands.length, 1);
        const script = parse(commands[0]!)[2] as string;
        assert.equal(parse(script).at(-1), prompt);
      } finally {
        if (oldAgent === undefined) delete process.env.PI_AGENT_NAME;
        else process.env.PI_AGENT_NAME = oldAgent;
      }
    });
  }
});
