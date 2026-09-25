#!/bin/sh
# Pre-build hook (spec: SPEC.md §build: ローカルフック). Reformats the dist
# copy of settings.json with Biome so that the dist tree matches what VS
# Code writes back after GUI edits: comments are kept, trailing commas are
# printed after every element, and short arrays stay on one line. The Biome
# version is pinned so a formatter update cannot change the dist style.
exec bunx @biomejs/biome@2.5.14 format --write settings.json \
  --json-formatter-trailing-commas=all \
  --json-parse-allow-comments=true \
  --json-parse-allow-trailing-commas=true \
  --indent-style=space \
  --indent-width=2
