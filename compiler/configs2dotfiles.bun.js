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

const dotsSrc = "src/configs";
const dotsDist = "dist/dotfiles";

await $`rm -rf ${dotsDist}`;
await $`mkdir -p ${dotsDist}`;

map.forEach(async (item) => {
  await $`mkdir -p ${dotsDist}`;
  const srcPath = `${dotsSrc}/${item.src}`;
  const distPath = `${dotsDist}/${item.dist}`;
  await $`cp -R ${srcPath} ${distPath}`;
});

const scriptsDir = `${dotsSrc}/.scripts`;
const scripts = await readdir(scriptsDir);
scripts.forEach(async (script) => {
  await $`bun ${scriptsDir}/${script}`;
});
