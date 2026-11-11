import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "bun:test";
import {
  AssistantMessageComponent,
  type ExtensionAPI,
  getMarkdownTheme,
  initTheme,
  Theme,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
  getCapabilities,
  getCellDimensions,
  getOsc8LinkAtColumn,
  Image,
  type MarkdownTheme,
  setCapabilities,
  setCellDimensions,
  sliceByColumn,
  Spacer,
  stripTerminalSequences,
  Text,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { isImageLine } from "@earendil-works/pi-tui/dist/terminal-image.js";
import { getActiveBackgroundAnsi } from "@earendil-works/pi-tui/dist/utils.js";
import extensionDefault from "./index.ts";
import { installMessageStamps } from "./message-stamps.ts";

const themes = (await import(
  fileURLToPath(
    new URL(
      "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js",
      import.meta.url,
    ),
  )
)) as {
  getThemeByName(name: string): Theme | undefined;
  setThemeInstance(theme: Theme): void;
};
const recordedTime = new Date(2025, 0, 1, 21, 30, 3);
const recordedTimeMs = recordedTime.getTime();
const stamp = "21:30:03";
const originalAssistantRender = AssistantMessageComponent.prototype.render;
const originalUserRender = UserMessageComponent.prototype.render;
const originalCapabilities = { ...getCapabilities() };
const originalCellDimensions = { ...getCellDimensions() };
let currentTheme: Theme;
let dispose: () => void;

beforeEach(() => {
  initTheme("dark", false);
  currentTheme = themes.getThemeByName("dark")!;
  themes.setThemeInstance(currentTheme);
  dispose = installMessageStamps(currentTheme);
});
afterEach(() => {
  dispose();
  setCapabilities(originalCapabilities);
  setCellDimensions(originalCellDimensions);
});

type AssistantMessageInput = NonNullable<
  ConstructorParameters<typeof AssistantMessageComponent>[0]
>;
type MessageComponent = AssistantMessageComponent | UserMessageComponent;

function assistantMessage(content: AssistantMessageInput["content"]): AssistantMessageInput {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "openai",
    model: "test-model",
    usage: {},
    stopReason: "stop",
    timestamp: recordedTimeMs,
  } as AssistantMessageInput;
}

function textResponse(
  text: string,
  outputPad = 1,
  markdownTheme = getMarkdownTheme(),
): AssistantMessageComponent {
  return new AssistantMessageComponent(
    assistantMessage([{ type: "text", text }]),
    false,
    markdownTheme,
    undefined,
    outputPad,
  );
}

function userMessage(
  text: string,
  outputPad = 1,
  markdownTheme = getMarkdownTheme(),
): UserMessageComponent {
  const component = new UserMessageComponent(text, markdownTheme, outputPad);
  (component as unknown as { timestamp: string }).timestamp = recordedTime.toISOString();
  return component;
}

function renderWithoutBox(component: MessageComponent, width: number): string[] {
  if (component instanceof UserMessageComponent) return originalUserRender.call(component, width);
  return originalAssistantRender.call(component, width);
}

function withoutBackground(line: string): string {
  return line
    .split("\x1b[")
    .map((part, index) => {
      if (index === 0) return part;
      const background = /^(?:49|48;2;\d+;\d+;\d+|48;5;\d+|4[0-7]|10[0-7])m/.exec(part);
      return background ? part.slice(background[0].length) : "\x1b[" + part;
    })
    .join("");
}

function imageComponent(): Image {
  return new Image(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "image/png",
    { fallbackColor: (text) => text },
    { imageId: 7, maxWidthCells: 8, maxHeightCells: 4 },
    { widthPx: 64, heightPx: 64 },
  );
}

