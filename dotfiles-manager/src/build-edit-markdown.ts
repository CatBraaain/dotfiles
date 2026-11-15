import { fromMarkdown } from "mdast-util-from-markdown";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export type MarkdownEdit = {
  path: string;
  label: string;
  frontmatter?: Record<string, unknown>;
  sections?: Map<string, string>;
};
type Frontmatter = { bom: string; yaml?: string; body: string; prefix: string };
type Section = { name: string; depth: number; start: number; bodyStart: number; end: number };
type Replacement = { start: number; end: number; text: string };

export function normalizeMarkdownEdits(
  prefix: string,
  raw: unknown,
  sectionOrder = new Map<string, string[]>(),
): MarkdownEdit[] {
  requireMapping(raw, prefix);
  return Object.entries(raw).map(([path, fields]) => {
    const label = `${prefix}[${path}]`;
    requireMapping(fields, label);
    for (const field of Object.keys(fields)) {
      if (field !== "frontmatter" && field !== "sections") {
        throw new Error(`${label}.${field}: unknown field`);
      }
    }
    const edit: MarkdownEdit = { path, label };
    if (Object.hasOwn(fields, "frontmatter")) {
      requireMapping(fields.frontmatter, `${label}.frontmatter`);
      for (const [field, value] of Object.entries(fields.frontmatter)) {
        validateYamlValue(value, `${label}.frontmatter[${field}]`, new Set());
      }
      edit.frontmatter = fields.frontmatter;
    }
    if (Object.hasOwn(fields, "sections")) {
      requireMapping(fields.sections, `${label}.sections`);
      const sections = new Map<string, string>();
      for (const heading of sectionOrder.get(path) ?? Object.keys(fields.sections)) {
        const body = fields.sections[heading];
        const name = heading.trim();
        if (!name || /[\r\n]/.test(heading) || sections.has(name)) {
          throw new Error(`${label}.sections[${heading}]: empty, multiline, or duplicate heading`);
        }
        if (typeof body !== "string") {
          throw new Error(`${label}.sections[${heading}]: body must be a string`);
        }
        sections.set(name, body);
      }
      edit.sections = sections;
    }
    return edit;
  });
}

export function editMarkdown(source: string, edit: MarkdownEdit): string {
  const hasFields = Object.keys(edit.frontmatter ?? {}).length > 0;
  const hasSections = (edit.sections?.size ?? 0) > 0;
  if (!hasFields && !hasSections) return source;
  try {
    const frontmatter = splitFrontmatter(source);
    if (frontmatter.yaml !== undefined) {
      const header: unknown = parseYaml(frontmatter.yaml, { strict: true, uniqueKeys: true });
      requireMapping(header, "frontmatter");
    }
    const withFields = hasFields ? updateFrontmatter(frontmatter, edit.frontmatter!) : source;
    return hasSections ? updateSections(withFields, edit.sections!) : withFields;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const fields = [
      ...Object.keys(edit.frontmatter ?? {}).map((field) => `frontmatter[${field}]`),
      ...Array.from(edit.sections?.keys() ?? [], (heading) => `sections[${heading}]`),
    ].join(", ");
    throw new Error(`${edit.label} ${fields}: ${message}`, { cause: error });
  }
}

function splitFrontmatter(source: string): Frontmatter {
  const bom = source.startsWith("\uFEFF") ? "\uFEFF" : "";
  const content = source.slice(bom.length);
  const lines = content.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g)!;
  if (lines[0]?.replace(/[\r\n]+$/, "") !== "---") {
    return { bom, body: content, prefix: bom };
  }
  let offset = lines[0].length;
  for (const line of lines.slice(1)) {
    if (line.replace(/[\r\n]+$/, "") === "---") {
      const end = offset + line.length;
      return {
        bom,
        yaml: content.slice(lines[0].length, offset),
        body: content.slice(end),
        prefix: bom + content.slice(0, end),
      };
    }
    offset += line.length;
  }
  throw new Error("frontmatter: closing --- delimiter missing");
}

function updateFrontmatter(frontmatter: Frontmatter, fields: Record<string, unknown>): string {
  const header: Record<string, unknown> =
    frontmatter.yaml === undefined
      ? {}
      : parseYaml(frontmatter.yaml, { strict: true, uniqueKeys: true });
  const updated = { ...header, ...fields };
  return `${frontmatter.bom}---\n${stringifyYaml(updated)}---\n${frontmatter.body}`;
}

