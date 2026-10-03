---
name: storybook
description: >-
  Storybook の導入・初期化と `.storybook/` 配下の設定を扱うときの規範。onboarding ガイド、addon panel、telemetry、What's New 通知、デモ stories など、不要な UI と通信を非表示・無効化する。「storybook 入れて」「storybook をセットアップして」「storybook init」「.storybook/main.ts」「manager.ts」「addon panel を消して」「onboarding を出さないで」等の依頼で使う。stories・decorators・preview.ts の書き方の指導は対象外。
---

# Storybook

Storybook 10 系を対象に、開発に不要な UI 要素と通信を抑えた状態で Storybook を導入・設定するための規範である。Storybook 10 未満のプロジェクトには適用しない。Storybook の導入、`.storybook/` 配下の `main.ts` / `manager.ts` の作成・編集をするときは、この規範に沿って設定する。

## 導入時

プロジェクトルートで、既に Storybook 10 系がインストールされていればそのローカル CLI を使う。未導入なら `npx storybook@10 init` を使い、10 系に限定する。既存の Storybook が 10 系以外なら init を実行しない。対話プロンプト "New to Storybook?" には No を選ぶ。No は onboarding addon なしの minimal setup になる。デモ stories は No を選んでも生成されるため、「デモ stories の除去」を適用する。

非対話実行（エージェント等）ではパイプ入力や全機能を有効にする `--yes` に頼らず、`--agent` と onboarding を含まない `--features` を使う。必要な機能だけを、対象の 10 系 CLI が受け付ける feature 名で追加する。機能が不要なら空の `--features` 指定を使う（対象 CLI が空指定を受け付けない場合は実行せず、非対話で無機能を選べる手順を確認する）:

```bash
npx storybook@10 init --agent --features
```

既存の 10 系を使う場合は上記の `npx storybook@10` を `npx --no-install storybook` に置き換える。導入後に onboarding・addon panel・telemetry 等の設定は後述の節に従って適用する。

## onboarding の無効化

既存の Storybook 10 系プロジェクトで `@storybook/addon-onboarding` が有効なときは、そのローカル CLI でパッケージを削除する:

```bash
npx --no-install storybook remove @storybook/addon-onboarding
```

実行後、`.storybook/main.ts` の `addons` 配列を確認し、`@storybook/addon-onboarding` が残っていれば手動で取り除く。

addon とは別に、SB10 には内蔵の onboarding（sidebar の checklist widget とメニューの guide タブ）がある。`.storybook/main.ts` に `features` を追加して無効化する:

```ts
features: {
  sidebarOnboardingChecklist: false,
  menuOnboardingChecklist: false,
},
```

## manager.ts で UI を非表示にする

`.storybook/manager.ts` を作り、`addons.setConfig` で UI を設定する:

```ts
import { addons } from "storybook/manager-api";

addons.setConfig({
  // addon panel を常に非表示にする
  layoutCustomisations: {
    showPanel: () => false,
  },
});
```

addon panel に加えて、sidebar の root を見出しとして表示しない。同じ `setConfig` に追加する:

| 目的 | 設定 |
| --- | --- |
| sidebar の root 見出しスタイルを解除する | `sidebar: { showRoots: false }` |

`showRoots: false` は root の行そのものを消さない。大文字の見出しスタイル（`TEST`）が通常の行スタイル（`Test`）に変わるだけである。

sidebar の Storybook ブランドは設定から隠せない。`toolbar: { title: { hidden: true } }` は Storybook 10.6 では反映されず（manager runtime に消費箇所がない）、sidebar のブランドはテーマの `brand`（`brandTitle` / `brandImage` から構築される）から無条件に描画される。

## main.ts で telemetry と通知を無効化する

`.storybook/main.ts` の `core` に次の設定を追加する:

```ts
core: {
  disableTelemetry: true,
  disableWhatsNewNotifications: true,
},
```

- `disableTelemetry`: 匿名テレメトリの送信を停止する
- `disableWhatsNewNotifications`: 新バージョンやエコシステム更新の「What's New」通知を非表示にする

## デモ stories の除去

`init` の前後でファイルを比較し、生成された学習用サンプルだけを特定して削除する。`src/stories/**` に既存の実 stories があっても、ディレクトリごと削除しない。`main.ts` の `stories` 配列では、削除したデモ stories だけにマッチする専用エントリ (`./src/stories/**/*.stories.ts` 等) を取り除く。既存の実 stories にもマッチするエントリと汎用の glob (`../src/**/*.stories.*` 等) は残す。実 stories が引き続き `stories` 配列でカバーされていることを確認する。ユーザーが学習用に残すことを明示した場合はデモ stories も削除しない。
