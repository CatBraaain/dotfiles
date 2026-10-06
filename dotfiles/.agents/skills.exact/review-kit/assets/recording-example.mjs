import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadRecordingOverlay } from "./load-overlay.mjs";

export async function recordWithExternalTitle(page, scenario) {
  const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
  const titleHeight = scenario.titleHeight ?? 64;
  const outputDir = scenario.outputDir;
  await mkdir(outputDir, { recursive: true });
  const timeline = [
    {
      at: Date.now(),
      current: scenario.current ?? 1,
      read: scenario.read ?? 0,
    },
  ];
  const frames = [];
  const overlay = await loadRecordingOverlay(page, {
    title: scenario.title,
    steps: scenario.steps,
    current: scenario.current ?? 1,
    read: scenario.read ?? 0,
    phase: "waiting",
    theme: scenario.theme,
    layer: "page",
    pageArea: { x: 0, y: 0, width: viewport.width, height: viewport.height },
    titleArea: { x: 0, y: 0, width: viewport.width, height: titleHeight },
  });
  const handle = {
    update: async (patch) => {
      const layout = await overlay.update(patch);
      const last = timeline.at(-1);
      timeline.push({
        at: Date.now(),
        current: patch.current ?? last?.current ?? 1,
        read: patch.read ?? last?.read ?? 0,
      });
      return layout;
    },
    inspect: () => overlay.inspect(),
    painted: () => overlay.painted(),
    setVisible: (visible) => overlay.setVisible(visible),
    dispose: () => overlay.dispose(),
  };
  let captureError = "";
  const captureStartedAt = Date.now();
  await page.screencast.start({
    quality: scenario.screencastQuality ?? 95,
    size: { width: viewport.width, height: viewport.height },
    onFrame: (frame) => {
      frames.push({ data: frame.data, timestamp: frame.timestamp });
    },
  });
  let failure = "";
  let captureStoppedAt = captureStartedAt;
  try {
    await scenario.run(handle);
  } catch (error) {
    failure = String(error);
  } finally {
    try {
      await page.screencast.stop();
    } catch (error) {
      captureError = String(error);
    }
    captureStoppedAt = Date.now();
  }
  if (!frames.length) throw new Error(`No screencast frames were captured. ${captureError}`);
  if (failure) throw new Error(failure);

  const offset = scenario.frameClockOffsetMs ?? 0;
  const ordered = frames
    .map((frame) => ({ ...frame, timestamp: frame.timestamp + offset }))
    .toSorted((a, b) => a.timestamp - b.timestamp);
  const titleStates = [
    ...new Map(timeline.map((entry) => [`${entry.current}:${entry.read}`, entry])).values(),
  ].toSorted((a, b) => a.at - b.at);
  const firstTitleState = titleStates[0];
  if (!firstTitleState) throw new Error("No title states were recorded");
  const titleFiles = [];
  for (const state of titleStates) {
    const name = `title-${state.current}-${state.read}.png`;
    await renderTitleStrip(page.context(), {
      ...scenario,
      output: join(outputDir, name),
      titleHeight,
      width: viewport.width,
      current: state.current,
      read: state.read,
    });
    titleFiles.push({ name, state });
  }
  const firstAt = ordered[0].timestamp;
  // The screencast only delivers frames on change, so hold the last frame (and
  // its title state) until the capture actually stopped.
  const lastFrameHoldMs = Math.max(captureStoppedAt - ordered.at(-1).timestamp, 1000 / 60);
  const durations = ordered.map((frame, index) =>
    index + 1 < ordered.length ? ordered[index + 1].timestamp - frame.timestamp : lastFrameHoldMs,
  );
  if (durations.some((duration) => duration <= 0))
    throw new Error("Screencast timestamps are not monotonic; adjust frameClockOffsetMs");
  const lastFrame = ordered.at(-1);
  if (!lastFrame) throw new Error("Screencast produced no usable frames");
  const durationSeconds = Math.max((captureStoppedAt - firstAt) / 1000, 0);
  const sourceConcat = ["ffconcat version 1.0"];
  const titleConcat = ["ffconcat version 1.0"];
  const mapping = ordered.map((frame, index) => {
    const pageAt = frame.timestamp;
    const state = titleStates.reduce(
      (current, entry) => (entry.at <= pageAt ? entry : current),
      firstTitleState,
    );
    const duration = durations[index] / 1000;
    const file = `frame-${String(index).padStart(6, "0")}.jpg`;
    const timing = ["option framerate 1000", `duration ${duration.toFixed(6)}`];
    sourceConcat.push(`file '${file}'`, ...timing);
    titleConcat.push(`file 'title-${state.current}-${state.read}.png'`, ...timing);
    return file;
  });
  sourceConcat.push(
    `file 'frame-${String(ordered.length - 1).padStart(6, "0")}.jpg'`,
    "option framerate 1000",
  );
  titleConcat.push(
    `file 'title-${titleStates.at(-1)?.current ?? 1}-${titleStates.at(-1)?.read ?? 0}.png'`,
    "option framerate 1000",
  );
  await writeFile(join(outputDir, "source.ffconcat"), `${sourceConcat.join("\n")}\n`);
  await writeFile(join(outputDir, "titles.ffconcat"), `${titleConcat.join("\n")}\n`);
  for (const [index, frame] of ordered.entries())
    await writeFile(join(outputDir, mapping[index]), frame.data);
  await runFFmpeg(scenario.ffmpegPath ?? "ffmpeg", outputDir, durationSeconds);
  return {
    mp4: join(outputDir, "recording.mp4"),
    frames: ordered.length,
    titleStates: titleFiles.length,
    durationSeconds,
  };
}

async function renderTitleStrip(context, scenario) {
  const page = await context.newPage();
  try {
    await page.setViewportSize({
      width: scenario.width,
      height: scenario.titleHeight + 2,
    });
    await loadRecordingOverlay(page, {
      title: scenario.title,
      steps: scenario.steps,
      current: scenario.current,
      read: scenario.read,
      phase: "waiting",
      theme: scenario.theme,
      layer: "title",
      pageArea: {
        x: 0,
        y: scenario.titleHeight,
        width: scenario.width,
        height: 2,
      },
      titleArea: {
        x: 0,
        y: 0,
        width: scenario.width,
        height: scenario.titleHeight,
      },
    });
    await page.screenshot({
      path: scenario.output,
      clip: { x: 0, y: 0, width: scenario.width, height: scenario.titleHeight },
    });
  } finally {
    await page.close();
  }
}

function runFFmpeg(executable, cwd, durationSeconds) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      executable,
      [
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        "titles.ffconcat",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        "source.ffconcat",
        "-filter_complex",
        "[0:v][1:v]vstack=inputs=2,fps=60,format=yuv420p[v]",
        "-map",
        "[v]",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "18",
        "-movflags",
        "+faststart",
        "-t",
        String(durationSeconds),
        "recording.mp4",
      ],
      { cwd, stdio: ["ignore", "ignore", "pipe"] },
    );
    let text = "";
    child.stderr.on("data", (chunk) => {
      text += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(undefined);
      else reject(new Error(`ffmpeg exited ${code}: ${text.slice(-2000)}`));
    });
  });
}
