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

export function prepareAgentWorktreeVisibility(bundle: string): string | undefined {
  const mainThreadScmRegistration = new RegExp(
    `(?<![$\\w])(${IDENTIFIER})\\s*=\\s*${IDENTIFIER}\\(\\s*\\[\\s*${IDENTIFIER}\\(\\s*${IDENTIFIER}\\.MainThreadSCM\\s*\\)[^\\[\\]]*\\]\\s*,\\s*\\1\\s*\\)`,
    "g",
  );
  const [, customer] = uniqueMatch(bundle, mainThreadScmRegistration) ?? [];
  if (!customer) return;
  const registerSourceControl = new RegExp(
    `\\basync\\s+\\$registerSourceControl\\(\\s*(?:${IDENTIFIER}\\s*,\\s*){7}${IDENTIFIER}\\s*\\)\\s*\\{`,
    "g",
  );
  if (!uniqueMatch(bundle, registerSourceControl)) return;

  return `;(() => {
  if (typeof ${customer} !== "function") return;
  const prototype = ${customer}.prototype;
  const register = prototype.$registerSourceControl;
  if (typeof register !== "function" || register.length !== 8) return;
  prototype.$registerSourceControl = function (handle, parentHandle, id, label, rootUri, icon, isHidden, inputUri) {
    const path = rootUri?.path;
    const folderName = typeof path === "string" ? path.split("/").filter(Boolean).at(-1) : undefined;
    const showWorktree = isHidden === true && typeof parentHandle === "number" && id === "git" &&
      folderName?.startsWith("agents-");
    return register.call(this, handle, parentHandle, id, label, rootUri, icon, showWorktree ? false : isHidden, inputUri);
  };
})();`;
}

function uniqueMatch(source: string, pattern: RegExp): RegExpExecArray | undefined {
  const match = pattern.exec(source);
  if (match && !pattern.exec(source)) return match;
}
