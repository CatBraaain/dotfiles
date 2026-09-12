#!/bin/sh

# Build every local plugin's loader entry to plain JS.
#
# Node refuses to type-strip .ts files under node_modules
# (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so every entry declared in a
# plugin's package.json exports must be a built JS file. chezmoi runs this
# script with the plugins directory as CWD on every apply.
#
# Each entry is bundled: relative imports (src/*.ts helpers) are inlined into
# the built file, while the bare-specifier imports listed below stay external
# so they resolve from the profile's node_modules at runtime. The list must
# cover every package a plugin imports (dynamic import() included); anything
# unlisted would be resolved by bun's auto-install (global cache) and
# silently bundled, duplicating the profile's copy. (The previous --external
# '*' externalized relative imports too, which silently broke multi-file
# entries: the emitted dist/index.js kept `from "./x.ts"` specifiers pointing
# at files dist/ never contained — dotfiles-dsh-agents shipped broken that
# way.)
#
# bun build prints a per-entry summary to stdout and errors to stderr, so
# dropping stdout keeps the apply output quiet while failures stay visible.
#
# Run order matters: chezmoi applies scripts in alphabetical order of their
# target paths, and ".dsh/plugins/..." sorts before ".dsh/profiles/...", so
# this build runs before profiles/web/run_pnpm_install.sh re-links the built
# entries into the profile's node_modules.

for plugin in */; do
    if [ -f "${plugin}src/index.ts" ]; then
        # sandboxed-tools ships a second entry (src/runner.ts) that runs inside
        # the bwrap sandbox; include it in the build when present.
        entries="src/index.ts"
        [ -f "${plugin}src/runner.ts" ] && entries="$entries src/runner.ts"
        # shellcheck disable=SC2086 # entries is an intentional word split
        (cd "$plugin" && bun build $entries --outdir dist --target node \
            --external yaml --external 'shell-quote' --external '@vscode/ripgrep' \
            --external '@deepseek-ai/*' --external '@earendil-works/*' >/dev/null)
    fi
done
