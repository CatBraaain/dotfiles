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
  const { distPath, homePath } = resolvePaths("HotkeysConfig.json");
  if (!existsSync(homePath)) return;

  const content = await readFile(homePath, "utf8");
  const parsed: unknown = content.trim()
    ? JSON.parse(content, (_key, value: unknown, context?: { source: string }) =>
        typeof value === "number" ? rawJson.rawJSON(context!.source) : value,
      )
    : {};
  const settings = isObject(parsed) ? parsed : {};

  if (Object.hasOwn(settings, "Hotkeys")) {
    if (!Array.isArray(settings.Hotkeys)) {
      throw new Error("HotkeysConfig.json: Hotkeys must be an array");
    }
    for (const hotkey of settings.Hotkeys) {
      if (!isObject(hotkey) || !Object.hasOwn(hotkey, "TaskSettings")) continue;
      const task = hotkey.TaskSettings;
      if (!isObject(task)) continue;

      if (
        Object.hasOwn(task, "AfterCaptureJob") &&
        task.AfterCaptureJob === "CopyImageToClipboard, SaveImageToFile, UploadImageToHost"
      ) {
        task.AfterCaptureJob = "CopyImageToClipboard, SaveImageToFile";
      }
      if (Object.hasOwn(task, "AfterUploadJob") && task.AfterUploadJob === "CopyURLToClipboard") {
        task.AfterUploadJob = "None";
      }

      if (!Object.hasOwn(hotkey, "HotkeyInfo") || !isObject(hotkey.HotkeyInfo)) continue;
      const info = hotkey.HotkeyInfo;
      if (
        Object.hasOwn(info, "Hotkey") &&
        info.Hotkey === "PrintScreen" &&
        Object.hasOwn(task, "Job") &&
        (task.Job === "RectangleRegion" ||
          task.Job === "ScreenRecorder" ||
          task.Job === "ScreenRecorderGIF" ||
          task.Job === "PrintScreen")
      ) {
        info.Hotkey = "None";
      }
    }
  }

  await writeFile(distPath, `${JSON.stringify(settings, null, 2)}\n`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !rawJson.isRawJSON(value)
  );
}
