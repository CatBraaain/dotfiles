# pi-stats

`pi-stats` は pi のセッションファイルの使用統計を測定する独立CLIである。gap 分析モードは provider・モデル別のプロンプトキャッシュの維持時間を測定し、stats モードはトークン・コスト・セッションの統計サマリを出す。利用者と保守担当者が、コマンドの入出力・集計方法・終了コードを確認するための振る舞い正本である。

## 対象レイアウト

対象は `$HOME/.pi/agent/sessions/` 配下の JSONL セッションファイルである。ディレクトリ階層は `sessions/<プロジェクトディレクトリ>/<セッションファイル>.jsonl` であり、プロジェクトディレクトリ直下の他に `archive/`・`subagents/` などのサブディレクトリがある。この文書で「プロジェクトディレクトリ名」とは `<プロジェクトディレクトリ>` のディレクトリ名を指し、gap 分析モードの「セッションディレクトリ名」も同じ物を指す。両モードの数値の丸めは四捨五入とする。

## コマンド

| 入力 | 結果 |
| --- | --- |
| `pi-stats` | gap 分析モードでセッション全体を解析し、provider 別とモデル別のサマリを出す |
| `pi-stats stats [options]` | stats モードで使用統計のサマリを出す |
| `-h` | 使用方法を出す |
| 不正な引数 | stderr に `pi-stats:` 付きの理由と使用方法を出す |

両モードとも、`$HOME/.pi/agent/sessions/` 配下の JSONL セッションファイルを対象とし、読み取り不能・不正 JSON のファイルは集計から除外し、警告を出さない。

## gap 分析モード

### 入力

| 入力 | 結果 |
| --- | --- |
| `-n N` | ファイル更新時刻が新しい方から N 件のセッションだけを解析する |
| `--since YYYY-MM-DD` | 更新日がこの日以降（UTC）のセッションだけを解析する |
| `--until YYYY-MM-DD` | 更新日がこの日より前（UTC）のセッションだけを解析する |
| `-p PREFIX` | セッションディレクトリ名に PREFIX を含むセッションだけを解析する |
| `-m PATTERN` | `provider/model` に大文字小文字を無視して PATTERN を含むペアだけを集計する |
| `--bins MIN[,MIN...]` | gap のビン境界を分で指定する。値は正かつ昇順であること。既定は `1,5,15,30,60,180` |
| `--top N` | モデル別テーブルに表示するモデル数。既定は 12 |
| `--csv PATH` | ペアごとの生データを CSV で PATH へ書き出す |

`-n`・`--since`・`--until`・`-p` は選択条件で、複数指定した場合はすべての条件を満たすセッションを解析する。

### 解析対象とペア

gap 分析モードの対象は、各プロジェクトディレクトリ直下の `.jsonl` である。`archive/`・`subagents/` などサブディレクトリ内は対象外とする。

各ファイルは、末尾エントリから `parentId` をたどった現行分岐だけを扱い、他分岐のエントリは集計に含めない。

ペアは、同一セッション内の assistant 応答と、その直前の同 provider・同モデルの assistant 応答の組である。provider・model・時刻のない assistant 応答は系列から除外する。

`-m` を指定したときは、一致しない応答を系列から除いた上で、直前の同モデル応答とペアを作る。一致しない応答が挟まっても系列は切れない。

compaction を挟むペアは集計から除外し、除外件数を出力に含める。

gap は直前応答からの経過分とし、小数第4位に丸める。gap が負、または `input + cacheRead` が 0 のペアは除外する。

### ヒット率とビン

ヒット率は `cacheRead / (input + cacheRead)` とする。gap をビン境界で区切り、ビンごとに平均ヒット率とサンプル数を出す。

### 出力

標準出力には、次の順でサマリと2つのテーブルを出す。

| 行 | 内容 |
| --- | --- |
| 1 | `sessions analyzed: <件数>, period (file mtime): <最古日> .. <最新日>`。期間は対象ファイルの更新時刻の最古と最新を UTC の `YYYY-MM-DD` で示す |
| 2 | `pair samples: <件数> consecutive same provider+model responses (skipped by compaction: <件数>)` |
| 3 | `hit rate = cacheRead / (input + cacheRead), averaged per gap-to-previous-response bucket` |
| 4 | 見出し `per provider (all models merged):` と provider 別テーブル。provider 名は全モデルを統合して集計する |
| 5 | 見出し `top <件数> models:` とモデル別テーブル。モデル数が `--top` 未満のときは全モデルを出す |

