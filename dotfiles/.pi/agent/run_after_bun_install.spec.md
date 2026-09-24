# run_after_bun_install spec

`run_after_bun_install.sh` が pi agent の dependency install を必要な場合だけ実行するための観測可能な振る舞いを定める。script は home apply の post-apply ライフサイクルにより `~/.pi/agent/` を current directory として実行される。

## 振る舞い

| 状態 | 操作 | 結果 |
| --- | --- | --- |
| `node_modules/.bun-install-stamp` がない | script を実行 | `bun install --silent` を1回実行し、成功後に stamp を作成する |
| stamp より `package.json` が新しい | script を実行 | `bun install --silent` を1回実行し、成功後に stamp を更新する |
| stamp より `bun.lock` または `bun.lockb` が新しい | script を実行 | `bun install --silent` を1回実行し、成功後に stamp を更新する |
| stamp があり、監視対象の manifest・lockfile が stamp より新しくない | script を実行 | `bun install` を実行せず、stamp を維持する |
| install が失敗する | script を実行 | 非0で終了し、成功を示す stamp を作成・更新しない |

`node_modules` と stamp は dotfiles の管理対象外である。依存変更がない apply では dependency install を起動しない。

## 非目標

- dsh plugin の dependency install・bundle build
- VS Code 拡張同期
- `run_after_` を別の run script プレフィックスへ変更
