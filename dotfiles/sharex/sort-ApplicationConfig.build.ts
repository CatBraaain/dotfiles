import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

const rawJson = JSON as typeof JSON & {
  rawJSON(source: string): unknown;
  isRawJSON(value: unknown): boolean;
};

export default async function ({
  resolvePaths,
}: {
  resolvePaths(path: string): { distPath: string; homePath: string };
}): Promise<void> {
  const { distPath, homePath } = resolvePaths("ApplicationConfig.json");
  if (!existsSync(distPath) || !existsSync(homePath)) return;

  const [distContent, homeContent] = await Promise.all([
    readFile(distPath, "utf8"),
    readFile(homePath, "utf8"),
  ]);
  const distSettings = parseSettings(distContent);
  const homeSettings = parseSettings(homeContent);

  await writeFile(distPath, `${JSON.stringify(orderTopLevelKeys(distSettings, homeSettings), null, 2)}\n`);
}

function parseSettings(content: string): Record<string, unknown> {
  const parsed: unknown = content.trim()
    ? JSON.parse(content, (_key, value: unknown, context?: { source: string }) =>
        typeof value === "number" ? rawJson.rawJSON(context!.source) : value,
      )
    : {};
  if (!isObject(parsed)) {
    throw new Error("ApplicationConfig.json: top level must be an object");
  }
  return parsed;
}

// ShareX rewrites the whole settings file in its class member declaration
// order on every save, while the merge layer appends keys unknown to home at
// the end. Keep the dist keys in the home file's order (the order ShareX last
// wrote) so key ordering never becomes a diff. Keys that do not exist in home
// yet keep their dist order at the end and settle into ShareX's own order on
// the next save-apply round.
function orderTopLevelKeys(
  distSettings: Record<string, unknown>,
  homeSettings: Record<string, unknown>,
): Record<string, unknown> {
  const known = Object.keys(homeSettings).filter((key) => Object.hasOwn(distSettings, key));
  const rest = Object.keys(distSettings).filter((key) => !Object.hasOwn(homeSettings, key));
  const ordered: Record<string, unknown> = {};
  for (const key of [...known, ...rest]) ordered[key] = distSettings[key];
  return ordered;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !rawJson.isRawJSON(value)
  );
}