function updateSections(source: string, sections: Map<string, string>): string {
  const frontmatter = splitFrontmatter(source);
  const headings = readSections(frontmatter.body);
  const plans = Array.from(sections, ([name, body]) => {
    const matches = headings.filter((heading) => heading.name === name);
    if (matches.length > 1) throw new Error(`sections[${name}]: ambiguous heading`);
    const target = matches[0];
    const depth = target?.depth ?? 2;
    if (readSections(body).some((heading) => heading.depth <= depth)) {
      throw new Error(`sections[${name}]: body heading must be deeper than level ${depth}`);
    }
    const text = `\n${body.replace(/^[\r\n]+|[\r\n]+$/g, "")}\n`;
    return { name, target, text };
  });
  const targets = plans.flatMap(({ target }) => (target ? [target] : []));
  for (const target of targets) {
    const nested = targets.find(
      (other) => other !== target && other.start > target.start && other.start < target.end,
    );
    if (nested) throw new Error(`sections[${target.name}]: contains sections[${nested.name}]`);
  }
  const replacements: Replacement[] = plans.flatMap(({ target, text }) => {
    if (!target) return [];
    const headingNeedsLineFeed = frontmatter.body[target.bodyStart - 1] !== "\n";
    return [
      {
        start: target.bodyStart,
        end: target.end,
        text:
          (headingNeedsLineFeed ? "\n" : "") +
          text +
          (target.end < frontmatter.body.length ? "\n" : ""),
      },
    ];
  });
  let body = frontmatter.body;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    body = body.slice(0, replacement.start) + replacement.text + body.slice(replacement.end);
  }
  for (const plan of plans.filter(({ target }) => !target)) {
    const precedingBody = body.replace(/[\r\n]+$/, "");
    const hasOnlyFrontmatter = precedingBody === "" && frontmatter.yaml !== undefined;
    const separator = hasOnlyFrontmatter
      ? frontmatter.prefix.endsWith("\n")
        ? "\n"
        : "\n\n"
      : body === ""
        ? ""
        : "\n\n";
    body = precedingBody + separator + `## ${plan.name}\n${plan.text}`;
  }
  const updatedHeadings = readSections(body);
  for (const plan of plans) {
    const matches = updatedHeadings.filter((heading) => heading.name === plan.name);
    const target = matches[0];
    const expected = plan.text + (target && target.end < body.length ? "\n" : "");
    if (matches.length !== 1 || !target || body.slice(target.bodyStart, target.end) !== expected) {
      throw new Error(`sections[${plan.name}]: updated section boundary is not stable`);
    }
  }
  return frontmatter.prefix + body;
}

function readSections(body: string): Section[] {
  const headings = fromMarkdown(body).children.flatMap((node) => {
    if (node.type !== "heading") return [];
    const contentStart = node.children[0]?.position?.start.offset ?? node.position!.start.offset!;
    const start = Math.max(
      node.position!.start.offset!,
      body.lastIndexOf("\n", contentStart - 1) + 1,
      body.lastIndexOf("\r", contentStart - 1) + 1,
    );
    const headingEnd = node.position!.end.offset!;
    const raw = body.slice(start, headingEnd);
    const atx = /^ {0,3}#{1,6}(?:[\t ]+|$)(.*)$/.exec(raw);
    const name = atx
      ? atx[1]!.replace(/(?:^|[\t ]+)#+[\t ]*$/, "").trim()
      : raw.slice(0, Math.max(raw.lastIndexOf("\n"), raw.lastIndexOf("\r"))).trim();
    const newlineLength = body.startsWith("\r\n", headingEnd)
      ? 2
      : /^[\r\n]/.test(body.slice(headingEnd))
        ? 1
        : 0;
    return [{ name, depth: node.depth, start, bodyStart: headingEnd + newlineLength }];
  });
  return headings.map((heading, index) => ({
    ...heading,
    end:
      headings.slice(index + 1).find((next) => next.depth <= heading.depth)?.start ?? body.length,
  }));
}

function requireMapping(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error(`${label}: must be a mapping`);
  }
}

function validateYamlValue(value: unknown, label: string, ancestors: Set<unknown>): void {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return;
  if (typeof value !== "object") throw new Error(`${label}: unsupported YAML value type`);
  if (ancestors.has(value)) throw new Error(`${label}: cyclic YAML value`);
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const child of value) validateYamlValue(child, label, ancestors);
  } else {
    requireMapping(value, label);
    for (const child of Object.values(value)) validateYamlValue(child, label, ancestors);
  }
  ancestors.delete(value);
}
