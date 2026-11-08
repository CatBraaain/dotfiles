# session-state の実行フェーズ仕様

この文書は、pi extension session-state が公開イベントに応じて実行フェーズを書き出す振る舞いを定める。読者は、この拡張の実行フェーズ通知を保守・改修する user と coding agent である。

## 対象と契約

対象は、[REQUIREMENTS.md「機能要件」](REQUIREMENTS.md#機能要件) で定める自セッションと自ワークスペースである。実行フェーズは、自ワークスペースの `active-sessions` にある自セッションの entry の `state` に書く。書き手は session-state、読み手はストアをウォッチして表示する vscode-pi-sessions である。

entry の構造、`state` の値と省略時の意味、保存先、更新・保持の範囲は、[REQUIREMENTS.md「メタデータストアの契約」](REQUIREMENTS.md#メタデータストアの契約) に従う。アーカイブ操作と入力による所属更新は、[REQUIREMENTS.md「機能要件」](REQUIREMENTS.md#機能要件) に従う。以下の状態更新表とイベント一覧は、実行フェーズの `state` に限る。

## 実行の区間

- run 継続区間は、このプロセスで自セッションの `agent_start` を受けてから、`agent_settled` で確定停止するまでであり、中断による停止も含む。区間内では、リトライ・自動圧縮・キュー継続・拡張による継続で低レベルの agent run が繰り返されても、継続中として扱う。
- `agent_end` は低レベルの run の終了であり、確定停止を表さない。
- 承認 UI 待ちは、`ui_prompt_start` から `ui_prompt_end` までの、ブロッキングする拡張 UI プロンプトの待ち区間である。`select`・`confirm`・`input`・`editor`・`custom` が対象となる。入れ子や重複したプロンプトは、pi が通知する1つの外側の待ち区間として扱う。
- run 継続中か、承認 UI 待ちかは、このプロセスが受けたイベントで判断する。ファイルにある `state` が別プロセスに変更されても、これらの区間の判断は変わらない。

## 状態更新のルール

| 処理 | イベント |
| --- | --- |
| `waiting-user` を設定 | `session_start`・`agent_settled` |
| `waiting-approval` を設定 | `ui_prompt_start` |
| `running` を再確認 | `agent_start`・`ui_prompt_end`・実行進展イベント（下の一覧を参照） |
| `state` を除去（無ければ書き込みを省く） | `session_shutdown` |

起動・新規・resume・fork・reload では、`session_start` で run継続区間外・承認 UI 待ちなしに初期化する。`agent_start` で run継続区間に入り、`ui_prompt_end` は承認 UI 待ちを解除してから再確認する。終了・セッション切替・reload では、`session_shutdown` で run と承認 UI 待ちの追跡も終える。

### 再確認の共通条件

- run継続中かつ承認 UI 待ちでない場合だけ `running` を設定し、それ以外は `state` を更新しない。
- 最新の `state` が既に `running` なら書き込みを省く。
- 対象イベントごとにファイル上の最新 `state` を確かめる。ストリーム更新もイベントごとに対象とする。
- 別プロセスが `waiting-user` を設定するか `state` を除去した場合、次の対象イベントで条件を満たせば `running` に戻す。
- entry が無い場合は、[書き込みと失敗時の扱い](#書き込みと失敗時の扱い) の規則に従って作成する。

## 公開イベントの扱い

pi の `ExtensionAPI.on` が公開するイベントを、実行フェーズの `state` を再確認するものと更新しないものに分ける。状態境界イベントの処理は上の表に従う。

### 実行進展イベント

次の22イベントは、発火ごとに共通条件に従って `state` を再確認する。

- 圧縮: `session_before_compact`・`session_compact`・`session_compact_failed`
- コンテキスト準備: `context`・`context_with_system`
- provider通信: `before_provider_request`・`before_provider_headers`・`after_provider_response`・`provider_stream_event`
- run準備・終了・継続判断: `before_agent_start`・`agent_end`・`agent_before_settle`
- ターン: `turn_start`・`turn_end`
- メッセージ: `message_start`・`message_update`・`message_end`
- ツール実行: `tool_execution_start`・`tool_execution_update`・`tool_execution_end`
- ツール処理: `tool_call`・`tool_result`

### 更新しないイベント

- 信頼判定・探索: `project_trust`・`resources_discover`
- 名称・設定変更: `session_info_changed`・`mcp_servers_change`・`model_select`・`thinking_level_select`
- セッション切替・分岐前: `session_before_switch`・`session_before_fork`
- 履歴移動: `session_before_tree`・`session_tree`
- idleキャッシュ判断: `cache_warming_decision`
- user の Bash実行: `user_bash`
- 入力: `input`

ここで更新しないのは `state` である。プロンプト送信時の自動アーカイブ解除は [REQUIREMENTS.md「機能要件」](REQUIREMENTS.md#機能要件) に従う。

### 判断を誤る例外

- 初回の `before_agent_start` は run区間外であり、run区間外の手動圧縮も更新しない。
- `agent_end` と `session_compact_failed` は確定停止を表さず、確定停止は `agent_settled` で判断する。
- `tool_execution_end` は拒否・中断・不正な引数などのエラー結果も含めて対象とする。

## 書き込みと失敗時の扱い

- `state` の設定・除去は、ファイルの最新内容を読み、自セッションの entry に対する read-modify-write として行う。設定値と現在値が同じなら書き込みを省く。
- `state` の設定時に entry が無ければ作成する。作成・更新では、ストア契約に従って `lock` と未知の属性を保持する。
- 書き込みに失敗しても pi の動作を止めず、失敗を警告で通知する。
- 異常終了で残留した `state` の掃除は読み手側の責務である。この拡張による終了時の除去は `session_shutdown` で行い、`pid` は書かない。