for (const { role, create, bottomPadding } of [
  { role: "user", create: userMessage, bottomPadding: 1 },
  { role: "assistant", create: textResponse, bottomPadding: 0 },
]) {
  describe(`${role} message boxes`, () => {
    it("uses one top row and one timestamp footer without duplicating native padding", () => {
      const component = create("hello");
      const baseline = renderWithoutBox(component, 80);
      const lines = component.render(80);
      assert.deepEqual(lines.map(stripTerminalSequences), [
        " ".repeat(80),
        " hello" + " ".repeat(74),
        " ".repeat(72) + stamp,
      ]);
      assert.equal(lines.length, baseline.length + 1 - bottomPadding);
      assert.ok(lines.at(-1)!.includes(currentTheme.fg("dim", stamp)));
      for (const line of lines) {
        assert.equal(visibleWidth(line), 80);
        for (const column of [0, 6, 79]) {
          assert.equal(
            getActiveBackgroundAnsi(sliceByColumn(line, 0, column + 1)),
            currentTheme.getBgAnsi("userMessageBg"),
          );
        }
      }
    });

    for (const text of [
      "first line\n\nlast line",
      "This paragraph wraps across several display lines and ends here.",
      "```ts\nconst answer = 42;\n```",
      "\x1b[31m\u6f22\u5b57\u{1f642}e\u0301\x1b[39m",
      "hello\x1b[31m" + "\u3000".repeat(5) + "\x1b[39m",
    ]) {
      it(`keeps rendered body content, styles and wrapping: ${JSON.stringify(text)}`, () => {
        const component = create(text);
        const width = 21;
        const baseline = renderWithoutBox(component, width);
        const body = baseline.slice(1, baseline.length - bottomPadding);
        const lines = component.render(width);
        assert.deepEqual(lines.slice(1, -1).map(withoutBackground), body.map(withoutBackground));
        assert.equal(stripTerminalSequences(lines.at(-1)!), " ".repeat(13) + stamp);
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
      });
    }

    it("retains body trailing blank rows separately from the footer", () => {
      const component = create("body");
      component.addChild(new Text("tail\n\n", 1, 0));
      const baseline = renderWithoutBox(component, 80);
      const lines = component.render(80);
      assert.equal(lines.length, baseline.length + 1);
      assert.deepEqual(
        lines.slice(1, -1).map(withoutBackground),
        baseline.slice(1).map(withoutBackground),
      );
      assert.equal(stripTerminalSequences(lines.at(-2)!).trim(), "");
      assert.equal(visibleWidth(lines.at(-2)!), 80);
      assert.equal(stripTerminalSequences(lines.at(-1)!), " ".repeat(72) + stamp);
    });

    for (const outputPad of [0, 2]) {
      it(`keeps horizontal outputPad=${outputPad}`, () => {
        const component = create("hello", outputPad);
        const baseline = renderWithoutBox(component, 80);
        assert.deepEqual(
          component.render(80).slice(1, -1).map(withoutBackground),
          baseline.slice(1, baseline.length - bottomPadding).map(withoutBackground),
        );
      });
    }

    it("preserves hyperlinks in the body but does not link the footer", () => {
      setCapabilities({ ...originalCapabilities, hyperlinks: true });
      const lines = create("[docs](https://example.com)").render(80);
      assert.equal(getOsc8LinkAtColumn(lines[1]!, 1), "https://example.com");
      assert.equal(getOsc8LinkAtColumn(lines.at(-1)!, 72), undefined);
    });

    it("restores the outer background after a child code background closes", () => {
      const markdownTheme: MarkdownTheme = {
        ...getMarkdownTheme(),
        highlightCode: (code) => ["\x1b[44m" + code + "\x1b[49m plain"],
      };
      const component = create("```ts\nconst answer = 42;\n```", 1, markdownTheme);
      const baseline = renderWithoutBox(component, 80);
      const lines = component.render(80);
      const codeLine = lines.find((line) => stripTerminalSequences(line).includes("const answer"))!;
      const plainCode = stripTerminalSequences(codeLine);
      const codeColumn = visibleWidth(plainCode.slice(0, plainCode.indexOf("const")));
      const plainColumn = visibleWidth(plainCode.slice(0, plainCode.indexOf("plain")));
      assert.equal(getActiveBackgroundAnsi(sliceByColumn(codeLine, 0, codeColumn + 1)), "\x1b[44m");
      assert.equal(
        getActiveBackgroundAnsi(sliceByColumn(codeLine, 0, plainColumn + 1)),
        currentTheme.getBgAnsi("userMessageBg"),
      );
      assert.deepEqual(
        lines.slice(1, -1).map(withoutBackground),
        baseline.slice(1, baseline.length - bottomPadding).map(withoutBackground),
      );
    });

    for (const { name, text, childBackground } of [
      { name: "combined full reset", text: "before\x1b[0;31mafter" },
      { name: "combined child background close", text: "before\x1b[44mchild\x1b[49;39mafter" },
      {
        name: "truecolor background with reset-valued channels",
        text: "before\x1b[0;48;2;0;49;0mafter\x1b[49;39m tail",
        childBackground: "\x1b[48;2;0;49;0m",
      },
      {
        name: "indexed background with a reset-valued index",
        text: "before\x1b[0;48;5;49mafter\x1b[49;39m tail",
        childBackground: "\x1b[48;5;49m",
      },
    ]) {
      it(`keeps effective backgrounds across ${name}`, () => {
        const component = create(text);
        const baseline = renderWithoutBox(component, 80);
        const lines = component.render(80);
        const body = lines[1]!;
        const plainBody = stripTerminalSequences(body);
        const afterColumn = visibleWidth(plainBody.slice(0, plainBody.indexOf("after")));
        assert.equal(lines.length, 3);
        assert.equal(visibleWidth(body), 80);
        assert.equal(
          getActiveBackgroundAnsi(sliceByColumn(body, 0, afterColumn + 1)),
          childBackground ?? currentTheme.getBgAnsi("userMessageBg"),
        );
        assert.equal(
          getActiveBackgroundAnsi(sliceByColumn(body, 0, 80)),
          currentTheme.getBgAnsi("userMessageBg"),
        );
        assert.deepEqual(
          lines.slice(1, -1).map(withoutBackground),
          baseline.slice(1, baseline.length - bottomPadding).map(withoutBackground),
        );
      });
    }

    for (const width of [8, 7, 2]) {
      it(`keeps the box at width ${width} and shows only a fitting timestamp`, () => {
        const component = create("hi", 0);
        const lines = component.render(width);
        assert.equal(lines.length, 3);
        assert.equal(stripTerminalSequences(lines[0]!), " ".repeat(width));
        assert.equal(stripTerminalSequences(lines.at(-1)!), width >= 8 ? stamp : " ".repeat(width));
        assert.ok(lines.every((line) => visibleWidth(line) === width));
      });
    }

    it("keeps a colored empty footer when the timestamp is unavailable", () => {
      const component = create("hello");
      if (component instanceof UserMessageComponent) {
        delete (component as unknown as { timestamp?: string }).timestamp;
      } else {
        delete (component as unknown as { lastMessage: { timestamp?: number } }).lastMessage
          .timestamp;
      }
      const lines = component.render(80);
      assert.equal(lines.length, 3);
      assert.equal(stripTerminalSequences(lines.at(-1)!), " ".repeat(80));
      assert.equal(
        getActiveBackgroundAnsi(sliceByColumn(lines.at(-1)!, 0, 80)),
        currentTheme.getBgAnsi("userMessageBg"),
      );
    });

    for (const text of ["", " \n \n"]) {
      it(`does not add a box around an empty body: ${JSON.stringify(text)}`, () => {
        const component = create(text);
        assert.deepEqual(component.render(80), renderWithoutBox(component, 80));
      });
    }

    it("does not duplicate padding or mutate cached body lines after resize", () => {
      const component = create("hello");
      const baseline = renderWithoutBox(component, 80);
      for (const width of [80, 21, 7, 8, 80, 80]) {
        const lines = component.render(width);
        assert.equal(lines.length, 3, `width=${width}`);
        assert.equal(
          stripTerminalSequences(lines.join("\n")).split(stamp).length - 1,
          width >= 8 ? 1 : 0,
          `width=${width}`,
        );
      }
      assert.deepEqual(renderWithoutBox(component, 80), baseline);
    });

    it("restores existing components and both original renderers on dispose", () => {
      const component = create("hello");
      const baseline = renderWithoutBox(component, 80);
      component.render(80);
      dispose();
      assert.equal(UserMessageComponent.prototype.render, originalUserRender);
      assert.equal(AssistantMessageComponent.prototype.render, originalAssistantRender);
      assert.deepEqual(component.render(80), baseline);
    });

    for (const protocol of ["kitty", "iterm2"] as const) {
      for (const text of ["", "before image"]) {
        it(`preserves ${protocol} controls and height reservations: ${JSON.stringify(text)}`, () => {
          setCapabilities({ ...originalCapabilities, images: protocol });
          setCellDimensions({ widthPx: 8, heightPx: 16 });
          const component = create(text);
          const image = imageComponent();
          component.addChild(image);
          const imageLines = image.render(80).slice();
          const baseline = renderWithoutBox(component, 80);
          const originalImageStart = baseline.length - imageLines.length;
          const offset = text === "" ? 1 : 0;
          const lines = component.render(80);
          assert.ok(imageLines.some(isImageLine));
          assert.ok(imageLines.length > 1);
          assert.deepEqual(
            lines.slice(
              originalImageStart + offset,
              originalImageStart + offset + imageLines.length,
            ),
            baseline.slice(originalImageStart),
          );
          assert.equal(stripTerminalSequences(lines[0]!), " ".repeat(80));
          assert.equal(stripTerminalSequences(lines.at(-1)!), " ".repeat(72) + stamp);
          assert.deepEqual(image.render(80), imageLines);
        });
      }
    }

    it("colors body blank rows after an image without consuming its reserved rows", () => {
      setCapabilities({ ...originalCapabilities, images: "kitty" });
      const component = create("");
      const image = imageComponent();
      component.addChild(image);
      component.addChild(new Spacer(2));
      const imageHeight = image.render(80).length;
      const baseline = renderWithoutBox(component, 80);
      const lines = component.render(80);
      assert.deepEqual(lines.slice(1, 1 + imageHeight), baseline.slice(0, imageHeight));
      for (const line of lines.slice(1 + imageHeight, -1)) {
        assert.equal(stripTerminalSequences(line), " ".repeat(80));
        assert.equal(
          getActiveBackgroundAnsi(sliceByColumn(line, 0, 80)),
          currentTheme.getBgAnsi("userMessageBg"),
        );
      }
      assert.equal(lines.length, baseline.length + 2);
    });
  });
}

