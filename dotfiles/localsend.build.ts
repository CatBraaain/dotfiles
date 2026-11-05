const settingsPaths = [
  ".local/share/org.localsend.localsend_app/shared_preferences.json",
  "AppData/Roaming/LocalSend/settings.json",
];
const jsonTokens = /"(?:\\.|[^"\\])*"|[ \t\r\n]+/g;

async function main(): Promise<void> {
  const { buildHookContext } = await import(
    `${process.env.DOTFILES_MANAGER_SRC}/hook-context.ts`,
  );
  const { transform } = await buildHookContext();
  await Promise.all(
    settingsPaths.map((path) =>
      transform(path, (content: string) => {
        JSON.parse(content);
        return content.replace(jsonTokens, (token) => (token.startsWith('"') ? token : ""));
      }),
    ),
  );
}

if (import.meta.main) await main();
