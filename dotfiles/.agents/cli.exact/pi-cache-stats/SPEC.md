# pi-cache-stats

`pi-cache-stats` は pi のセッションファイルから provider・モデル別のプロンプトキャッシュの維持時間を測定する独立CLI。利用者と保守担当者が、コマンドの入出力・集計方法・終了コードを確認するための振る舞い正本である。

## コマンド

| 入力 | 結果 |
| --- | --- |
| `pi-cache-stats` | セッション全体を解析し、provider 別とモデル別のサマリを出す |
| `-n N` | ファイル更新時刻が新しい方から N 件のセッションだけを解析する |
| `--since YYYY-MM-DD` | 更新日がこの日以降（UTC）のセッションだけを解析する |
| `--until YYYY-MM-DD` | 更新日がこの日より前（UTC）のセッションだけを解析する |
| `-p PREFIX` | セッションディレクトリ名に PREFIX を含むセッションだけを解析する |
| `-m PATTERN` | `provider/model` に大文字小文字を無視して PATTERN を含むペアだけを集計する |
| `--bins MIN[,MIN...]` | gap のビン境界を分で指定する。値は正かつ昇順であること。既定は `1,5,15,30,60,180` |
| `--top N` | モデル別テーブルに表示するモデル数。既定は 12 |
| `--csv PATH` | ペアごとの生データを CSV で PATH へ書き出す |
| `-h` | 使用方法を出す |
| 不正な引数 | stderr に `pi-cache-stats:` 付きの理由と使用方法を出す |

`-n`・`--since`・`--until`・`-p` は選択条件で、複数指定した場合はすべての条件を満たすセッションを解析する。

## 解析対象とペア

対象は `$HOME/.pi/agent/sessions/` 配下の JSONL セッションファイルである。読み取り不能・不正JSON のファイルは集計から除外し、警告を出さない。

各ファイルは、末尾エントリから `parentId` をたどった現行分岐だけを扱い、他分岐のエントリは集計に含めない。

ペアは、同一セッション内の assistant 応答と、その直前の同 provider・同モデルの assistant 応答の組である。provider・model・時刻のない assistant 応答は系列から除外する。

`-m` を指定したときは、一致しない応答を系列から除いた上で、直前の同モデル応答とペアを作る。一致しない応答が挟まっても系列は切れない。

compaction を挟むペアは集計から除外し、除外件数を出力に含める。

gap は直前応答からの経過分とし、小数第4位に丸める。gap が負、または `input + cacheRead` が 0 のペアは除外する。

## ヒット率とビン

ヒット率は `cacheRead / (input + cacheRead)` とする。gap をビン境界で区切り、ビンごとに平均ヒット率とサンプル数を出す。

## 出力

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

対象ファイル 0 件、またはペア 0 件のときは stderr に `pi-cache-stats:` 付きの理由を出す。

## 終了コード

| 状況 | 終了コード |
| --- | --- |
| 解析と出力の成功 | `0` |
| 対象ファイル 0 件、ペア 0 件、CSV 書き出し失敗 | `1` |
| 引数の誤り | `2` |
