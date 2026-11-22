import { join } from "node:path";

const installProfiles = ["dev", "work", "personal"] as const;
export type InstallProfile = (typeof installProfiles)[number];

export const markingPath = join(import.meta.dir, "..", "..", ".env");

export function isInstallProfile(value: string): value is InstallProfile {
  return installProfiles.some((profile) => profile === value);
}

export async function readInstallProfile(readText: () => Promise<string>): Promise<InstallProfile> {
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
      `unknown INSTALL_PROFILE "${value}" in ${markingPath} (expected one of: ${installProfiles.join(", ")})`,
    );
  return value;
}
