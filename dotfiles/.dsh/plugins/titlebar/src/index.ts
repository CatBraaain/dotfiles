/**
 * dotfiles-dsh-titlebar — host half (intentionally a no-op).
 *
 * All behavior lives in the browser client half (`src/client/`): the web UI
 * has no terminal title, so the ported pi `titlebar` extension writes
 * `document.title` there. The host side only provides the bundle row that
 * makes dsh load the package; it registers nothing.
 *
 * `run_build.sh` bundles this entry: relative imports are inlined and only
 * the script's explicit bare-specifier externals stay external (see the
 * skill-status README "Build").
 */

export const name = 'dsh-titlebar'

export function apply(): void {}
