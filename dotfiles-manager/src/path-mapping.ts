// Dist-to-home path mapping shared by diff detection, apply, and home-path
// resolution (spec: SPEC.md §差分検知 の対応関係).

export type EntryKind = "file" | "directory" | "symlink";
export type Platform = "windows" | "linux" | "darwin";

const excludedEntryPrefixes = [".build"];

export function currentPlatform(): Platform {
  return process.platform === "win32"
    ? "windows"
    : process.platform === "darwin"
      ? "darwin"
      : "linux";
}

const buildHookNamePattern = /\.(?:(?:linux|macos|windows|machine)-)?(?:post)?build\.[^.]+$/;
const applyScriptNamePattern = /\.(?:(?:linux|macos|windows|machine)-)?(?:post)?apply\.[^.]+$/;
const postHookNamePattern = /\.(?:(?:linux|macos|windows|machine)-)?post(?:build|apply)\.[^.]+$/;
// The OS modifier only applies when it matches the current platform
// (spec: SPEC.md §フックシステム); callers filter by the current platform.
const hookPlatformPattern = /\.(linux|macos|windows)-(?:post)?(?:build|apply)\.[^.]+$/;

export function hookPlatform(name: string): Platform | undefined {
  const modifier = hookPlatformPattern.exec(name)?.[1];
  if (modifier === "macos") return "darwin";
  if (modifier === "linux" || modifier === "windows") return modifier;
  return undefined;
}

export function isApplyScriptName(name: string): boolean {
  return applyScriptNamePattern.test(name);
}

export function isBuildHookName(name: string): boolean {
  return buildHookNamePattern.test(name);
}

export function isPostHookName(name: string): boolean {
  return postHookNamePattern.test(name);
}

export type SegmentMapping = {
  homeName: string;
  kind: EntryKind;
  isExactManaged: boolean;
  isExecutable: boolean;
  isExcluded: boolean;
};

const externalDataNamePattern = /^external\.(?:(?:linux|macos|windows|machine)-)?data\.yaml$/;

export function mapSegment(name: string, isDirectory: boolean): SegmentMapping {
  // .data. marks build-time data files (path map, external config, machine
  // layer), excluded like the .build prefix (spec §差分検知).
  const isExcluded =
    excludedEntryPrefixes.some((prefix) => name.startsWith(prefix)) ||
    name.includes(".data.") ||
    externalDataNamePattern.test(name) ||
    (!isDirectory && (isApplyScriptName(name) || isBuildHookName(name)));
  if (isExcluded)
    return {
      homeName: name,
      kind: isDirectory ? "directory" : "file",
      isExactManaged: false,
      isExecutable: false,
      isExcluded: true,
    };

  if (isDirectory && name.endsWith(".exact"))
    return {
      homeName: name.slice(0, -".exact".length),
      kind: "directory",
      isExactManaged: true,
      isExecutable: false,
      isExcluded: false,
    };
  if (!isDirectory && name.endsWith(".executable"))
    return {
      homeName: name.slice(0, -".executable".length),
      kind: "file",
      isExactManaged: false,
      isExecutable: true,
      isExcluded: false,
    };
  if (!isDirectory && name.endsWith(".symlink"))
    return {
      homeName: name.slice(0, -".symlink".length),
      kind: "symlink",
      isExactManaged: false,
      isExecutable: false,
      isExcluded: false,
    };

  return {
    homeName: name,
    kind: isDirectory ? "directory" : "file",
    isExactManaged: false,
    isExecutable: false,
    isExcluded: false,
  };
}
