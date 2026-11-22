import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export class WorkspaceStore {
  constructor(private readonly directory: string) {}

  async list(): Promise<Set<string>> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
      throw error;
    }
    const cwds = await Promise.all(
      names
        .filter((name) => /^[a-f0-9]{64}\.cwd$/.test(name))
        .map(async (name) => {
          let cwd: string;
          try {
            cwd = await readFile(join(this.directory, name), "utf8");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
            throw error;
          }
          if (!isAbsolute(cwd) || workspaceFileName(cwd) !== name) {
            throw new Error(`Invalid stored workspace: ${join(this.directory, name)}`);
          }
          return cwd;
        }),
    );
    return new Set(cwds.filter((cwd) => cwd !== undefined));
  }

  async add(cwd: string): Promise<void> {
    if (!isAbsolute(cwd)) throw new Error(`Invalid workspace path: ${cwd}`);
    await mkdir(this.directory, { recursive: true });
    const temporary = join(this.directory, `${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, cwd, { flag: "wx", mode: 0o600 });
      await rename(temporary, join(this.directory, workspaceFileName(cwd)));
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async remove(cwd: string): Promise<void> {
    await rm(join(this.directory, workspaceFileName(cwd)), { force: true });
  }
}

function workspaceFileName(cwd: string): string {
  return `${createHash("sha256").update(cwd).digest("hex")}.cwd`;
}
