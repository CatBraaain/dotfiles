# dotfiles-dsh-quota-line

## 目的

dsh web UI の入力欄の上に、providerごとの quota使用率を単純なテキスト行で
常時表示する。

## 表示

`conversation.input.dock`（composerカード直上の full-width領域）に、
**現在選択中のモデルの provider** の quota を 1行の dimテキスト（gray系）で
出す。文字色の指定がない限りgray系で統一する。

| 状態 | 表示 |
| --- | --- |
| 選択中provider の quota取得に成功 | `<id> <n>% 5h <n>% wk`（5h窓と週次プール。プランが週次を持たなければ 5h のみ、単窓プランなら表示窓のみ） |
| 選択中モデルの provider が quota非対応 / 未選択 / 取得失敗 / credential未設定 | 行を出さない。エラー行も出さない |

- 「選択中の provider」は client の live状態（`sessions` + `modelDirectories`、
  composer model seat の共有状態）から focused session の実効選択を読む。
  pending → last used → deployment default の解決済み値が降ってくる
- route provider id と quota行の対応: `zai` / `zai-coding-cn` → `zai`、
  `openai-codex` → `codex`。未記載の route は行を出さない
- session切替・モデル選択の変更には即座に追従する（poll を待たない）

- percent は四捨五入して整数表示する
- MCP月次（TIME_LIMIT）や残高系の値はこの行には出さない
- セッションの切替・作成に追従する（quota は session非依存の値だが、表示対象は
  選択中モデルの provider なので切替時に即座に差し替わる）

## 取得

- client は 60秒間隔で host route `GET /plugins/quota-line/quota.json` を pollし、
  タブ復帰時にも再取得する
- host は 120秒TTL のキャッシュ + in-flight dedup で上流API を守る。
  `?refresh=1` でキャッシュを飛ばす
- zai: settings の zai系provider の credential ref（→ 既知ref → env）からキーを
  解決し、`{origin}/api/monitor/usage/quota/limit` を Bearer なし Authorization で叩く
- codex: harness credential records `llm-pi-ai/openai-codex` の grant で
  `chatgpt.com/backend-api/wham/usage` を叩く。期限30秒前に credential store の
  排他ロック内で refreshする（concurrent rotation は観測して追従。grant無しは
  エラーではなく「行を出さない」で扱う）

## プライバシー

キー・トークンはプロセス外に出ない。route が返すのは provider id・プラン名・
percent・reset時刻・エラー文言のみ。

## 設定

表示ON/OFF の設定ファイルは設けない。profile から plugin を除外することで
全体を無効化する。
