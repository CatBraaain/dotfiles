#!/bin/sh

# Build every local plugin's loader entry to plain JS.
#
# Node refuses to type-strip .ts files under node_modules
# (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so every entry declared in a
# plugin's package.json exports must be a built JS file. chezmoi runs this
# script with the plugins directory as CWD on every apply.
#
# --packages=external keeps package imports (node_modules, @deepseek-ai/*)
# external so they resolve from the profile closure at runtime, while
# RELATIVE imports between the plugin's own modules are bundled — a bare
# `--external '*'` would leave "./module.ts" imports unresolved in the
# output and the built entry would fail to load (ERR_MODULE_NOT_FOUND).
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
        (cd "$plugin" && bun build $entries --outdir dist --target node --packages=external)
    fi
done
