import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "bun:test";
import { displayLibrary } from "./library.data";
import { validateOpuiLang } from "./render";

let specDir: string;
beforeAll(() => {
  const temporaryRoot = "/tmp/work/dotfiles/openui-preview-tests";
  mkdirSync(temporaryRoot, { recursive: true });
  specDir = mkdtempSync(join(temporaryRoot, "validation-"));
  writeFileSync(join(specDir, "spec.json"), JSON.stringify(displayLibrary.toSpec()));
});
afterAll(() => {
  rmSync(specDir, { recursive: true, force: true });
});

describe("validateOpuiLang", () => {
  for (const [name, source] of [
    ["card", 'root = Stack([Card([CardHeader("Report"), TextContent("Revenue **rose**")])])'],
    ["table", 'root = Stack([Table([Col("Name", ["A", "B"]), Col("Value", [10, 20])])])'],
    ["bar", 'root = Stack([BarChart(["A", "B"], [Series("Sales", [10, 20])])])'],
    ["line", 'root = Stack([LineChart(["A", "B"], [Series("Sales", [10, 20])])])'],
    ["area", 'root = Stack([AreaChart(["A", "B"], [Series("Sales", [10, 20])])])'],
    [
      "horizontal bar",
      'root = Stack([HorizontalBarChart(["A", "B"], [Series("Sales", [10, 20])])])',
    ],
    ["pie", 'root = Stack([PieChart(["A", "B"], [10, 20])])'],
    ["radar", 'root = Stack([RadarChart(["A", "B", "C"], [Series("Sales", [10, 20, 15])])])'],
    ["radial", 'root = Stack([RadialChart(["A", "B"], [10, 20])])'],
    ["stacked bar", 'root = Stack([SingleStackedBarChart(["A", "B"], [10, 20])])'],
    [
      "scatter",
      'root = Stack([ScatterChart([ScatterSeries("Sales", [Point(10, 20), Point(20, 30)])])])',
    ],
    [
      "tabs",
      'root = Stack([Tabs([TabItem("a", "A", [TextContent("one")]), TabItem("b", "B", [TextContent("two")])])])',
    ],
    ["accordion", 'root = Stack([Accordion([AccordionItem("a", "A", [TextContent("one")])])])'],
    ["carousel", 'root = Stack([Carousel([[TextContent("one")], [TextContent("two")]])])'],
    ["markup as data", 'root = Stack([TextContent("<script>throw 1</script>")])'],
  ] as const) {
    it(`accepts ${name} using the generated display-only schema`, () => {
      assert.deepEqual(validateOpuiLang(source, specDir), { ok: true }, name);
    });
  }

  for (const [name, source, expected] of [
    ["unknown component", 'root = Stack([Mystery("x")])', /display-only library/],
    ["interactive component", 'root = Stack([Button("Go")])', /display-only library/],
    ["incomplete program", 'root = Stack([TextContent("x"', /truncated/],
    ["missing root", "", /root/],
    ["invalid props", 'root = Stack([CodeBlock("only-language")])', /codeString/],
    ["query", 'root = Stack([TextContent("hello")])\nq = Query("tool", {})', /Query/],
    ["mutation", 'root = Stack([TextContent("hello")])\nm = Mutation("tool", {})', /Mutation/],
    ["reactive declaration", 'root = Stack([TextContent("hello")])\n$visible = true', /reactive/],
    ["reactive binding", 'root = Stack([TextContent($title)])\n$title = "hello"', /reactive/],
    ["unresolved reference", "root = Stack([missing])", /unresolved/],
  ] as const) {
    it(`rejects ${name} before browser execution`, () => {
      const result = validateOpuiLang(source, specDir);
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.error, expected);
    });
  }
});
