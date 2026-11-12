# AGENTS.md

このファイルは、このリポジトリで作業する AI エージェント向けの規約を定める。

## E2E テストの実行

E2Eテストは playwright が `_electron.launch` で VS Code を起動するため、headless では実行できない。

- E2Eテストは `bun run test:e2e` で実行する。ランナー全体が `xvfb-run -a` 配下で起動し、VS Code は仮想ディスプレイに開く
- `bunx playwright test` などランナーの直接実行は、VS Code の実ウィンドウがユーザーの画面に開くため行わない。テストの絞り込みは `bun run test:e2e -- tests/e2e/<file>.spec.ts` のように引数で行う
