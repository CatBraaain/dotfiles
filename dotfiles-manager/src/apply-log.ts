import { fstatSync } from "node:fs";
import { resolve } from "node:path";

const labelWidth = 28;
const bodyIndent = Buffer.from("      ");

export type HookOutputChannel = "stdout" | "stderr";

export function writeTimedRow(label: string, seconds: string): void {
  console.log(timedRow(label, seconds));
}

function timedRow(label: string, seconds: string): string {
  return `    ${label.padEnd(labelWidth)}  ${seconds}s`;
}

export function writeOutcome(label: string, succeeded: boolean, seconds: string): void {
  console.log(`${succeeded ? "✓" : "✗"} ${label}  ${seconds}s`);
}

export function formatCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `${count} ${label}`)
    .join(" · ");
}

export class ApplyHookLog {
  private labels = new Map<string, string>();
  private pathsWithOutput = new Set<string>();
  private activePath?: string;
  private activePerChannel: Partial<Record<HookOutputChannel, string>> = {};
  private pending = Promise.resolve();
  private readonly sharesOutputDestination = sharesOutputDestination();

  constructor(private readonly distRoot: string) {}

  begin(paths: readonly string[]): void {
    if (paths.length === 0) return;
    const shortPaths = paths.map((path) =>
      path.replace(
        /\.(?:(linux|macos|windows|machine)-)?(?:post)?(?:build|apply)\.ts$/,
        (_, modifier?: string) => (modifier ? "." + modifier : ""),
      ),
    );
    const labels = shortPaths.map(
      (path, index) =>
        shortestUniqueSuffix(
          path,
          shortPaths.filter((_, otherIndex) => otherIndex !== index),
        ) ?? paths[index]!,
    );
    if (new Set(labels).size !== labels.length) {
      this.labels = new Map(paths.map((path) => [path, path]));
    } else {
      this.labels = new Map(paths.map((path, index) => [path, labels[index]!]));
    }
    this.pathsWithOutput.clear();
    this.activePath = undefined;
    this.activePerChannel = {};
    console.log("  Hooks");
  }

  writeLine(path: string, channel: HookOutputChannel, line: Uint8Array): Promise<void> {
    return this.enqueue(async () => {
      this.pathsWithOutput.add(path);
      await this.writeNested(path, channel, line);
    });
  }

  finish(path: string, succeeded: boolean, seconds: string): Promise<void> {
    return this.enqueue(async () => {
      const label = this.labels.get(path) ?? path;
      const absolutePath = succeeded ? undefined : resolve(this.distRoot, path);
      if (this.pathsWithOutput.has(path)) {
        const outcome = absolutePath
          ? `✗ Failed  ${seconds}s  ${absolutePath}`
          : `complete  ${seconds}s`;
        await this.writeNested(path, "stdout", Buffer.from(`${outcome}\n`));
        return;
      }
      const outcome = absolutePath
        ? `${timedRow(`✗ ${absolutePath}`, seconds)}  Failed`
        : timedRow(label, seconds);
      this.activePath = undefined;
      delete this.activePerChannel.stdout;
      await Bun.write(Bun.stdout, `${outcome}\n`);
    });
  }

  private enqueue(write: () => Promise<void>): Promise<void> {
    const result = this.pending.then(write);
    this.pending = result.catch(() => undefined);
    return result;
  }

  private async writeNested(
    path: string,
    channel: HookOutputChannel,
    line: Uint8Array,
  ): Promise<void> {
    const needsHeading =
      this.activePath !== path ||
      (!this.sharesOutputDestination && this.activePerChannel[channel] !== path);
    const label = this.labels.get(path) ?? path;
    const parts = needsHeading
      ? [Buffer.from(`    ${label}\n`), bodyIndent, line]
      : [bodyIndent, line];
    await Bun.write(channel === "stdout" ? Bun.stdout : Bun.stderr, Buffer.concat(parts));
    this.activePath = path;
    this.activePerChannel[channel] = path;
  }
}

function sharesOutputDestination(): boolean {
  try {
    const stdout = fstatSync(process.stdout.fd, { bigint: true });
    const stderr = fstatSync(process.stderr.fd, { bigint: true });
    return stdout.ino !== 0n && stdout.ino === stderr.ino && stdout.dev === stderr.dev;
  } catch {
    return false;
  }
}

function shortestUniqueSuffix(path: string, others: string[]): string | undefined {
  const parts = path.split("/");
  for (let start = parts.length - 1; start >= 0; start--) {
    const suffix = parts.slice(start).join("/");
    if (suffix && !others.some((other) => other === suffix || other.endsWith(`/${suffix}`))) {
      return suffix;
    }
  }
  return undefined;
}
