import { spawn } from "node:child_process";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";

// Copy this reporter into the test project and add it alongside the existing reporter.
// It converts only the WebM files that Playwright attached to the selected run.
export default class RecordingReporter implements Reporter {
  private recordings = new Map<string, { title: string; input: string; output: string }>();

  onTestEnd(test: TestCase, result: TestResult): void {
    // Keep one recording per test: the first page of the last recorded attempt.
    const attachment = result.attachments.find(
      (item) => item.name === "video" && item.path && extname(item.path) === ".webm",
    );
    if (!attachment?.path) {
      this.recordings.delete(test.id);
      return;
    }
    this.recordings.set(test.id, {
      title: test.titlePath().slice(3).join(" › ") || test.title,
      input: attachment.path,
      output: attachment.path.slice(0, -5) + ".mp4",
    });
  }

  async onEnd(): Promise<void> {
    for (const { title, input, output } of this.recordings.values()) {
      try {
        await convertVideo(input, output, title);
        console.log(`[e2e-recording] ${title}: ${output}`);
      } catch (error) {
        await unlink(output).catch(() => {});
        // Conversion failures must not alter the test result. Surface the missing artifact.
        console.error(`[e2e-recording] Could not convert ${input}:`, error);
      }
    }
  }
}

async function convertVideo(input: string, output: string, title: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "e2e-recording-"));
  try {
    const titleLines = title.replace(/\s+/g, " ").match(/.{1,36}(?=\s|$)|\S{1,36}/gu) ?? [title];
    const headerHeight = titleLines.length * 24 + 36;
    const titleFilters = await Promise.all(
      titleLines.map(async (line, index) => {
        const titleFile = join(directory, `title-${index}.txt`);
        // Textfiles keep test titles literal, including ffmpeg's filter and expansion syntax.
        await writeFile(titleFile, line, "utf8");
        // Filter option values pass through both the filtergraph and drawtext parsers.
        const escapedTitleFile = titleFile.replace(/[\\':,;[\]]/g, (char) => "\\".repeat(3) + char);
        return `drawtext=textfile=${escapedTitleFile}:expansion=none:fontcolor=white:fontsize=18:x=12:y=${8 + index * 24}`;
      }),
    );
    const filter = [
      `pad=ceil(iw/2)*2:ceil((ih+${headerHeight})/2)*2:0:${headerHeight}:color=0x202020`,
      ...titleFilters,
      `drawtext=text='%{pts\\:hms}':fontcolor=white:fontsize=18:x=w-tw-12:y=${headerHeight - 28}`,
    ].join(",");
    await new Promise<void>((resolve, reject) => {
      const ffmpeg = spawn(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-i",
          input,
          "-an",
          "-vf",
          filter,
          "-c:v",
          "libx264",
          "-crf",
          "23",
          "-pix_fmt",
          "yuv420p",
          "-movflags",
          "+faststart",
          output,
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      let stderr = "";
      ffmpeg.stderr.setEncoding("utf8");
      ffmpeg.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      ffmpeg.on("error", reject);
      ffmpeg.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited with ${code}: ${stderr}`));
      });
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
