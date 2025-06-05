import fs from "fs";
import { readdir } from "fs/promises";
import path from "path";

const map = [
  { src: "obs-studio", dist: "AppData/Roaming/obs-studio" },
  { src: "mise", dist: "dot_config/mise" },
  { src: "sharex", dist: "Documents/ShareX" },
  { src: ".gitconfig", dist: "dot_gitconfig" },
  { src: ".wslconfig", dist: "dot_wslconfig" },
  { src: ".chezmoiexternal.yaml", dist: ".chezmoiexternal.yaml" },
];

const dotSrc = "src/configs";
const dotDist = "dist/dotfiles";

map.forEach(({ src, dist }) => {
  fs.cpSync(`${dotSrc}/${src}`, `${dotDist}/${dist}`, {
    recursive: true,
    force: true,
  });
});

(async () => {
  const scriptDir = `${dotSrc}/.dynamic`;
  const scriptNames = await readdir(scriptDir);
  for (const scriptName of scriptNames) {
    if (scriptName.endsWith(".ts")) {
      console.log(`./${scriptDir}/${scriptName}`);
      await import(`./${scriptDir}/${scriptName}`);
    }
  }
})();
