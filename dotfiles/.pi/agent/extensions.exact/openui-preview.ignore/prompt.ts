import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createParser,
  generateSystemPrompt,
  isASTNode,
  type ElementNode,
  type LibrarySpec,
} from "@openuidev/lang-core";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const PREAMBLE = `You are an AI assistant that answers in markdown. When a response benefits from a generated UI, embed complete openui-lang programs in fenced \`\`\`openui-lang code blocks inside your markdown answer.`;
function staticRules(supported: Set<string>): string {
  const stateful = ["Tabs", "Accordion", "Carousel", "Steps", "Table"].filter((name) =>
    supported.has(name),
  );
  const hasImages = [
    "Image",
    "ImageBlock",
    "ImageGallery",
    "ImageText",
    "ImageTextLarge",
    "ContextCardItem",
    "VisualCardItem",
    "ListItem",
  ].some((name) => supported.has(name));
  return [
    "## 静的プレビューの作成",
    "",
    "- 値にはリテラル、配列、オブジェクト、表示部品の呼出し、通常の名前参照を使う。計算・集計・条件選択は出力前に済ませ、確定した値を書く。",
    "- 各プログラムにrootを定義し、すべての参照先を同じフェンス内に含める。定義順にかかわらず、rootから使う部品とデータを参照する。",
    "- 引数は位置順。末尾の省略可能引数は省略できる。中間の省略可能引数やnull型の引数を飛ばして後続を渡すときはnullを置く。",
    ...(stateful.length
      ? [
          `- ${stateful.join("・")}等は既存部品の初期状態を撮影する。操作で切り替えた後の内容は画像に含まれない。`,
        ]
      : []),
    ...(supported.has("Callout")
      ? ["- Calloutは静的なバナーとして使い、visible引数は省略する。"]
      : []),
    ...(hasImages
      ? [
          `- 画像のsrc・bgImageSrc等はdata:形式に埋め込んだ画像を使う。利用できる画像データがなければ任意の画像引数を省略するか、${supported.has("Icon") ? "テキストやIcon" : "テキスト"}を使う。`,
        ]
      : []),
    "- 完結したopenui-langフェンスをmarkdown応答内へ出力する。撮影はメッセージ確定後に1回行われる。幅960 px・高さ1280 pxの表示領域に収める。",
    "",
  ].join("\n");
}
const STATIC_TEXT_REPLACEMENTS: Record<string, string> = {
  "- Use Tabs for alternative views (chart types, data sections) — no $variable needed": "",
  "- Shared filter across Tabs: same $days binding in Query args works across all TabItems": "",
  '- Success toast: Callout("success", "Saved", "Done.", $showSuccess) — use @Set($showSuccess, true) in save action, auto-dismisses after 3s. For errors: result.status == "error" ? Callout("error", "Failed", result.error) : null':
    "",
  "- data is an array of { id, values } rows where values are ordered positionally to match columns. Edited data is submitted when the user clicks Save Changes.":
    "",
  '- Col data can be component arrays for styled cells: Col("Status", @Each(data.rows, "item", Tag(item.status, null, "sm", item.status == "open" ? "success" : "danger")))':
    "",
  "- Chain sort + filter: filtered = @Filter(...) then sorted = @Sort(filtered, ...) — use sorted for both Table and Charts":
    "",
  '- Empty state: @Count(data.rows) > 0 ? Table([...]) : TextContent("No data yet")': "",
  '- Charts accept column arrays: LineChart(labels, [Series("Name", values)]). Use array pluck: LineChart(data.rows.day, [Series("Views", data.rows.views)])':
    "",
  "- Chart + Table from same source: use @Sort or @Filter result for both LineChart and Table Col data":
    "",
  '- Multiple chart views: use Tabs — Tabs([TabItem("line", "Line", [LineChart(...)]), TabItem("bar", "Bar", [BarChart(...)])])':
    "",
  "- PieChart and BarChart need NUMBERS, not objects. For list data, use @Count(@Filter(...)) to aggregate:":
    "",
  '- PieChart from list: `PieChart(["Low", "Med", "High"], [@Count(@Filter(data.rows, "priority", "==", "low")), @Count(@Filter(data.rows, "priority", "==", "medium")), @Count(@Filter(data.rows, "priority", "==", "high"))], "donut")`':
    "",
  '- KPI from count: `TextContent("" + @Count(@Filter(data.rows, "status", "==", "open")), "large-heavy")`':
    "",
  '- Color-mapped Tag: Tag(value, null, "sm", value == "high" ? "danger" : value == "medium" ? "warning" : "neutral")':
    "",
  "- ListBlock is a numbered or image list of ListItem references. An action on ListItem is optional.":
    "",
  "Image URLs must be real (from a tool result or the user) — never invent or template an image URL.":
    "",
  "Use existing components (Tabs, Accordion) before inventing ternary show/hide patterns": "",
};

