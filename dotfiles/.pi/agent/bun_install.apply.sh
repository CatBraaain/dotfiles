#!/bin/sh
set -e

stamp=node_modules/.bun-install-stamp

needs_install() {
    [ ! -f "$stamp" ] && return 0
    [ package.json -nt "$stamp" ] && return 0
    for lockfile in bun.lock bun.lockb; do
        if [ -f "$lockfile" ] && [ "$lockfile" -nt "$stamp" ]; then
            return 0
        fi
    done
    return 1
}

if needs_install; then
    # --silent drops the header and summary; errors still print to stderr.
    bun install --silent
    touch "$stamp"
fi
