# dotfiles-dsh-quota-line

## 目的

dsh web UI の入力欄の上に、provider ごとの quota 使用率を単純なテキスト行で
常時表示する。dsh-quota-panel（右下カプセル）を置き換える。

## 表示

`conversation.input.dock`（composer カード直上の full-width 領域）に、
**現在選択中のモデルの provider** の quota を 1 行の dim テキスト（gray 系）で
出す。文字色の指定がない限り gray 系で統一する。

| 状態 | 表示 |
| --- | --- |
| 選択中 provider の quota 取得に成功 | `<id> <n>% 5h <n>% wk`（5h 窓と週次プール。プランが週次を持たなければ 5h のみ、単窓プランなら表示窓のみ） |
| 選択中モデルの provider が quota 非対応 / 未選択 / 取得失敗 / credential 未設定 | 行を出さない。エラー行も出さない |

- 「選択中の provider」は client の live 状態（`sessions` + `modelDirectories`、
  composer model seat の共有状態）から focused session の実効選択を読む。
  pending → last used → deployment default の解決済み値が降ってくる
- route provider id と quota 行の対応: `zai` / `zai-coding-cn` → `zai`、
  `openai-codex` → `codex`。未記載の route は行を出さない
- session 切替・モデル選択の変更には即座に追従する（poll を待たない）

- percent は四捨五入して整数表示する
- MCP 月次（TIME_LIMIT）や残高系の値はこの行には出さない
- セッションの切替・作成に追従する（quota は session 非依存の値だが、表示対象は
  選択中モデルの provider なので切替時に即座に差し替わる）

## 取得

- client は 60 秒間隔で host route `GET /plugins/quota-line/quota.json` を poll し、
  タブ復帰時にも再取得する
- host は 120 秒 TTL のキャッシュ + in-flight dedup で上流 API を守る。
  `?refresh=1` でキャッシュを飛ばす
- zai: settings の zai 系 provider の credential ref（→ 既知 ref → env）からキーを
  解決し、`{origin}/api/monitor/usage/quota/limit` を Bearer なし Authorization で叩く
- codex: harness credential records `llm-pi-ai/openai-codex` の grant で
  `chatgpt.com/backend-api/wham/usage` を叩く。期限 30 秒前に credential store の
  排他ロック内で refresh する（concurrent rotation は観測して追従。grant 無しは
  エラーではなく「行を出さない」で扱う）

## プライバシー

キー・トークンはプロセス外に出ない。route が返すのは provider id・プラン名・
percent・reset 時刻・エラー文言のみ。

## 設定

表示 ON/OFF の設定ファイルは設けない。profile から plugin を除外することで
全体を無効化する。
