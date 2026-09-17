# run_after_build spec

`run_after_build.sh` が dsh plugin の dependency install と bundle build を必要な場合だけ実行するための観測可能な振る舞いを定める。script は chezmoi により `~/.dsh/plugins/` を current directory として実行される。

## dependency install

`package.json` を持つ各 plugin directory について、次の振る舞いをする。

| 状態 | 操作 | 結果 |
| --- | --- | --- |
| `node_modules/.bun-install-stamp` がない | script を実行 | その plugin で `bun install --silent` を1回実行し、成功後に stamp を作成する |
| stamp より `package.json` が新しい | script を実行 | その plugin で install を1回実行し、成功後に stamp を更新する |
| stamp より `bun.lock` または `bun.lockb` が新しい | script を実行 | その plugin で install を1回実行し、成功後に stamp を更新する |
| stamp があり、監視対象の manifest・lockfile が stamp より新しくない | script を実行 | その plugin の install を実行しない |
| install が失敗する | script を実行 | 非0で終了し、その plugin の成功を示す stamp を作成・更新しない |

一つの plugin の install が失敗した場合、script 全体を非0で終了し、後続の build を成功扱いにしない。

## bundle build

`src/index.ts` を持つ各 plugin directory について、install 判定後に次を適用する。

| 状態 | 操作 | 結果 |
| --- | --- | --- |
| `dist/index.js` がない | script を実行 | `bun build` を1回実行する |
| 非テストの `src/` ファイルが `dist/index.js` より新しい | script を実行 | `bun build` を1回実行する |
| `node_modules/@dotfiles/agent-lib` 配下の file が `dist/index.js` より新しい | script を実行 | `bun build` を1回実行する。file: 依存は symlink で張られるため、共有 lib（`~/.agents/lib`）の source 更新が対象になる |
| `dist/index.js` があり、非テスト source も共有 lib もそれより新しくない | script を実行 | `bun build` を実行しない |

install の判定と build の判定は独立する。依存変更で install しても source に変更がなければ build は実行しない。処理順序は plugin install → plugin build → 次の plugin とする。

## 非目標

- pi agent の dependency install
- dsh web profile の dependency install
- VS Code 拡張同期
- `run_after_` を別の chezmoi attribute へ変更
