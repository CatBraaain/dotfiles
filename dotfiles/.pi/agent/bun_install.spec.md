# bun_install spec

pi agent全体の依存導入を管理するbuildフックとapplyフックの振る舞いを、dotfilesの保守担当者向けに定める。

## buildフックの振る舞い

`bun_install.build.ts` はdist内の `.pi/agent/` をcurrent directoryとして実行され、配下の拡張buildフックより先に共通のbuild依存を準備する。入力は同ディレクトリの `package.json` と `bun.lock`。導入先は `.build-deps/` で、開発依存を含めて `bun install --frozen-lockfile` を実行する。事前の手動インストールは不要である。

| 状態 | 操作 | 結果 |
| --- | --- | --- |
| 初回・依存未導入・導入記録なし | buildフックを実行 | 依存を導入し、成功記録を残す |
| manifest・lockfileの内容が変更された | buildフックを実行 | 固定lockfileで依存を再導入し、成功記録を更新する |
| 記録とファイル内容が一致し、必要な依存が存在する | buildフックを実行 | インストールを省略し、準備済みの依存を維持する |
| 導入済みの依存が欠けている | buildフックを実行 | 依存を再導入する |
| 導入に失敗する | buildフックを実行 | 非0で終了し、後続の拡張buildフックへ進まない。成功記録は残さず、次回に再試行する |

CLIとライブラリはこの共通依存環境から利用する。個別拡張のbuildフックは共通manifestの依存をインストールしない。ソース側・ホーム側の `node_modules` はbuildフックでは変更しない。`.build-deps/` はホームへの展開対象外である。

distはbuildごとに再構築されるため、通常のbuildでは毎回依存を導入する。取得にはBunキャッシュを利用する。同じdist内でフックを再実行する場合は、上表に従って導入を省略できる。

## applyフックの振る舞い

`bun_install.apply.ts` はhome applyのapplyライフサイクルにより `~/.pi/agent/` をcurrent directoryとして実行される。

| 状態 | 操作 | 結果 |
| --- | --- | --- |
| `node_modules/.bun-install-stamp` がない | script を実行 | `bun install --silent` を1回実行し、成功後に stamp を作成する |
| stamp より `package.json` が新しい | script を実行 | `bun install --silent` を1回実行し、成功後に stamp を更新する |
| stamp より `bun.lock` または `bun.lockb` が新しい | script を実行 | `bun install --silent` を1回実行し、成功後に stamp を更新する |
| stamp があり、監視対象の manifest・lockfile が stamp より新しくない | script を実行 | `bun install` を実行せず、stamp を維持する |
| install が失敗する | script を実行 | 非0で終了し、成功を示すstamp を作成・更新しない |

`node_modules` と stamp は dotfiles の管理対象外である。依存変更がないapply では dependency install を起動しない。

## 非目標

- VS Code拡張同期
