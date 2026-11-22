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
import { AgentApprovalDialog, showAgentApproval, type ApprovalField } from "./agent-approval.ts";
import { registerAgentTool } from "./agent.ts";

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

function approvalHarness(mode: "regular" | "fullscreen", fields: ApprovalField[]) {
  const terminal = new MemoryTerminal();
  const tui = mode === "regular" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
  tui.addChild(new Text(Array.from({ length: 70 }, () => "BACKGROUND CHAT").join("\n")));
  const answers: (string | undefined)[] = [];
  const component = new AgentApprovalDialog(tui, theme, QUESTION, fields, OPTIONS, (answer) => {
    answers.push(answer);
  });
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
      const harness = approvalHarness(mode, [
        { label: "message", text: "first line\nsecond line" },
        { label: "session-id", text: "abc123" },
      ]);
      try {
        const lines = harness.frame();
        const cells = lines.map((line) => line.slice(2, -2));
        const messageIndex = cells.findIndex((line) => line.startsWith("┌─ message "));
        const sessionIndex = cells.findIndex((line) => line.startsWith("┌─ session-id "));
        const cellWidth = harness.terminal.columns - 4;
        const bottom = "└" + "─".repeat(cellWidth - 2) + "┘";
        assert.equal(messageIndex, 3);
        assert.equal(sessionIndex, messageIndex + 5);
        assert.equal(cells[messageIndex + 1]?.slice(2, -2).trimEnd(), "first line");
        assert.equal(cells[messageIndex + 2]?.slice(2, -2).trimEnd(), "second line");
        assert.equal(cells[messageIndex + 3], bottom);
        assert.equal(cells[messageIndex + 4]?.trim(), "");
        assert.equal(cells[sessionIndex + 1]?.slice(2, -2).trimEnd(), "abc123");
        assert.equal(cells[sessionIndex + 2], bottom);
        assert.equal(visibleWidth(cells[messageIndex]!), cellWidth);
        assert.equal(visibleWidth(cells[sessionIndex]!), cellWidth);
        assert.equal(lines.filter((line) => line.startsWith("├")).length, 2);
        assert.equal(
          lines.some((line) => /session-id:|message:/.test(line)),
          false,
        );
      } finally {
        harness.tui.stop();
      }
    });

    it("keeps session-id-like message text inside the message cell when session-id is omitted", () => {
      const harness = approvalHarness(mode, [
        { label: "message", text: "first line\nsession-id: message text" },
      ]);
      try {
        const lines = harness.frame();
        const messageIndex = lines.findIndex((line) => line.includes("┌─ message "));
        assert.ok(messageIndex > 0);
        assert.ok(lines[messageIndex + 1]?.includes("first line"));
        assert.ok(lines[messageIndex + 2]?.includes("session-id: message text"));
        assert.equal(
          lines.some((line) => line.includes("┌─ session-id ")),
          false,
        );
        assert.equal(lines.filter((line) => line.startsWith("├")).length, 2);
      } finally {
        harness.tui.stop();
      }
    });

    it("fits field titles and values within narrow and resized terminal widths", () => {
      const harness = approvalHarness(mode, [
        { label: "message", text: "日本語🙂".repeat(30) },
        { label: "session-id", text: "abc123" },
      ]);
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
            assert.ok(lines.some((line) => line.includes("┌─ message ")));
            assert.ok(lines.some((line) => line.includes("┌─ session")));
          }
          if (columns === 10) assert.ok(lines.some((line) => line.includes("┌─ me┐")));
        }
      } finally {
        harness.tui.stop();
      }
    });

    it("shows untrusted conceal, clear-screen and OSC sequences literally in raw terminal output", () => {
      const details =
        "benign \x1b[8mHIDDEN DANGEROUS REQUEST\x1b[28m done \x1b[2J\n\nlast\r\t\x1b]2;FAKE TITLE\x07\n";
      const harness = approvalHarness(mode, [{ label: "message", text: details }]);
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
        const harness = approvalHarness(mode, [
          { label: "message", text: `BEFORE${control}AFTER` },
        ]);
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
      it(`keeps the question, borders and all choices visible through the final message line at ${rows} rows`, () => {
        const details =
          Array.from({ length: 100 }, (_, index) => `body-${index}`).join("\n") +
          "\n\nFINAL LINE\n";
        const harness = approvalHarness(mode, [{ label: "message", text: details }]);
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

    it("scrolls by wheel and page in both directions without changing selection", () => {
      const harness = approvalHarness(mode, [
        {
          label: "message",
          text: Array.from({ length: 100 }, (_, index) => `line-${index}`).join("\n"),
        },
      ]);
      try {
        const start = harness.frame();
        harness.terminal.input("\x1b[<65;10;5M");
        const down = harness.frame();
        assert.ok(start[3]?.includes("┌─ message "));
        assert.ok(start[4]?.includes("line-0"));
        assert.ok(down[4]?.includes("line-3"));
        harness.terminal.input("\x1b[<64;10;5M");
        assert.deepEqual(harness.frame(), start);
        const beforePress = harness.frame();
        harness.terminal.input("\x1b[<0;10;5M");
        assert.deepEqual(harness.frame(), beforePress);
        harness.terminal.input("\x1b[6~");
        assert.notDeepEqual(harness.frame(), beforePress);
        harness.terminal.input("\x1b[5~");
        assert.deepEqual(harness.frame(), beforePress);
        harness.terminal.input("\r");
        assert.deepEqual(harness.answers, [OPTIONS[0]]);
      } finally {
        harness.tui.stop();
      }
    });

    it("scrolls through a long message into the session-id cell while keeping choices fixed", () => {
      const harness = approvalHarness(mode, [
        {
          label: "message",
          text: Array.from({ length: 100 }, (_, index) => `line-${index}`).join("\n"),
        },
        { label: "session-id", text: "abc123" },
      ]);
      try {
        const first = harness.frame();
        const choiceRows = OPTIONS.map((option) =>
          first.findIndex((line) => line.includes(option)),
        );
        assert.ok(first[3]?.includes("┌─ message "));
        assert.ok(first[4]?.includes("line-0"));
        for (let page = 0; page < 110; page++) {
          harness.terminal.input("\x1b[6~");
          harness.frame();
        }
        const last = harness.frame();
        const sessionIndex = last.findIndex((line) => line.includes("abc123"));
        assert.ok(sessionIndex > 0);
        assert.ok(last[sessionIndex - 1]?.includes("┌─ session-id "));
        assert.equal(last[sessionIndex - 2]?.slice(2, -2).trim(), "");
        assert.ok(last[sessionIndex - 3]?.includes("└"));
        assert.ok(last[sessionIndex - 4]?.includes("line-99"));
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
      const harness = approvalHarness(mode, [
        { label: "message", text: "日本語🙂".repeat(250) + "\n\nLAST\n" },
      ]);
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
      [1, ["\x1b[B"]],
      [2, ["\x1b[B", "\x1b[B"]],
      [3, ["\x1b[A"]],
    ] as const) {
      it(`confirms choice ${index} with Tab, Shift+Tab or arrow keys`, () => {
        const harness = approvalHarness(mode, [{ label: "message", text: "message: test" }]);
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
      const harness = approvalHarness(mode, [{ label: "message", text: "message: test" }]);
      try {
        harness.frame();
        harness.terminal.input("\x1b");
        assert.deepEqual(harness.answers, [undefined]);
      } finally {
        harness.tui.stop();
      }
    });

    it("enables SGR wheel tracking only when the TUI does not, and disables it on confirm", () => {
      const harness = approvalHarness(mode, [{ label: "message", text: "message: test" }]);
      try {
        harness.frame();
        assert.equal(
          harness.terminal.output.includes("\x1b[?1000h\x1b[?1006h"),
          mode === "regular",
        );
        assert.equal(harness.terminal.output.includes("\x1b[?1006l\x1b[?1000l"), false);
        harness.terminal.input("\r");
        assert.equal(
          harness.terminal.output.includes("\x1b[?1006l\x1b[?1000l"),
          mode === "regular",
        );
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
      registerAgentTool({
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
          return {
            isError: false,
            result: { content: [{ type: "text", text: "Pi session fixture-id" }] },
          };
        },
      };
      const controller = new AbortController();
      try {
        const first = tools[0].execute(
          "test",
          { message: "test" },
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
        const second = tools[0].execute("test", { message: "next" }, undefined, undefined, context);
        if (answer !== "turn" && answer !== "session") harness.getComponent()!.handleInput!("\r");
        await second;
        assert.equal(harness.calls.custom, answer === "turn" || answer === "session" ? 1 : 2);
        if (answer === "turn" || answer === "session") {
          handlers.get("input")!({ source: "interactive" });
          const third = tools[0].execute(
            "test",
            { message: "third" },
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
    const pending = showAgentApproval(
      harness.ui,
      QUESTION,
      [{ label: "message", text: "test" }],
      OPTIONS,
      controller.signal,
    );
    await harness.opened;
    assert.equal(tui.hasOverlay(), true);
    controller.abort();
    assert.equal(await pending, undefined);
    assert.equal(tui.hasOverlay(), false);
    assert.ok(terminal.output.includes("\x1b[?1006l\x1b[?1000l"));
    assert.equal(listeners, 0);
  });

  it("does not open a dialog for an already aborted signal", async () => {
    const tui = new TuiMainScreen(new MemoryTerminal());
    const harness = customUi(tui);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      showAgentApproval(
        harness.ui,
        QUESTION,
        [{ label: "message", text: "x" }],
        OPTIONS,
        controller.signal,
      ),
      { name: "AbortError" },
    );
    assert.equal(harness.calls.custom, 0);
  });

  for (const mode of ["tui", "rpc"] as const) {
    it(`routes ${mode} approval through its own UI and preserves the full message`, async () => {
      const oldAgent = process.env.PI_AGENT_NAME;
      process.env.PI_AGENT_NAME = "main";
      const terminal = new MemoryTerminal();
      const tui = new TuiMainScreen(terminal);
      const harness = customUi(tui);
      const tools: any[] = [];
      registerAgentTool({
        registerTool(tool: unknown) {
          tools.push(tool);
        },
        on() {},
      } as any);
      const commands: string[] = [];
      const message = "x".repeat(100) + "\n\nFINAL\x1b[8m hidden\x1b[28m\r\t\n";
      try {
        const pending = tools[0].execute("test", { message }, undefined, undefined, {
          mode,
          hasUI: true,
          cwd: "/repo",
          ui: harness.ui,
          async executeTool(_name: string, args: { command: string }) {
            commands.push(args.command);
            return {
              isError: false,
              result: { content: [{ type: "text", text: "Pi session fixture-id" }] },
            };
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
          assert.equal(rendered.includes("┌─ session-id "), false);
          harness.getComponent()!.handleInput!("\r");
        }
        const result = await pending;
        assert.equal(result.structuredContent.status, "created");
        assert.equal(harness.calls.custom, mode === "tui" ? 1 : 0);
        assert.equal(harness.calls.select, mode === "rpc" ? 1 : 0);
        assert.equal(commands.length, 1);
        const script = parse(commands[0]!)[2] as string;
        assert.equal(parse(script).at(-1), message);
      } finally {
        if (oldAgent === undefined) delete process.env.PI_AGENT_NAME;
        else process.env.PI_AGENT_NAME = oldAgent;
      }
    });

    it(`routes ${mode} send approval with the session id and wait`, async () => {
      const oldAgent = process.env.PI_AGENT_NAME;
      process.env.PI_AGENT_NAME = "main";
      const terminal = new MemoryTerminal();
      const tui = new TuiMainScreen(terminal);
      const harness = customUi(tui);
      const tools: any[] = [];
      registerAgentTool({
        registerTool(tool: unknown) {
          tools.push(tool);
        },
        on() {},
      } as any);
      const commands: string[] = [];
      const message = "report the status";
      try {
        const pending = tools[0].execute(
          "test",
          { message, "session-id": "abc123", wait: 20 },
          undefined,
          undefined,
          {
            mode,
            hasUI: true,
            cwd: "/repo",
            ui: harness.ui,
            async executeTool(_name: string, args: { command: string }) {
              commands.push(args.command);
              return { isError: false, result: { content: [{ type: "text", text: "delivered" }] } };
            },
          },
        );
        if (mode === "tui") {
          await harness.opened;
          const rendered = harness
            .getComponent()!
            .render(80)
            .map(stripTerminalSequences)
            .join("\n");
          assert.ok(rendered.includes("┌─ session-id "));
          assert.ok(rendered.includes("abc123"));
          assert.ok(rendered.includes("20 seconds"));
          assert.ok(rendered.includes("report the status"));
          harness.getComponent()!.handleInput!("\r");
        }
        const result = await pending;
        assert.equal(result.structuredContent.status, "delivered");
        assert.equal(harness.calls.custom, mode === "tui" ? 1 : 0);
        assert.equal(harness.calls.select, mode === "rpc" ? 1 : 0);
        assert.equal(commands.length, 1);
        const inner = parse(parse(commands[0]!)[2] as string);
        assert.deepEqual(inner.slice(inner.indexOf("send")), [
          "send",
          "--wait",
          "20",
          "abc123",
          message,
        ]);
      } finally {
        if (oldAgent === undefined) delete process.env.PI_AGENT_NAME;
        else process.env.PI_AGENT_NAME = oldAgent;
      }
    });
  }
});
