#!/bin/sh

# Build every local plugin's loader entry to plain JS and install each
# plugin's own dependencies into the plugin dir.
#
# Node refuses to type-strip .ts files under node_modules
# (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so every entry declared in a
# plugin's package.json exports must be a built JS file. chezmoi runs this
# script with the plugins directory as CWD on every apply.
#
# Each entry is bundled: relative imports (src/*.ts helpers) are inlined into
# the built file, while the bare-specifier imports listed below stay external
# so they resolve at runtime from the plugin's own node_modules, installed by
# this script (see below). The list must cover every package a plugin imports
# (dynamic import() included); anything unlisted would be silently bundled,
# duplicating the installed copy. (The previous --external '*' externalized
# relative imports too, which silently broke multi-file entries: the emitted
# dist/index.js kept `from "./x.ts"` specifiers pointing at files dist/ never
# contained — dotfiles-dsh-agents shipped broken that way.)
#
# Plugins declaring dependencies get them installed into the plugin dir.
# bun links file: deps into the profile's node_modules as per-file symlinks,
# and Node resolves imports from the symlinked file's real path under
# ~/.dsh/plugins/<plugin>/, so the profile's hoisted node_modules is never
# consulted for a plugin's bare imports — only a node_modules inside the
# plugin dir is. Install runs unconditionally: on a plugin without
# dependencies it is a no-op that only creates an empty node_modules.
#
# bun build prints a per-entry summary to stdout and errors to stderr, so
# dropping stdout keeps the apply output quiet while failures stay visible.
#
# The build is conditional (Make-style): a plugin is rebuilt only when it has
# no dist/index.js yet, or some file under src/ (or this script itself, so a
# recipe change rebuilds everything once) is newer than dist/index.js.
# Unconditional rebuilding would rewrite dist on every apply for no benefit:
# the profile's node_modules links file: deps per file, so it always sees the
# plugin dirs' current content.
#
# The run_after_ prefix makes chezmoi run this script only after the entire
# target state has been applied, so every plugin's src/ is fully deployed
# before being bundled. (As a plain run_ script it executed in target-path
# order in the middle of the apply, which bundled stale sources for plugins
# sorting after this file's own path.) The profile's run_bun_install.sh has
# already re-linked by then; that is harmless because bun links file: deps as
# per-file symlinks, so the profile always resolves the freshly built dist/
# content.

for plugin in */; do
    if [ -f "${plugin}package.json" ]; then
        (cd "$plugin" && bun install --silent)
    fi
    if [ -f "${plugin}src/index.ts" ]; then
        # sandboxed-tools ships a second entry (src/runner.ts) that runs inside
        # the bwrap sandbox; include it in the build when present.
        entries="src/index.ts"
        [ -f "${plugin}src/runner.ts" ] && entries="$entries src/runner.ts"
        (cd "$plugin" && {
            if [ ! -f dist/index.js ] ||
                [ -n "$(find src ../run_after_build.sh -type f -newer dist/index.js -print -quit)" ]; then
                # shellcheck disable=SC2086 # entries is an intentional word split
                bun build $entries --outdir dist --target node \
                    --external yaml --external 'shell-quote' --external '@vscode/ripgrep' \
                    --external zod --external '@deepseek-ai/*' --external '@earendil-works/*'
            fi
        })
    fi
done
