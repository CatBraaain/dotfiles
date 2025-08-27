import { $ } from "bun";
import { readdir } from "node:fs/promises";

const map = [
  { src: "obs-studio", dist: "AppData/Roaming/obs-studio" },
  { src: "mise", dist: "dot_config/mise" },
  { src: "sharex", dist: "Documents/ShareX" },
];

const dotfilesSrc = "src/dotfiles";
const dotfilesDist = "dist/dotfiles";

await $`rm -rf ${dotfilesDist}`;
await $`cp -R ${dotfilesSrc} ${dotfilesDist}`;

map.forEach(async (item) => {
  await $`cp -R ${dotfilesDist}/${item.src} ${dotfilesDist}/${item.dist}`;
  await $`rm -rf ${dotfilesDist}/${item.src}`;
});
await $`rm -rf ${dotfilesDist}/.scripts`;

const scriptsDir = `${dotfilesSrc}/.scripts`;
const scripts = await readdir(scriptsDir);
scripts.forEach(async (script) => {
  await $`bun ${scriptsDir}/${script}`;
});
