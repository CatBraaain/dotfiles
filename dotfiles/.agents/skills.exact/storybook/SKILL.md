---
name: storybook
description: >-
  Storybook の導入・初期化と `.storybook/` 配下の設定を扱うときの規範。onboarding ガイド、addon panel、telemetry、What's New 通知、デモ stories など、不要な UI と通信を非表示・無効化する。「storybook 入れて」「storybook をセットアップして」「storybook init」「.storybook/main.ts」「manager.ts」「addon panel を消して」「onboarding を出さないで」等の依頼で使う。stories・decorators・preview.ts の書き方の指導は対象外。
---

# Storybook

Storybook 10 系を対象に、開発に不要な UI 要素と通信を抑えた状態で Storybook を導入・設定するための規範である。Storybook 10 未満のプロジェクトには適用しない。Storybook の導入、`.storybook/` 配下の `main.ts` / `manager.ts` の作成・編集をするときは、この規範に沿って設定する。

## 導入時

`npx storybook@latest init` をプロジェクトルートで実行する。対話プロンプト "New to Storybook?" には No を選ぶ。Yes を選ぶと onboarding ツアーとデモ stories 付きで初期化され、No は onboarding なしの minimal setup になる。

導入後に onboarding・addon panel・telemetry 等の設定は後述の節に従って適用する。

## onboarding の無効化

既存プロジェクトで `@storybook/addon-onboarding` が有効なときは、次のコマンドでパッケージを削除する:

```bash
npx storybook@latest remove @storybook/addon-onboarding
```

実行後、`.storybook/main.ts` の `addons` 配列を確認し、`@storybook/addon-onboarding` が残っていれば手動で取り除く。

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

addon panel に加えて、次の2項目も常に非表示にする。同じ `setConfig` に追加する:

| 目的 | 設定 |
| --- | --- |
| toolbar の Storybook タイトルを隠す | `toolbar: { title: { hidden: true } }` |
| sidebar の root 見出しを隠す | `sidebar: { showRoots: false }` |

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

`init` が `src/stories/**` を生成したときは、学習用サンプルであるため導入直後に残さない。ディレクトリごと削除し、`main.ts` の `stories` 配列から `src/stories` のみにマッチする専用エントリ (`./src/stories/**/*.stories.ts` 等) を取り除く。汎用の glob (`../src/**/*.stories.*` 等) は実際のコンポーネントの stories をカバーするため残す。取り除いた後に実際のコンポーネントの stories が `stories` 配列でカバーされていることを確認する。ユーザーが学習用に残すことを明示した場合は削除しない。
