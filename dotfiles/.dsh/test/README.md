# .dsh/test

dsh web UI の見た目を確認するための fixture とスクリーンショット用スクリプトである。
部品別確認は dsh本体を起動しない静的HTML、全体確認は実dsh web の `?fixture` 画面を使う。
`?fixture` はブラウザ内の fake RPC を使うため、LLM provider へリクエストしない。

## 最短手順

```bash
cd dotfiles/.dsh/test
bun install
bun run shot:all
```

`shot:all` は次の順に実行する。

1. `render.ts` で静的HTML を生成する
2. `shot.ts` で部品別のスクリーンショットを生成する
3. `web-shot.ts` で fake通信の実dsh web全体を撮影する

生成物は `dist/` に置かれる。

| 生成物 | 内容 |
| --- | --- |
| `fixture.html` | 部品別ケースを並べたdarkテーマの静的レビュー画面 |
| `fixture-<case>.png` | 各ケースのスクリーンショット |
| `fixture.png` | 全部品を並べた一覧 |
| `fixture-hover.png` | session-list の hover状態 |
| `web-fixture.png` | fake RPC を使う実dsh web全体（dark） |

## 個別操作

静的HTML だけを生成する:

```bash
bun run render
```

静的HTML をブラウザで確認する:

```bash
bun serve.ts
# http://localhost:4173/       dark
```

ポートが使用中のときは `PORT=<番号> bun serve.ts` で変えられる。

静的HTML のスクリーンショットだけを撮影する:

```bash
bun run shot
```

実dsh web の全体スクリーンショットだけを撮影する:

```bash
bun run shot:web
```

`shot:web` は `dsh web --no-open --port 0` を起動し、token URL で認証した後に
`/?fixture` へ移動する。撮影中は loopback外への通信を検出して失敗させる。`?fixture` が会話データを
ブラウザ内の fake RPC から供給し、撮影スクリプトは送信・コマンド実行を行わないため、
LLM provider へのリクエストは発生しない。dsh の loopback control-plane RPC と WebSocket
は画面の起動に必要なため許可する。

## Storybook

各client UI plugin を個別に表示するStorybookカタログ。実plugin の `lib/client.js` を
fake slot context でロードし、登録されたcomponent を browser で描画する。

```bash
bun run storybook          # dev server (http://localhost:6006、使用中なら対話式で port 変更を求める)
bun run storybook:build    # dist/storybook/ へ静的生成
```

対象は agents、concurrency-retry、custom-ui、quota-line、session-list、skill-status の6 plugin。
toolbar の theme切り替えで light / dark を選べる。表示確認のみで、クリック・popover・
subscription などのインタラクションは対象外。quota-line と agents の host fetch
(`/plugins/quota-line/quota.json`、`/api/dsh-agents/state`) は same-origin の fake応答に置き換えられ、
外部通信は発生しない。custom-ui は実component が host DOM を所有するため、plugin が注入するCSS を
stock DOM を模したhost fixture に当てた状態を表示する。

## 対象ケース

静的fixture には現在の client UI plugin の主要な表示状態を12ケース収録している。

1. skill-status: 通常、空、長文
2. session-list: workspace、blank、empty
3. agents: auto、manual、idle
4. concurrency-retry: 実bundle の chat-node行（fake wait node を描画）
5. quota-line: quota表示（手書きの書式リファレンス。実component は SSR時に fetch を
   行えず、`?fixture` 世界にも quota route が無いためbundle render できない）
6. custom-ui: composer の1行化（stock InputBar DOM を模した手書きレイアウトリファレンス。
   実画面での確認は `shot:web` の全体スクショで行う）

`titlebar` の DOM無関係な振る舞いは `shot:web` が検証する（`document.title` に
待機mark と sessionタイトルが載ること）。

## 仕組みと制限

- 静的fixture は commit済みplugin client bundle と dsh theme CSS を使う。plugin の
  React component は fake slot context で登録を取り出し、`react-dom/server` で描画する。
- `quota-line` は本来host route を pollするため、静的fixture では成功時の表示payload を
  固定して描画する。通信経路は `shot:web` の `?fixture` 画面で確認する。
- `?fixture` は browser-side のセッション履歴・会話履歴を fake RPC から供給する。
- 静的render は subscription、クリック、popover、archive、workspace picker などの
  インタラクションを実行しない。これらは実dsh web の確認対象である。
- `shot:web` の撮影対象は fixture世界が持つ会話（tool card、画像メッセージ、todo）で、
  fixture世界が route を持たないquota-line・agents state の表示は出ない。これらは
  静的fixture のケースで確認する。fixture世界は承認待ちの質問カードを seedするため、
  撮影スクリプトが skip / rejectしてから撮影する。
- Chromium の絵文字フォントにより `🎯` が tofu になることがある。

ケースの合否基準は `REVIEW.md`、起動時エラーの smoke test は `SPEC.md` に定める。
