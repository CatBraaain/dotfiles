const IDENTIFIER = "[$A-Za-z_][$\\w]*";

export function prepareScmBridge(bundle: string, scmSelectionSource: string): string | undefined {
  if (!/\bset\s+visibleRepositories\s*\(/.test(bundle)) return;
  if (
    !/\bselectionModeConfig\s*=\s*[$\w]+\(\s*["']scm\.repositories\.selectionMode["']/.test(bundle)
  )
    return;

  const viewServiceDeclaration = new RegExp(
    `\\b(?:var|let|const)\\s+(${IDENTIFIER})\\s*=\\s*${IDENTIFIER}\\(\\s*["']scmView["']\\s*\\)`,
    "g",
  );
  const [viewService] = uniqueMatch(bundle, viewServiceDeclaration)?.slice(1) ?? [];
  if (!viewService) return;

  const activeProviderRegistration = new RegExp(
    `(?<![$\\w])(${IDENTIFIER})\\.registerCommand\\(\\s*["']scm\\.setActiveProvider["']\\s*,[^{};]*\\{([^{};]*)`,
    "g",
  );
  const [, registry, handlerStart] = uniqueMatch(bundle, activeProviderRegistration) ?? [];
  if (!registry || !handlerStart?.replaceAll(/\s/g, "").includes(`.get(${viewService})`)) return;

  return `;(() => {
  try {
    if (typeof ${registry} !== "undefined" && typeof ${viewService} === "function" && ${viewService}.toString() === "scmView") {
      ((module) => {
${scmSelectionSource}
        return module.exports.registerScmSelection;
      })({})(${registry}, ${viewService});
    }
  } catch (error) {
    console.warn("Agent Kit SCM bridge could not register", error);
  }
})();`;
}

function uniqueMatch(source: string, pattern: RegExp): RegExpExecArray | undefined {
  const match = pattern.exec(source);
  if (match && !pattern.exec(source)) return match;
}
