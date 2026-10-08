# model-route

`model-route` は、agent 名または class 名で実効 class を指定し、使用モデルを選ぶ CLI である。pi・dsh を含む呼び出し元が、選択された provider と model を個別に利用できる入出力を定める。

選択の根拠は `~/.agents/config/agents.yaml` の候補順と `when` の評価結果である。モデル登録状況・認証・cooldown の確認と、モデルの適用・推論実行は呼び出し元が担う。

## 入力

```sh
model-route (--agent <name> | --class <name>)
```

2つの引数は排他であり、どちらか一方を必ず指定する。

| 引数 | 値 | 用途 |
| --- | --- | --- |
| `--agent` | 設定に存在する単一の agent 名 | `agents.<name>` の class を実効 class とする |
| `--class` | 設定に存在する class 名 | その class を実効 class とする。`agents` は参照しない |

名前は設定のキーと完全一致で照合する。

## 設定

実行ごとに、そのユーザーのホームディレクトリにある `.agents/config/agents.yaml` を読む。ルーティングに必要な項目は次の通りである。

| 項目 | 必要な値 |
| --- | --- |
| `agents` | agent 名をキーとするマッピング |
| `agents.<name>` | マッピング |
| `agents.<name>.class` | `classes` に存在する class 名の非空文字列 |
| `classes` | class 名をキーとするマッピング |
| `classes.<name>` | 順序付きの候補配列。無条件 fallback 候補を少なくとも1つ含む |
| 候補の `provider` | 非空文字列 |
| 候補の `model` | 非空文字列 |
| 候補の `when` | 省略または文字列 |

`when` が省略・空文字列・空白だけの候補を、無条件 fallback 候補と呼ぶ。各 class の全候補と各 agent の class 参照を、選択前に検証する。この検証は指定した引数によらず設定全体に対して行う。上表以外の項目はルーティングの判断・検証に使わない。

`provider` と `model` は設定の文字列値を保持する。`model` 内の `/` もモデル名の一部として扱う。

## 選択

実効 class の候補を配列の先頭から順に評価し、最初に成立した候補を選ぶ。成立後の候補は評価しない。

| 候補の条件 | 評価 | 結果 |
| --- | --- | --- |
| `when` が省略・空文字列・空白だけ | コマンド実行なし | 候補成立 |
| 非空の `when` が制限時間内に終了コード0で終了 | bash コマンドを実行 | 候補成立 |
| 非空の `when` が終了コード0以外で終了、実行に失敗、またはタイムアウト | bash コマンドを実行 | その候補を飛ばして次候補へ進む |

`when` は条件名ではなくコマンド文字列として扱う。呼び出し時の作業ディレクトリと環境変数を引き継ぎ、各コマンドの制限時間は5秒とする。コマンドの標準出力・標準エラー出力は破棄し、成立判定には終了状態を使う。設定には、実行してよい信頼済みのコマンドを置く。

候補の成立条件は行ごとに評価する。同じ provider と model の候補が複数あっても、ある行の条件不成立は別の行を除外しない。

## 出力と終了コード

| 結果 | 標準出力 | 標準エラー出力 | 終了コード |
| --- | --- | --- | --- |
| 候補を選択 | 選択候補の `provider` と `model` だけを持つJSON objectを1行で出力し、末尾に改行1つ | 空 | 0 |
| 不正入力 | 空 | 原因を示すエラーメッセージ | 1 |
| 設定エラー | 空 | 設定ファイルのパスと原因を示すエラーメッセージ | 1 |
| 候補全滅 | 空 | 指定した引数と実効 class 名、候補を選べなかったことを示すエラーメッセージ | 1 |

不正入力には、`--agent` と `--class` の同時指定、両方の欠損、引数値の欠損、未定義の agent・class、未対応の引数を含む。設定エラーには、読取失敗・不正なYAML・設定項目の型不正・class参照不正・無条件fallback欠如を含む。

有効な設定には無条件 fallback があるため、通常の選択は候補全滅にならずに成立する。

## 例

次の設定で `model-route --agent junior` を実行する。

```yaml
agents:
  junior:
    class: low
classes:
  low:
    - provider: primary
      model: model-a
      when: "false"
    - provider: backup
      model: family/model-b
```

最初の候補は条件不成立となり、無条件 fallback を選ぶ。終了コードは0、標準出力は次のJSONと末尾改行になる。`model-route --class low` も同じ JSON を出力する。

```json
{ "provider": "backup", "model": "family/model-b" }
```