interface PromptOptionsFile {
  examples: string[];
  additionalRules: string[];
}

export function opuiSkill(dir: string = EXTENSION_DIR): string {
  return `---
name: openui-preview
description: >-
  markdown応答内に表示専用のOpenUI Langを作成する。生成UIを使う応答や、
  openui-langコードフェンスの作成・修正時に使う。
---

${openuiInstructions(dir)}
`;
}

export function openuiInstructions(dir: string = EXTENSION_DIR): string {
  const library = JSON.parse(readFileSync(join(dir, "spec.json"), "utf8")) as LibrarySpec;
  const options = JSON.parse(
    readFileSync(join(dir, "prompt-options.json"), "utf8"),
  ) as PromptOptionsFile;
  const supportedTypes = new Set(Object.keys(library.components));
  const components = Object.fromEntries(
    Object.entries(library.components).map(([name, component]) => [
      name,
      {
        ...component,
        signature: staticSignature(name, component.signature, supportedTypes),
        description: staticDescription(name, component.description),
      },
    ]),
  );
  const parser = library.schema ? createParser(library.schema, library.root) : undefined;
  const examples = options.examples.filter((example) => {
    if (!parser) return true;
    const source = example.match(/^[\w$]+\s*=/m);
    if (!source) return false;
    const parsed = parser.parse(example.slice(source.index));
    return (
      parsed.root !== null &&
      !parsed.meta.incomplete &&
      parsed.meta.errors.length === 0 &&
      parsed.meta.unresolved.length === 0 &&
      parsed.queryStatements.length === 0 &&
      parsed.mutationStatements.length === 0 &&
      Object.keys(parsed.stateDeclarations).length === 0 &&
      !containsDynamicValue(parsed.root) &&
      !containsBlockedImageReference(parsed.root)
    );
  });
  const prompt = generateSystemPrompt({
    library: {
      ...library,
      components,
      componentGroups: library.componentGroups?.map((group) => ({
        ...group,
        notes: group.notes?.map((note) => STATIC_TEXT_REPLACEMENTS[note] ?? note).filter(Boolean),
      })),
    },
    promptOptions: {
      preamble: PREAMBLE,
      toolCalls: false,
      bindings: false,
      examples,
    },
  });
  const sections = prompt.split(/(?=^## )/m);
  const staticSections = sections.filter(
    (section, index) =>
      index === 0 ||
      ["## Syntax Rules\n", "## Component Signatures\n", "## Examples\n"].some((heading) =>
        section.startsWith(heading),
      ),
  );
  const rules = options.additionalRules
    .map((rule) => STATIC_TEXT_REPLACEMENTS[rule] ?? rule)
    .filter(Boolean);
  const instructions = staticSections
    .join("")
    .replace("; prefer references for better streaming.", ".");
  const syntax = supportedTypes.has("Stack")
    ? instructions
    : instructions
        .replace(
          /^2\. .*root = Stack.*$/m,
          "2. 各プログラムの入口としてrootを定義し、選択された表示部品を指定する。",
        )
        .replace(/^6\. .*SomeComp.*$/m, "6. 引数は名前付きではなく、signatureの位置順に指定する。");
  return (
    syntax.trimEnd() +
    "\n\n" +
    staticRules(supportedTypes) +
    (rules.length ? "\n" + rules.map((rule) => `- ${rule}`).join("\n") : "")
  );
}

function staticSignature(name: string, signature: string, supportedTypes: Set<string>): string {
  const projected = signature.replace(
    /"(?:\\.|[^"\\])*"|\$binding<[^>]+>|\b[A-Z]\w*(?:\s*\|\s*[A-Z]\w*)*/g,
    (type) => {
      if (type.startsWith('"')) return type;
      if (type.startsWith("$binding<")) return "null";
      return (
        type
          .split(/\s*\|\s*/)
          .filter((part) => supportedTypes.has(part))
          .join(" | ") || "null"
      );
    },
  );
  if (name === "Col") return projected.replace(' | "action"', "");
  if (name === "ListItem") return projected.replace("actionLabel?: string", "actionLabel?: null");
  return projected;
}

