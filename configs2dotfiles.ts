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

map.forEach(({ src, dist }) => {
  fs.cpSync(`configs/${src}`, `dotfiles/${dist}`, {
    recursive: true,
    force: true,
  });
});

(async () => {
  const scriptDir = "configs/.dynamic";
  const scripts = await readdir(scriptDir);
  for (const script of scripts) {
    if (script.endsWith(".ts")) {
      console.log(`./${scriptDir}/${script}`);
      await import(`./${scriptDir}/${script}`);
    }
  }
})();
