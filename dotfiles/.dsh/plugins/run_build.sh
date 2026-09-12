#!/bin/sh

# Build every local plugin's loader entry to plain JS.
#
# Node refuses to type-strip .ts files under node_modules
# (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so every entry declared in a
# plugin's package.json exports must be a built JS file. chezmoi runs this
# script with the plugins directory as CWD on every apply.
#
# Run order matters: chezmoi applies scripts in alphabetical order of their
# target paths, and ".dsh/plugins/..." sorts before ".dsh/profiles/...", so
# this build runs before profiles/web/run_pnpm_install.sh re-links the built
# entries into the profile's node_modules.

for plugin in */; do
    if [ -f "${plugin}src/index.ts" ]; then
        (cd "$plugin" && bun build src/index.ts --outdir dist --target node --external '*')
    fi
done
