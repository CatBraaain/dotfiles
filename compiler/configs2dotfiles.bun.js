import { $ } from "bun";
import { readdir } from "node:fs/promises";

const map = [
  { src: "obs-studio", dist: "AppData/Roaming/obs-studio" },
  { src: "mise", dist: "dot_config/mise" },
  { src: "sharex", dist: "Documents/ShareX" },
  { src: ".gitconfig", dist: "dot_gitconfig" },
  { src: ".nirc", dist: "dot_nirc" },
  { src: ".wslconfig", dist: "dot_wslconfig" },
  { src: ".chezmoiexternal.yaml", dist: ".chezmoiexternal.yaml" },
];

const dotfilesSrc = "src/dotfiles";
const dotfilesDist = "dist/dotfiles";

await $`rm -rf ${dotfilesDist}`;
await $`mkdir -p ${dotfilesDist}`;

map.forEach(async (item) => {
  await $`mkdir -p ${dotfilesDist}`;
  const srcPath = `${dotfilesSrc}/${item.src}`;
  const distPath = `${dotfilesDist}/${item.dist}`;
  await $`cp -R ${srcPath} ${distPath}`;
});

const scriptsDir = `${dotfilesSrc}/.scripts`;
const scripts = await readdir(scriptsDir);
scripts.forEach(async (script) => {
  await $`bun ${scriptsDir}/${script}`;
});
