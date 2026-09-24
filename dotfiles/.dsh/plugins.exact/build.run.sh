#!/bin/sh
set -e

# Build local plugin entries and install their dependencies.
# Install only when dependencies changed; rebuild only when dist/index.js is
# missing, a non-test source file is newer, or a shared agent-lib source is
# newer (file: deps are symlinked, so the lib's sources are watched in place).

needs_install() {
    [ ! -f "$1" ] && return 0
    [ package.json -nt "$1" ] && return 0
    for lockfile in bun.lock bun.lockb; do
        if [ -f "$lockfile" ] && [ "$lockfile" -nt "$1" ]; then
            return 0
        fi
    done
    return 1
}

for plugin in */; do
    if [ -f "${plugin}package.json" ]; then
        (
            cd "$plugin"
            stamp=node_modules/.bun-install-stamp
            if needs_install "$stamp"; then
                bun install --silent
                touch "$stamp"
            fi
        )
    fi
    if [ -f "${plugin}src/index.ts" ]; then
        entries="src/index.ts"
        [ -f "${plugin}src/runner.ts" ] && entries="$entries src/runner.ts"
        (cd "$plugin" && {
            if [ ! -f dist/index.js ] \
                || [ -n "$(find src -type f ! -name '*.test.ts' -newer dist/index.js -print -quit)" ] \
                || { [ -e node_modules/@dotfiles/agent-lib ] \
                    && [ -n "$(find -L node_modules/@dotfiles/agent-lib -type f -newer dist/index.js -print -quit)" ]; }; then
                # shellcheck disable=SC2086 # entries is an intentional word split
                bun build $entries --outdir dist --target node \
                    --external yaml --external 'shell-quote' --external '@vscode/ripgrep' \
                    --external zod --external '@deepseek-ai/*' --external '@earendil-works/*'
            fi
        })
    fi
done
