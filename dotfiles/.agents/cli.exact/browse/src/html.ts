// Shared HTML/XML text helpers used by the Reddit and StackOverflow parsers.

export function unescapeEntities(text: string): string {
  let previous = "";
  let current = text;
  while (current !== previous) {
    previous = current;
    current = current
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&apos;/gi, "'")
      .replace(/&(?:#x([0-9a-f]+)|#(\d+));/gi, (_, hex, dec) =>
        String.fromCodePoint(Number.parseInt(hex ?? dec, hex ? 16 : 10)),
      );
  }
  return current;
}

export function htmlFragmentToMarkdown(fragment: string): string {
  let text = fragment.replace(/<!--[\s\S]*?-->/g, "");
  text = text.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, inner) => {
    const quoted = htmlFragmentToMarkdown(inner).replace(/^/gm, "> ");
    return `\n\n${quoted}\n\n`;
  });
  text = text
    .replace(
      /<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
      (_, href, label) => `[${label.trim()}](${href})`,
    )
    .replace(/<img\b[^>]*src="([^"]*)"[^>]*>/gi, (_, src) => `![](${src})`)
    .replace(/<(?:strong|b)\b[^>]*>/gi, "**")
    .replace(/<\/(?:strong|b)>/gi, "**")
    .replace(/<(?:em|i)\b[^>]*>/gi, "*")
    .replace(/<\/(?:em|i)>/gi, "*")
    .replace(/<(?:del|s|strike)\b[^>]*>/gi, "~~")
    .replace(/<\/(?:del|s|strike)>/gi, "~~")
    .replace(/<(?:code|kbd)\b[^>]*>/gi, "`")
    .replace(/<\/(?:code|kbd)>/gi, "`")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<hr\s*\/?>/gi, "\n---\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<\/(li|p|div|h[1-6]|ul|ol|pre|tr)>/gi, "\n\n")
    .replace(/<[^>]*>/g, "");
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function atomText(entryXml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(entryXml);
  return match?.[1]?.trim() || undefined;
}

