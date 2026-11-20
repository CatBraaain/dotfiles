// Build hook: point vscode_custom_css.imports at the custom-css-js folder of
// the OS this dist is built for. The source ships the Windows default because
// a single URL cannot match both file layouts.
async function main(): Promise<void> {
  if (process.platform === "win32") return;
  const managerSrc = process.env.DOTFILES_MANAGER_SRC;
  if (managerSrc === undefined || managerSrc === "") {
    throw new Error("hook environment variable is not set: DOTFILES_MANAGER_SRC");
  }
  const { buildHookContext } = await import(`${managerSrc}/hook-context.ts`);
  const context = await buildHookContext();
  const linuxImports = '"file://${userHome}/.config/Code/User/custom-css-js/scm-collapse.js"';
  const importsPattern = /"file:\/\/\$\{userHome\}\/[^"]*\/custom-css-js\/scm-collapse\.js"/;
  await context.transform("settings.json", (content: string) => {
    const next = content.replace(importsPattern, linuxImports);
    if (next === content) {
      throw new Error("vscode_custom_css.imports entry for custom-css-js/scm-collapse.js not found in settings.json");
    }
    return next;
  });
}

if (import.meta.main) await main();
