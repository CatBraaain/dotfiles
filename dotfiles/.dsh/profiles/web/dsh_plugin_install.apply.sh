#!/bin/sh

stamp=node_modules/.dsh-plugin-install-stamp

if [ ! -f "$stamp" ] ||
   find package.json pnpm-lock.yaml -newer "$stamp" -print -quit | grep -q .; then
    dsh plugin --profile web install --ignore-scripts || exit 1
    touch "$stamp"
fi
