# .dsh/test

dsh web UI の見た目を確認するための fixture とスクリーンショット用スクリプトである。
部品別確認は dsh 本体を起動しない静的 HTML、全体確認は実 dsh web の `?fixture` 画面を使う。
`?fixture` はブラウザ内の fake RPC を使うため、LLM provider へリクエストしない。

## 最短手順

```bash
cd dotfiles/.dsh/test
bun install
bun run shot:all
```

`shot:all` は次の順に実行する。

1. `render.ts` で静的 HTML を生成する
2. `shot.ts` で部品別・light/dark のスクリーンショットを生成する
3. `web-shot.ts` で fake 通信の実 dsh web 全体を撮影する

生成物は `dist/` に置かれる。

| 生成物 | 内容 |
|---|---|
| `fixture.html` / `fixture-dark.html` | 部品別ケースを並べた静的レビュー画面 |
| `fixture-<case>.png` | 各ケースの light スクリーンショット |
| `fixture-<case>-dark.png` | 各ケースの dark スクリーンショット |
| `fixture.png` / `fixture-dark.png` | 全部品を並べた light/dark の一覧 |
| `fixture-hover.png` | session-list の hover 状態 |
| `web-fixture.png` / `web-fixture-dark.png` | fake RPC を使う実 dsh web 全体 |

## 個別操作

静的 HTML だけを生成する:

```bash
bun run render
```

静的 HTML をブラウザで確認する:

```bash
bun serve.ts
# http://localhost:4173/       light
# http://localhost:4173/dark   dark
```

ポートが使用中のときは `PORT=<番号> bun serve.ts` で変えられる。

静的 HTML のスクリーンショットだけを撮影する:

```bash
bun run shot
```

実 dsh web の全体スクリーンショットだけを撮影する:

```bash
bun run shot:web
```

`shot:web` は `dsh web --no-open --port 0` を起動し、token URL で認証した後に
`/?fixture` へ移動する。撮影中は loopback 外への通信を検出して失敗させる。`?fixture` が会話データを
ブラウザ内の fake RPC から供給し、撮影スクリプトは送信・コマンド実行を行わないため、
LLM provider へのリクエストは発生しない。dsh の loopback control-plane RPC と WebSocket
は画面の起動に必要なため許可する。

## 対象ケース

静的 fixture には現在の client UI plugin の主要な表示状態を12ケース収録している。

1. skill-status: 通常、空、長文
2. session-list: workspace、blank、empty
3. agents: auto、manual、idle
4. concurrency-retry: 実 bundle の chat-node 行（fake wait node を描画）
5. quota-line: quota 表示（手書きの書式リファレンス。実 component は SSR 時に fetch を
   行えず、`?fixture` 世界にも quota route が無いため bundle render できない）
6. custom-ui: composer の1行化（stock InputBar DOM を模した手書きレイアウトリファレンス。
   実画面での確認は `shot:web` の全体スクショで行う）

`titlebar` の DOM 無関係な振る舞いは `shot:web` が検証する（`document.title` に
待機 mark と session タイトルが載ること）。

## 仕組みと制限

- 静的 fixture は commit 済み plugin client bundle と dsh theme CSS を使う。plugin の
  React component は fake slot context で登録を取り出し、`react-dom/server` で描画する。
- `quota-line` は本来 host route を poll するため、静的 fixture では成功時の表示 payload を
  固定して描画する。通信経路は `shot:web` の `?fixture` 画面で確認する。
- `?fixture` は browser-side のセッション履歴・会話履歴を fake RPC から供給する。
- 静的 render は subscription、クリック、popover、archive、workspace picker などの
  インタラクションを実行しない。これらは実 dsh web の確認対象である。
- `shot:web` の撮影対象は fixture 世界が持つ会話（tool card、画像メッセージ、todo）で、
  fixture 世界が route を持たない quota-line・agents state の表示は出ない。これらは
  静的 fixture のケースで確認する。fixture 世界は承認待ちの質問カードを seed するため、
  撮影スクリプトが skip / reject してから撮影する。
- Chromium の絵文字フォントにより `🎯` が tofu になることがある。

ケースの合否基準は `REVIEW.md`、起動時エラーの smoke test は `SPEC.md` に定める。
