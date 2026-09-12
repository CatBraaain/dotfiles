#!/bin/sh

# bun's file: deps are per-file symlinks into ~/.dsh/plugins/<plugin>/, so
# plugin content is always current without an install. A plain `bun install`
# would still relink every local plugin on each apply (bun never treats file:
# deps as up to date), so run it only when its inputs changed: package.json or
# bun.lock newer than the stamp (chezmoi rewrites package.json only on content
# change, and bun.lock only changes when bun itself writes it). The stamp lives
# inside node_modules so wiping node_modules forces a full reinstall.
stamp=node_modules/.bun-install-stamp
if [ -f "$stamp" ] &&
    [ -z "$(find package.json bun.lock -newer "$stamp" -print -quit)" ]; then
    exit 0
fi
bun install
touch "$stamp"
