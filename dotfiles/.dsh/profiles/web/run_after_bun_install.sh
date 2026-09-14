#!/bin/sh

stamp=node_modules/.bun-install-stamp

if [ ! -f "$stamp" ] ||
   find package.json bun.lock -newer "$stamp" -print -quit | grep -q .; then
    bun install --ignore-scripts || exit 1
    touch "$stamp"
fi