function staticDescription(name: string, description?: string): string | undefined {
  if (!description) return description;
  const removals: Record<string, string> = {
    Callout:
      " Optional visible is a reactive $boolean — auto-dismisses after 3s by setting $visible to false.",
    ListItem: " When action is provided, the item becomes clickable.",
    ListBlock: "Each item can optionally have an action. ",
    ImageText: " src must be a real image URL.",
    ImageTextLarge: " src must be a real image URL.",
    ImageGallery: " with modal preview",
    VisualCardItem: " (bgImageSrc must be a real URL; bgImageAlt is its alt text)",
    PieChart: "; use plucked arrays: PieChart(data.categories, data.values)",
    RadialChart: "; use plucked arrays: RadialChart(data.categories, data.values)",
    SingleStackedBarChart:
      "; use plucked arrays: SingleStackedBarChart(data.categories, data.values)",
    SnippetCardBlock: "; optionally clickable with a shared action.",
    OverviewCardBlock: "; optionally clickable with a shared action.",
    ContextCardBlock: "; an optional action makes every card clickable.",
    CompositeCardBlock: "; an optional action makes every card clickable.",
    VisualCardBlock: "; an optional action makes every card clickable.",
  };
  const projected = description.replace(removals[name] ?? "", "");
  return name === "CompositeCardBlock" || name === "CompositeCardItem"
    ? projected.replace("price/button", "price")
    : projected;
}

function containsBlockedImageReference(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsBlockedImageReference);
  if (typeof value !== "object" || value === null) return false;
  const node = value as Partial<ElementNode>;
  if (node.type === "element" && node.props) {
    const props = node.props;
    let sources: unknown[] = [];
    switch (node.typeName) {
      case "Image":
      case "ImageBlock":
      case "ImageText":
      case "ImageTextLarge":
        sources = [props.src];
        break;
      case "ContextCardItem":
      case "VisualCardItem":
        sources = [props.bgImageSrc];
        break;
      case "ImageGallery":
        sources = Array.isArray(props.images)
          ? props.images.map((image: { src?: unknown }) => image.src)
          : [];
        break;
      case "ListItem":
        sources = [(props.image as { src?: unknown } | undefined)?.src];
        break;
    }
    if (sources.some((source) => typeof source === "string" && !/^data:/i.test(source)))
      return true;
  }
  return Object.values(value).some(containsBlockedImageReference);
}

function containsDynamicValue(value: unknown): boolean {
  if (isASTNode(value)) return true;
  if (Array.isArray(value)) return value.some(containsDynamicValue);
  if (typeof value !== "object" || value === null) return false;
  if ((value as { hasDynamicProps?: boolean }).hasDynamicProps) return true;
  return Object.values(value).some(containsDynamicValue);
}