for (const themeName of ["dark", "light"]) {
  it(`uses the existing user background for both roles in the ${themeName} theme`, () => {
    initTheme(themeName, false);
    dispose();
    currentTheme = themes.getThemeByName(themeName)!;
    themes.setThemeInstance(currentTheme);
    dispose = installMessageStamps(currentTheme);
    for (const component of [userMessage("hello"), textResponse("hello")]) {
      for (const line of component.render(80)) {
        assert.equal(
          getActiveBackgroundAnsi(sliceByColumn(line, 0, 80)),
          currentTheme.getBgAnsi("userMessageBg"),
        );
      }
    }
  });
}

it("keeps terminal-default backgrounds without inventing a fallback color", () => {
  const tokens = Object.fromEntries(Object.keys(currentTheme.colors).map((token) => [token, ""]));
  const colorless = new Theme(
    tokens as ConstructorParameters<typeof Theme>[0],
    tokens as ConstructorParameters<typeof Theme>[1],
    "truecolor",
  );
  dispose();
  themes.setThemeInstance(colorless);
  dispose = installMessageStamps(colorless);
  for (const component of [userMessage("hello"), textResponse("hello")]) {
    const lines = component.render(80);
    assert.equal(lines.length, 3);
    assert.equal(stripTerminalSequences(lines.at(-1)!), " ".repeat(72) + stamp);
    assert.ok(lines.every((line) => getActiveBackgroundAnsi(sliceByColumn(line, 0, 80)) === ""));
  }
});

