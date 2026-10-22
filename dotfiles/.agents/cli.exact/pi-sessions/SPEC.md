# pi-sessions CLI spec

コマンド `pi-sessions` の仕様。pi(コーディングエージェント)が書き出すセッションログを検索・一覧・閲覧する CLI であり、サブコマンド `search` / `list` / `show` を持つ。

読者はこの spec だけを読んで要件の go/no-go をするユーザーと、実装・テストの担当者。

- 用語: セッションは 1 つの JSONL ファイル(1 行 1 entry)。プロジェクトディレクトリはセッション起動時の cwd の `/` を `-` に置換し前後を `--` で括った名前(`/home/username/projects/X` → `--home-username-projects-X--`)。
- 方針: 生の JSONL 行は人間向け出力にそのまま出さず、entry からテキストを抽出して見せる。全文検索は ripgrep に任せ、CLI 側のパースはヒット行と対象ファイルのみに限定する。インデックス(SQLite 等)の構築は対象外である。

usage:

```
usage: pi-sessions search <query> [--json] [--project <pattern>] [--since <date>] [--until <date>] [--limit <n>] [--role <user|assistant>]
       pi-sessions list [--json] [--project <pattern>] [--since <date>] [--until <date>] [--limit <n>]
       pi-sessions show <id> [--json] [--project <pattern>] [--since <date>] [--until <date>] [--offset <n>] [--limit <n>] [--query <text>] [--role <user|assistant>]
```

## 対象ファイル

対象は `~/.pi/agent/sessions/<project-dir>/<timestamp>_<uuid>.jsonl` のみである。

- `<timestamp>` は `YYYY-MM-DDTHH-MM-SS-mmmZ` 形式の開始時刻。
- プロジェクトディレクトリの直下にあるファイルだけを対象とし、`subagents/` や `archive/` 等のサブディレクトリは対象外である。
- 1 行目は session ヘッダー `{"type":"session","cwd","id","timestamp","version"}`。
- 主な entry type は次のとおり。閲覧対象のtypeと子イベントは `show` の表で定める。

| entry type | 内容 |
| --- | --- |
| `message` | `message.role` は `user` / `assistant` / `system` / `toolResult`。assistant の `message.content` は `thinking` / `text` / `toolCall` ブロックの配列。toolResult は `message` 直下に `toolCallId` / `toolName` / `content`(テキストブロック配列) / `isError` / `durationMs` を持つ |
| `custom` | `customType` に `agents.subagent-log`(子エージェントの起動ログ。`data.agent`・`data.task`・`data.events`)、`pi-stamp`、`skill-status` 等がある |
| `model_change` / `thinking_level_change` | モデルと思考レベルの変更履歴 |

## 共通オプション

| オプション | 挙動 |
| --- | --- |
| `--json` | 機械可読出力。`search` / `list` は1件1行のJSONL。`show` はページ情報付きの1オブジェクト |
| `--project <pattern>` | プロジェクトディレクトリ名の部分一致(大文字小文字を区別) |
| `--since <YYYY-MM-DD>` | ファイル名タイムスタンプの日付がその日以降(その日を含む) |
| `--until <YYYY-MM-DD>` | ファイル名タイムスタンプの日付がその日以前(その日を含む) |
| `--limit <n>` | 出力件数の上限。`list` は更新時刻降順で上位 n 件。`search` はヒットが n 件に達した時点で検索を打ち切る。`show` は閲覧レコード数の上限（既定50件） |
| `--role <user\|assistant>` | `search` / `show` の発言者を絞る。親と子の両方に適用する。省略時は発言者で絞らない。ほかのサブコマンドで指定した場合はエラー |

- 日付の形式が違う値、`--limit` / `--offset` の 0 以下・非整数、未定義の role、未知のオプション、値の欠落、位置引数の過不足はエラー(usage を stderr に出し非0 で終了)。`--offset` / `--query` は `show` で受け付ける。

