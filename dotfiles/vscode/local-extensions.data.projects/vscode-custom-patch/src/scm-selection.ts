type ScmSelectionResult = "applied" | "pending" | "unavailable";
type ScmRepository = {
  provider?: { rootUri?: { scheme?: string; authority?: string; path?: string; fsPath?: string } };
};
type ScmView = {
  selectionModeConfig?: { get(): string };
  repositories?: readonly ScmRepository[];
  visibleRepositories: ScmRepository[];
};
type ServicesAccessor = { get(service: unknown): ScmView | undefined };
type CommandRegistry = {
  getCommand(id: string): unknown;
  registerCommand(
    id: string,
    callback: (accessor: ServicesAccessor, ...args: unknown[]) => ScmSelectionResult,
  ): void;
};

export function registerScmSelection(registry: CommandRegistry, scmViewService: unknown): void {
  const command = "agentKit.scm.selectRepositories";
  if (typeof registry?.getCommand !== "function" || typeof registry.registerCommand !== "function")
    return;
  if (!registry.getCommand("scm.setActiveProvider") || registry.getCommand(command)) return;
  registry.registerCommand(command, selectRepositories);

  function selectRepositories(accessor: ServicesAccessor, ...args: unknown[]): ScmSelectionResult {
    const [paths] = args;
    if (args.length !== 1 || !Array.isArray(paths) || paths.length === 0) return "unavailable";
    const targets = new Set<string>();
    for (const path of paths) {
      if (!isAbsolutePath(path) || targets.has(path)) return "unavailable";
      targets.add(path);
    }

    try {
      const view = accessor.get(scmViewService);
      if (!view || view.selectionModeConfig?.get() !== "multiple") return "unavailable";
      const visible = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(view),
        "visibleRepositories",
      );
      if (typeof visible?.get !== "function" || typeof visible.set !== "function")
        return "unavailable";
      const discovered = view.repositories;
      if (!Array.isArray(discovered)) return "unavailable";

      const matches = new Map<string, ScmRepository>();
      for (const repository of discovered) {
        const path = repositoryPath(repository);
        if (path === undefined || !targets.has(path)) continue;
        if (matches.has(path)) return "unavailable";
        matches.set(path, repository);
      }
      if (matches.size !== targets.size) return "pending";

      const selection = [...targets].map((path) => matches.get(path)!);
      const currentSelection = view.visibleRepositories;
      if (!Array.isArray(currentSelection)) return "unavailable";
      if (
        currentSelection.length !== selection.length ||
        selection.some((repo) => !currentSelection.includes(repo))
      ) {
        view.visibleRepositories = selection;
      }
      return "applied";
    } catch (error) {
      console.warn("Agent Kit SCM selection unavailable", error);
      return "unavailable";
    }
  }

  function isAbsolutePath(path: unknown): path is string {
    return (
      typeof path === "string" &&
      !path.includes("\0") &&
      (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]+\\[^\\]+/.test(path))
    );
  }

  function repositoryPath(repository: ScmRepository): string | undefined {
    const root = repository.provider?.rootUri;
    if (root?.scheme === "vscode-remote" && root.authority?.startsWith("wsl+")) return root.path;
    return root?.fsPath;
  }
}
