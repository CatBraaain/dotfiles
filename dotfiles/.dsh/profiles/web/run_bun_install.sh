#!/bin/sh

# bun's file: deps are per-file symlinks into ~/.dsh/plugins/<plugin>/, so
# plugin content is always current without an install. A plain `bun install`
# would still relink every local plugin on each apply (bun never treats file:
# deps as up to date), so run it only when its inputs changed: package.json or
# bun.lock newer than the stamp (chezmoi rewrites package.json only on content
# change, and bun.lock only changes when bun itself writes it). The stamp lives
# inside node_modules so wiping node_modules forces a full reinstall.

# bun hoists the plugins' transitive copy of @deepseek-ai/dsh-tools to the
# profile's top-level node_modules. The dsh-base bundle mounts its `tools`
# service by importing that bare specifier with the profile dir as the
# resolution base, so the hoisted copy shadows the global install that
# @deepseek-ai/dsh-agent-loop resolved through ~/.dsh/profiles/node_modules.
# Symbol() is unique per module instance, so agent-loop's scheduler lookup
# (`ctx.tools[TOOL_RUNTIME_SCHEDULER]`) misses and every tool-call turn fails
# with "Cannot read properties of undefined (reading 'prepare')". Re-point the
# hoisted path at the closure's (global) target so both sides share one module
# instance. bun recreates the real dir on each reinstall; this patch runs on
# every apply (even when the install is skipped) and is a no-op once symlinked.
patch_dsh_tools() {
    closure="$HOME/.dsh/profiles/node_modules/@deepseek-ai/dsh-tools"
    global=$(readlink -f "$closure")
    if [ -z "$global" ]; then
        echo "run_bun_install.sh: $closure does not resolve; cannot patch dsh-tools" >&2
        return 1
    fi
    hoisted=node_modules/@deepseek-ai/dsh-tools
    if [ -d "$hoisted" ] && [ ! -L "$hoisted" ]; then
        rm -rf "$hoisted"
        ln -s "$global" "$hoisted"
    fi
}

stamp=node_modules/.bun-install-stamp
if [ -f "$stamp" ] &&
    [ -z "$(find package.json bun.lock -newer "$stamp" -print -quit)" ]; then
    patch_dsh_tools
    exit 0
fi
bun install
patch_dsh_tools || exit 1
touch "$stamp"
