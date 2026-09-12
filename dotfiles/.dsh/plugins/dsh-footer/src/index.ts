/**
 * Host half is empty on purpose: this plugin exists as a browser client bundle
 * only, and the empty apply just keeps the cordis.patch.yml row loadable by
 * the host Loader (same pattern as @deepseek-ai/dsh-cordis-client-runner's
 * node half).
 */
export function apply(): void {}