テーブルは名前・`pairs`・各ビン列からなる。ビン列のラベルは境界から `0m-1m`・`1h-3h`・`>3h` の形式で作る。ビンセルは `98% ( 1913)` の形式で、平均ヒット率を整数% に丸め、括弧内にサンプル数を示す。サンプルがないビンは空セルにする。名前は 42 文字を超えると切り詰める。

`--csv` はヘッダ9列の CSV を書き出す。

| 列 | 内容 |
| --- | --- |
| `provider` | 応答を返した provider |
| `model` | 応答を返したモデル |
| `session` | セッションディレクトリ名 |
| `timestamp` | 応答時刻を UTC の ISO 8601 で示す |
| `gap_minutes` | 直前の同モデル応答からの経過分 |
| `input` | `usage.input` のトークン数 |
| `cache_read` | `usage.cacheRead` のトークン数 |
| `total_tokens` | `usage.totalTokens` のトークン数 |
| `hit_rate` | 丸めないヒット率 |

CSV は UTF-8、LF 改行、末尾改行付きとする。値にはカンマ・引用符・改行を含むときだけ引用符を付け、引用符は2連で表す。

対象ファイル 0 件、またはペア 0 件のときは stderr に `pi-stats:` 付きの理由を出す。

## stats モード

### キャッシュ DB

stats モードはセッションごとの集計結果を SQLite のキャッシュ DB に保存し、未変更のファイルを再パースしない。

| 項目 | 内容 |
| --- | --- |
| 場所 | `${XDG_CACHE_HOME:-~/.cache}/pi-stats/stats.db`。`--db PATH` で上書きできる |
| 更新単位 | セッションファイルごと。パス・mtime・size が登録済みの値と一致するときはスキップし、不一致・未登録のときは置き換える |
| 除去 | 対象走査に現れなくなったファイルの行は除去する |
| 全再構築 | DB を削除して全ファイルを再取り込みする |
| 初回 | 未登録のファイルをすべてパースする。全期間のデータ規模によっては数分以上かかる |

`--rebuild` と `--db` の指定方法は「入力」の表を参照する。取り込み件数は stderr に `pi-stats: indexed <新規・変更数> new/changed, removed <除去数>, total <総ファイル数> files` の形式で出す。

### 解析対象と集計対象

対象は `~/.pi/agent/sessions/` 配下のすべての `.jsonl` を再帰的に走査したものである。各プロジェクトディレクトリ直下と、`archive/`・`subagents/` などサブディレクトリ内を含む。`subagents/` 配下のファイルは、親セッションとは別のセッションとして数える。

各ファイルは、末尾エントリから `parentId` をたどった現行分岐だけを扱い、他分岐のエントリは集計に含めない。

usage イベントは、次の3種のエントリの usage である。`timestamp` のないエントリは集計から除外する。

| 種別 | 対象エントリ | usage・provider・model の位置 |
| --- | --- | --- |
| `message` | `message.role` が `assistant` のエントリ | `message` 内 |
| `usage` | `type` が `usage` のエントリ | エントリ直下 |
| `compaction` | `type` が `compaction` のエントリ | エントリ直下 |

コストは各 usage の `cost.total` の合計とする。`tokens` 列は各 usage の `totalTokens` の合計とする。

### 期間

| 期間 | 範囲 |
| --- | --- |
| `today` | ローカルタイムの今日 0 時以降 |
| `7 days` | 現在から過去 7×24 時間（ローリング） |
| `30 days` | 現在から過去 30×24 時間（ローリング） |
| `all` | フィルタ後の全期間 |

セッションの開始時刻は、`type` が `session` のエントリの `timestamp` とする。ない場合は最初の時刻付きエントリとする。すべての期間行・日別行は、フィルタ適用後のイベントから算出する。

### 入力

