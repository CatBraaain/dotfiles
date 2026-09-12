/**
 * dotfiles-dsh-titlebar — host half (intentionally a no-op).
 *
 * All behavior lives in the browser client half (`src/client/`): the web UI
 * has no terminal title, so the ported pi `titlebar` extension writes
 * `document.title` there. The host side only provides the bundle row that
 * makes dsh load the package; it registers nothing.
 *
 * This entry is a single self-contained module on purpose: `run_build.sh`
 * builds it with `--external '*'`, which externalizes relative imports too,
 * so a multi-file host entry would produce a broken `dist/index.js` (see the
 * dsh-skill-status README "Build").
 */

export const name = 'dsh-titlebar'

export function apply(): void {}