describe("message timestamp sources", () => {
  it("prefers the assistant entry timestamp over message creation time", () => {
    const component = textResponse("reply body");
    (component as unknown as { timestamp: string }).timestamp = new Date(
      2025,
      0,
      1,
      20,
      0,
      0,
    ).toISOString();
    assert.equal(stripTerminalSequences(component.render(80).at(-1)!), " ".repeat(72) + "20:00:00");
  });

  it("keeps an empty footer for an invalid timestamp", () => {
    const component = userMessage("hello");
    (component as unknown as { timestamp: string }).timestamp = "invalid";
    assert.equal(stripTerminalSequences(component.render(80).at(-1)!), " ".repeat(80));
  });

  it("leaves tool-carrying assistant responses unchanged even when they contain text", () => {
    const component = new AssistantMessageComponent(
      assistantMessage([
        { type: "text", text: "checking files" },
        { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } },
      ] as AssistantMessageInput["content"]),
    );
    assert.deepEqual(component.render(80), renderWithoutBox(component, 80));
  });

  it("keeps source messages unchanged", () => {
    const input = assistantMessage([{ type: "text", text: "reply body" }]);
    const snapshot = structuredClone(input);
    const component = new AssistantMessageComponent(input);
    component.render(80);
    component.render(7);
    assert.deepEqual(input, snapshot);
  });

  it("assigns live user timestamps once in event order and keeps them after resize", () => {
    const { pi, handlers } = captureExtension();
    extensionDefault(pi);
    const onMessageStart = handlers.get("message_start")!;
    onMessageStart({ message: { role: "assistant", timestamp: recordedTimeMs - 1_000 } }, {});
    onMessageStart({ message: { role: "user", timestamp: recordedTimeMs } }, {});
    onMessageStart({ message: { role: "user", timestamp: recordedTimeMs + 1_000 } }, {});
    const first = new UserMessageComponent("first");
    const second = new UserMessageComponent("second");
    for (const width of [80, 13, 80]) {
      assert.equal(
        stripTerminalSequences(first.render(width).at(-1)!),
        " ".repeat(width - 8) + stamp,
      );
    }
    assert.equal(stripTerminalSequences(second.render(80).at(-1)!), " ".repeat(72) + "21:30:04");
  });
});

