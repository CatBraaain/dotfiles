import { join } from "node:path";

export type InstallProfile = "personal" | "work";

export const markingPath = join(import.meta.dir, "..", "..", ".env");

export function isInstallProfile(value: string): value is InstallProfile {
  return value === "personal" || value === "work";
}

export async function readInstallProfile(
  readText: () => Promise<string>,
): Promise<InstallProfile> {
  let text: string;
  try {
    text = await readText();
  } catch {
    throw new Error(
      `marking file is missing: ${markingPath}\ncopy .env.sample to ${markingPath} and set INSTALL_PROFILE`,
    );
  }
  const profileLine = text
    .split(/\r?\n/)
    .find((candidate) => candidate.trimStart().startsWith("INSTALL_PROFILE="));
  if (profileLine === undefined)
    throw new Error(
      `INSTALL_PROFILE is not defined in ${markingPath}\nadd e.g. "INSTALL_PROFILE=work"`,
    );
  const value = profileLine.slice(profileLine.indexOf("=") + 1).trim();
  if (!isInstallProfile(value))
    throw new Error(
      `unknown INSTALL_PROFILE "${value}" in ${markingPath} (expected "personal" or "work")`,
    );
  return value;
}
