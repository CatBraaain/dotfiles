import { lstatSync, realpathSync } from "node:fs";
import { win32 } from "node:path";

type DrivePath = {
  spelling: string;
  verifiedThrough: number;
  state: "existing" | "missing" | "unverified";
  directory?: boolean;
};

export type PathCoverage = "match" | "possible" | "none";

type PathLookupFs = {
  lstat(path: string): { isSymbolicLink(): boolean; isDirectory(): boolean };
  realpath(path: string): string;
};

export function isDrivePath(path: string): boolean {
  return /^[a-z]:[/\\]/i.test(path);
}

export class WindowsPathLookup {
  private readonly prefixes = new Map<string, DrivePath>();

  constructor(
    private readonly fs: PathLookupFs = { lstat: lstatSync, realpath: realpathSync.native },
  ) {}

  inspect(path: string): DrivePath {
    const spelling = portableDrivePath(path);
    const parts = spelling.split("/");
    const [drive, ...names] = parts;
    const root = `${drive}/`;
    let prefix = this.inspectPrefix(root);
    let inputPrefix = root;
    for (const name of names) {
      if (name === "") continue;
      inputPrefix = appendName(inputPrefix, name);
      if (prefix.state === "existing" && prefix.directory) {
        prefix = this.inspectPrefix(inputPrefix, prefix.spelling, name);
      } else {
        prefix = {
          ...prefix,
          spelling: appendName(prefix.spelling, name),
          state: prefix.state === "missing" && isOrdinaryName(name) ? "missing" : "unverified",
        };
      }
    }
    return prefix;
  }

  couldCover(path: string, candidate: DrivePath): boolean {
    const ruleParts = portableDrivePath(path).split("/").filter(Boolean);
    const candidateParts = candidate.spelling.split("/").filter(Boolean);
    return (
      ruleParts.length <= candidateParts.length &&
      ruleParts.every((part, index) => couldBeCaseVariant(part, candidateParts[index]!))
    );
  }

  coverage(rule: DrivePath, candidate: DrivePath): PathCoverage {
    const ruleParts = rule.spelling.split("/").filter(Boolean);
    const candidateParts = candidate.spelling.split("/").filter(Boolean);
    if (ruleParts.length > candidateParts.length) return "none";

    let possible = rule.state === "unverified" || candidate.state === "unverified";
    for (const [index, rulePart] of ruleParts.entries()) {
      const candidatePart = candidateParts[index]!;
      if (rulePart === candidatePart) continue;
      if (index < Math.min(rule.verifiedThrough, candidate.verifiedThrough)) return "none";
      const ruleIsMissing = index >= rule.verifiedThrough && rule.state === "missing";
      const candidateIsMissing =
        index >= candidate.verifiedThrough && candidate.state === "missing";
      if (
        (ruleIsMissing && index < candidate.verifiedThrough) ||
        (candidateIsMissing && index < rule.verifiedThrough)
      )
        return "none";
      if (!couldBeCaseVariant(rulePart, candidatePart)) return "none";
      possible = true;
    }
    return possible ? "possible" : "match";
  }

  private inspectPrefix(path: string, parent?: string, name?: string): DrivePath {
    const cached = this.prefixes.get(path);
    if (cached) return cached;
    const spelling = parent === undefined ? path : appendName(parent, name!);
    const verifiedThrough = parent?.split("/").filter(Boolean).length ?? 0;
    const inspected = this.readPrefix(path, spelling, verifiedThrough, parent);
    this.prefixes.set(path, inspected);
    return inspected;
  }

  private readPrefix(
    input: string,
    spelling: string,
    verifiedThrough: number,
    parent: string | undefined,
  ): DrivePath {
    const unverified: DrivePath = { spelling, verifiedThrough, state: "unverified" };
    if (!isOrdinaryName(win32.basename(spelling)) && parent !== undefined) return unverified;

    let stats;
    try {
      stats = this.fs.lstat(input);
      if (stats.isSymbolicLink()) return unverified;
    } catch (error) {
      if (parent !== undefined && (error as NodeJS.ErrnoException).code === "ENOENT")
        return { spelling, verifiedThrough, state: "missing" };
      return unverified;
    }

    try {
      const realPath = this.fs.realpath(input);
      if (!isDrivePath(realPath)) return unverified;
      const canonical = portableDrivePath(realPath);
      const canonicalParent = portableDrivePath(win32.dirname(canonical));
      if (
        (parent !== undefined && canonicalParent !== parent) ||
        canonical.length !== spelling.length ||
        canonical.toUpperCase() !== spelling.toUpperCase()
      )
        return unverified;
      return {
        spelling: canonical,
        verifiedThrough: verifiedThrough + 1,
        state: "existing",
        directory: stats.isDirectory(),
      };
    } catch {
      return unverified;
    }
  }
}

function portableDrivePath(path: string): string {
  const normalized = win32.normalize(path).replaceAll("\\", "/");
  const withDrive = normalized[0]!.toUpperCase() + normalized.slice(1);
  return withDrive.length === 3 ? withDrive : withDrive.replace(/\/$/, "");
}

function appendName(parent: string, name: string): string {
  return `${parent}${parent.endsWith("/") ? "" : "/"}${name}`;
}

function isOrdinaryName(name: string): boolean {
  return (
    !/[<>:"|?*\ufffd]|[ .]$/.test(name) &&
    !Array.from(name).some((character) => character.charCodeAt(0) < 32) &&
    !/^(?:CON|CONIN\$|CONOUT\$|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]) *(?:\.|$)/i.test(name)
  );
}

function couldBeCaseVariant(left: string, right: string): boolean {
  const ascii = /^[ -~]*$/;
  return !ascii.test(left) || !ascii.test(right) || left.toUpperCase() === right.toUpperCase();
}