| 入力 | 結果 |
| --- | --- |
| `--since YYYY-MM-DD` | イベント時刻がこの日のローカル 0 時以降のイベントだけを集計する |
| `--until YYYY-MM-DD` | イベント時刻がこの日のローカル 0 時より前のイベントだけを集計する |
| `-p PREFIX` | プロジェクトディレクトリ名に PREFIX を含むセッションだけを集計する |
| `-m PATTERN` | `provider/model` に大文字小文字を無視して PATTERN を含むイベントだけを集計する |
| `--top N` | モデル別・プロジェクト別・セッション別テーブルの最大行数。N は正の整数。既定は 20 |
| `--days N` | 日別テーブルの日数。N は正の整数。既定は 14 |
| `--rebuild` | キャッシュ DB を削除して全ファイルを再取り込みする |
| `--db PATH` | キャッシュ DB の場所を PATH へ上書きする |

イベント時刻は各エントリの `timestamp` とし、ローカルタイムで判定する。`--until` は排他である。

### 出力

標準出力には、次の順でヘッダと5つのテーブルを出す。

| 行 | 内容 |
| --- | --- |
| 1 | `events: <件数>, span (event time): <最古日> .. <最新日> (UTC)`。期間は集計対象イベントの時刻の最古と最新を UTC の `YYYY-MM-DD` で示す |
| 2 | 見出し `overview (sessions = started in period):` と overview テーブル |
| 3 | 見出し `per provider/model (top by tokens):` とモデル別テーブル |
| 4 | 見出し `daily (local time, newest last):` と日別テーブル |
| 5 | 見出し `per project (top by cost, sessions = sessions with usage):` とプロジェクト別テーブル |
| 6 | 見出し `top sessions (by tokens):` とセッション別テーブル |

overview テーブルは `today`・`7 days`・`30 days`・`all` の4行を出す。

| テーブル | 列 | 備考 |
| --- | --- | --- |
| overview | `period`・`sessions`・`requests`・`input`・`output`・`cache read`・`cache write`・`hit%`・`cost` | `sessions` は期間内に開始されたセッション数。`requests` は usage イベント数 |
| モデル別 | `provider/model`・`sessions`・`requests`・`input`・`output`・`cache read`・`cache write`・`hit%`・`cost` | トークン数降順。`sessions` は usage のあるセッション数。provider・model がともに空のイベントは `(unknown)` にまとめる |
| 日別 | `date`・`sessions`・`requests`・`input`・`output`・`cache read`・`hit%`・`cost` | ローカルタイムの日付。今日を含む直近 `--days N` 日（既定 14）を古い順に出し、イベントのない日は 0 で埋める。`sessions` はその日に開始されたセッション数 |
| プロジェクト別 | `project`・`sessions`・`requests`・`tokens`・`hit%`・`cost` | コスト降順。`sessions` は usage のあるセッション数。プロジェクト名は先頭と末尾の `--` を除いて表示する |
| セッション別 | `started`・`project`・`top model`・`requests`・`tokens`・`cost` | トークン数降順。`started` は開始時刻をローカルタイムの `YYYY-MM-DD HH:mm` で示す。`top model` はそのセッションでトークン数が最大の `provider/model` |

hit% は、その行・セルのグループに含まれる全 usage の `cacheRead` 合計を `input + cacheRead` 合計で割った値であり、イベントごとのヒット率の平均ではない。

トークン数は 1,000 以上を `1.0k`、100 万以上を `2.3M`、10 億以上を `1.2B` の形式の圧縮表記にし、それ未満はそのまま出す。コストは `$` に小数4桁を付ける。hit% は整数% に丸め、`input + cacheRead` 合計が 0 のときは `—` を出す。集計対象のイベントが 0 件のときは span に `n/a` を出す。

集計対象のイベントが 0 件でも、stats モードは 0 埋めのテーブルを出して成功する。ただし対象走査にセッションファイルが 1 件もない場合は stderr に `pi-stats:` 付きの理由を出して終了コード 1 とする。

fork で作成されたセッションは元セッションと同一の過去エントリを持つため、両ファイルで重複計上される。

### 終了コード

| 状況 | 終了コード |
| --- | --- |
| 解析と出力の成功 | `0` |
| 対象ファイル 0 件、ペア 0 件、CSV 書き出し失敗、DB 操作の失敗 | `1` |
| 引数の誤り | `2` |