## search

`pi-sessions search <query>` は、絞り込み後のファイル集合に対して ripgrep(`rg`)を spawn して全文検索する。`agents.subagent-log` の子ログを含む custom 行も自然にヒットする。

- 人間可読: ヒットごとに `id(8桁)・プロジェクトディレクトリ・entryType・時刻・行番号` の見出し行と、その行から抽出したテキストの抜粋(改行は空白に崩し 200 字で切り詰め)を 2 行で出す。
- テキスト抽出は entry 単位で行う。assistant は text ブロックを優先し、無ければ thinking ブロックを使う。system メッセージは `content` が空のため `sections` の値を結合したテキストを使う。
- `--json`: `{"sessionId","project","path","line","entryType","timestamp","text"}` を 1 件 1 行で出す。`text` は抽出テキスト(2000 字まで)。`sessionId` は uuid 全体、人間可読の id は先頭 8 桁である。
- `--limit` を指定したときは、ヒット数が上限に達した時点で `rg` を停止し、以降の走査を行わない。
- `--limit` 未指定でも、ヒット行は10万桁を超えた時点で `rg` 側で打ち切る。子イベントの特定やroleの確認が必要な場合は元のentryを確認する。それ以外の打ち切られた行は、行頭から `type` / `customType` / `timestamp` を抽出し、`text` は行頭の抜粋を出す。
- `entryType` は `message` / `custom:<customType>` 等で表す。行頭から type も読めないヒット行は `unparsed` とする。
- 子ログのイベント本文にヒットしたときは、task だけでなく該当本文の抜粋を表示する。JSONには元の行番号に加えて `invocationId` と `eventIndex`（`data.events` 内の1始まりの位置）を付け、親のヒットでは両者を `null` とする。子イベントごとに1件とし、`--limit` は発言者フィルタ後のヒット件数に適用する。
- `--role` 指定時は、親メッセージまたは子イベントの発言者を確認してから採否を決める。打ち切られた行の断片から発言者を推測しない。長い子ログの10万桁以降にあるヒットも、元のentryの該当イベントを特定して抜粋する。
- ヒット 0 件はエラーではなく正常終了である。
- `rg` が PATH に無い場合は明示的なエラーを出し非0 で終了する。

## list

`pi-sessions list` はセッション一覧を更新時刻(mtime)降順で出す。1 行に `id(8桁)`・プロジェクトディレクトリ・`updated`(`YYYY-MM-DD HH:MM:SS`)・サイズ(`B` / `K` / `M` / `G`)・タイトルを並べる。

- タイトルは先頭 user メッセージのテキストを 1 行に崩し 80 字で切り詰めたもの。先頭 user メッセージが無いセッションのタイトルは空文字列である。
- `--json`: `{"id","project","path","started","updated","sizeBytes","title"}` を 1 件 1 行で出す。`started` はファイル名タイムスタンプの ISO 形式、`updated` は mtime の ISO 形式である。
- 対象 0 件はエラーではなく正常終了である。

## show

`pi-sessions show <id>` は1セッションを閲覧する。`<id>` はセッションid（uuid）の前方一致で、0件ならエラー、複数候補ならエラーと候補一覧（最大20件）を出す。

### 閲覧レコード

閲覧レコードは、本文と出所を持つ表示単位である。親の対象entryをファイル順に並べ、`agents.subagent-log` の位置で子の `data.events` を配列順に展開する。子の記録が実行時に親と交互に発生したとしても、保存位置を越えて並べ替えない。

| 対象 | 1レコードの内容・role |
| --- | --- |
| 親のuserメッセージ | 本文全文。role は `user` |
| 親のassistantメッセージ | text・thinking・toolCall（ツール名と引数）を保存順に含めた全文。role は `assistant` |
| 親のtoolResult | ツール名・成否・記録されている所要時間・出力全文。role は `toolResult` |
| 子の `user.message` | content全文。role は `user` |
| 子の `assistant.message` / `assistant.reasoning` | content全文。role は `assistant` |
| 子の `tool.execution_start` | ツール名とinput全文。role は `assistant` |
| 子の `tool.execution_complete` | ツール名・成否（記録があれば）・output全文。role は `toolResult` |

