#!/bin/sh

# Build local plugin entries and install their dependencies.
# Rebuild only when dist/index.js is missing or a non-test source file is newer.

for plugin in */; do
    if [ -f "${plugin}package.json" ]; then
        (cd "$plugin" && bun install --silent)
    fi
    if [ -f "${plugin}src/index.ts" ]; then
        entries="src/index.ts"
        [ -f "${plugin}src/runner.ts" ] && entries="$entries src/runner.ts"
        (cd "$plugin" && {
            if [ ! -f dist/index.js ] ||
                [ -n "$(find src -type f ! -name '*.test.ts' -newer dist/index.js -print -quit)" ]; then
                # shellcheck disable=SC2086 # entries is an intentional word split
                bun build $entries --outdir dist --target node \
                    --external yaml --external 'shell-quote' --external '@vscode/ripgrep' \
                    --external zod --external '@deepseek-ai/*' --external '@earendil-works/*'
            fi
        })
    fi
done