it("renders boxes through Node and the installed host module aliases", () => {
  const result = spawnSync(
    "node",
    [
      "--input-type=module",
      "-e",
      String.raw`
import assert from "node:assert/strict";
import { homedir } from "node:os";
const modules = homedir() + "/.bun/install/global/node_modules";
const { createJiti } = await import(modules + "/jiti/lib/jiti.mjs");
const alias = Object.fromEntries(["coding-agent", "tui", "ai", "agent-core"].map(name => [
  "@earendil-works/pi-" + name, modules + "/@earendil-works/pi-" + name + "/dist/index.js",
]));
const jiti = createJiti(import.meta.url, { alias, fsCache: false, moduleCache: true });
const host = await jiti.import(alias["@earendil-works/pi-coding-agent"]);
const tui = await jiti.import(alias["@earendil-works/pi-tui"]);
const utils = await jiti.import(modules + "/@earendil-works/pi-tui/dist/utils.js");
const themes = await jiti.import(modules + "/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js");
const stamps = await jiti.import(process.argv[1]);
themes.initTheme("dark", false);
const theme = themes.getThemeByName("dark");
const timestamp = new Date(2025, 0, 1, 21, 30, 3);
const user = new host.UserMessageComponent("hello");
user.timestamp = timestamp.toISOString();
const assistant = new host.AssistantMessageComponent({
  role: "assistant", content: [{ type: "text", text: "hello" }],
  timestamp: timestamp.getTime(), stopReason: "stop",
});
const components = [user, assistant];
const baselines = components.map(component => component.render(80));
const originalRenders = [host.UserMessageComponent.prototype.render, host.AssistantMessageComponent.prototype.render];
const dispose = stamps.installMessageStamps(theme);
try {
  for (const component of components) {
    const lines = component.render(80);
    assert.deepEqual(lines.map(tui.stripTerminalSequences), [
      " ".repeat(80), " hello" + " ".repeat(74), " ".repeat(72) + "21:30:03",
    ]);
    for (const line of lines) {
      assert.equal(utils.getActiveBackgroundAnsi(tui.sliceByColumn(line, 0, 80)), theme.getBgAnsi("userMessageBg"));
    }
    for (const width of [14, 7, 80, 80]) {
      const resized = component.render(width).map(tui.stripTerminalSequences);
      assert.equal(resized.length, 3);
      assert.equal(resized.at(-1), width >= 8 ? " ".repeat(width - 8) + "21:30:03" : " ".repeat(width));
    }
  }
  for (const protocol of ["kitty", "iterm2"]) {
    tui.setCapabilities({ ...tui.getCapabilities(), images: protocol });
    tui.setCellDimensions({ widthPx: 8, heightPx: 16 });
    const imageMessages = [
      new host.UserMessageComponent(""),
      new host.AssistantMessageComponent({ role: "assistant", content: [], timestamp: timestamp.getTime(), stopReason: "stop" }),
    ];
    imageMessages[0].timestamp = timestamp.toISOString();
    imageMessages.forEach((component, index) => {
      const image = new tui.Image(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
        "image/png", { fallbackColor: text => text },
        { imageId: 11, maxWidthCells: 8, maxHeightCells: 4 }, { widthPx: 64, heightPx: 64 },
      );
      component.addChild(image);
      const original = originalRenders[index].call(component, 80);
      assert.ok(original.length > 1);
      const boxed = component.render(80);
      assert.deepEqual(boxed.slice(1, -1), original);
      assert.equal(tui.stripTerminalSequences(boxed.at(-1)), " ".repeat(72) + "21:30:03");
    });
  }
} finally {
  dispose();
}
components.forEach((component, index) => assert.deepEqual(component.render(80), baselines[index]));
`,
      fileURLToPath(new URL("./message-stamps.ts", import.meta.url)),
    ],
    { encoding: "utf8", timeout: 20_000 },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}, 30_000);

describe("legacy pi-stamp entries", () => {
  it("renders recorded pi-stamp entries as nothing", () => {
    let renderer: ((entry: unknown) => unknown) | undefined;
    const pi = {
      registerEntryRenderer: (_type: string, value: (entry: unknown) => unknown) => {
        renderer = value;
      },
    } as unknown as ExtensionAPI;
    extensionDefault(pi);
    const rendered = renderer!({ customType: "pi-stamp" }) as { render: () => string[] };
    assert.deepEqual(rendered.render(), []);
  });
});

function captureExtension() {
  const handlers = new Map<string, (event: any, ctx: any) => void>();
  const pi = {
    on: (event: string, handler: (event: any, ctx: any) => void) => {
      handlers.set(event, handler);
    },
    registerEntryRenderer: () => {},
  } as unknown as ExtensionAPI;
  return { pi, handlers };
}
