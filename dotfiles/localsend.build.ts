import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

const settingsPaths = [
  ".local/share/org.localsend.localsend_app/shared_preferences.json",
  "AppData/Roaming/LocalSend/settings.json",
];
const jsonTokens = /"(?:\\.|[^"\\])*"|[ \t\r\n]+/g;

export default async function ({
  resolvePaths,
}: {
  resolvePaths(path: string): { distPath: string };
}): Promise<void> {
  for (const settingsPath of settingsPaths) {
    const { distPath } = resolvePaths(settingsPath);
    if (!existsSync(distPath)) continue;

    const completedSettings = await readFile(distPath, "utf8");
    JSON.parse(completedSettings);
    await writeFile(
      distPath,
      completedSettings.replace(jsonTokens, (token) => (token.startsWith('"') ? token : "")),
    );
  }
}