sessionヘッダー・systemメッセージ・モデル変更・上表にないcustomや子イベントは、閲覧レコードには含めない。存在しない時刻・成否・出力は補わない。

各レコードに、セッション内の1始まりの `index`、元の行番号 `line`、`role`、`text`、`source`（`parent` / `subagent`）を付ける。子には `agent`・`invocationId`・`eventIndex`（events内の1始まりの位置）も付け、親ではこれらを `null` とする。本文を文字数で切り捨てない。

### 絞り込みとページ送り

| 入力・条件 | 結果 |
| --- | --- |
| オプションなし | 先頭から50レコードを表示 |
| `--offset <n>` | 選択されたレコード列のn件目から表示。1始まり、既定1 |
| `--limit <n>` | 最大nレコードを表示 |
| `--role user` / `--role assistant` | roleが一致するレコードだけを残す |
| `--query <text>` | 本文に文字列を含むレコードと、その前後2レコードを選ぶ。大小文字を区別するリテラル部分一致 |
| 複数ヒットで周辺範囲が重なる | 同じレコードは1回だけ、元の順番で表示 |
| query・role・offset・limitの併用 | roleで絞り、queryのヒットと前後を選び、最後にoffset・limitを適用 |
| queryが0件にヒット | `no matches` と表示し、正常終了 |
| offsetが選択件数を超える | `no records at this offset` と表示し、正常終了 |

親と子の境界をまたぐ前後表示でも、出所は各レコードで識別できる。`index` は絞り込み前の番号を維持し、`offset` は絞り込み後の位置を表す。たとえばヒットが10件目なら、境界に達しない場合は8〜12件目を選び、その列にページ送りを適用する。

人間向け出力はレコードの `index`・role・出所（子ならagentとinvocationId）と本文を表示し、末尾に `total`（選択件数）・`offset`・`returned`・`nextOffset` を表示する。続きがなければ `nextOffset` は `null` とする。続きを読むときは同じid・query・role・limitを使い、offsetをnextOffsetに替える。

`--json` は `{"sessionId","records","total","offset","returned","nextOffset"}` の1オブジェクトを出す。`records` は上記のレコード配列。0件の場合も同じ形で空配列を返す。queryなしのページを順に取得すれば、全閲覧レコードの本文を切り捨てずに読める。

## 出力と終了コード

- 成功時の終了コードは 0、失敗時は 1 である。
- 結果の表示は stdout、usage・エラーは stderr へ出す。
- search のヒット 0 件と list の対象 0 件はエラーではなく正常終了(出力なし、終了コード 0)である。

## 前提と依存

- npm 依存を持たない。TypeScript + Bun の標準API とファイルシステムのみで動く。
- `search` だけが `rg` に依存する。`list` / `show` は `rg` なしで動く。
- セッション全体が巨大(17GB 級)でも、CLI 側で読み込むのは検索のヒット行、`list` / `show` の対象ファイルのみに限定する。検索の走査自体は `rg` が行う。

## テスト

- テストは `src/*.test.ts` とし、`import { describe, it } from "bun:test"` で書き、assertion は `node:assert/strict` を使う。実行は `cd dotfiles/.agents/cli.exact/pi-sessions && bun test` である。
- 対象: entry のパースとテキスト抽出、ファイル名パース・日付フィルタ・プロジェクトフィルタ・id 解決、`rg` 検索(一時ディレクトリの fixture と実 `rg`)、人間可読・JSON の出力フォーマット、CLI 引数と終了コード(fixture ホームでの E2E)。
- 実データでの動作確認は手動実行とする。
