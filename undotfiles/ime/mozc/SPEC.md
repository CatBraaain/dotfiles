# Mozc 設定管理

対象は、TypeScriptで宣言したローマ字表をMozc用のローマ字テーブルTSVへコンパイルし、キーマップTSVとともに `config1.db` へ合成して適用する機能である。利用者は、このリポジトリでWindows環境のMozc設定を管理するユーザーである。宣言の記法と集約の規則は `../SPEC.md` の「ローマ字表の宣言」に従い、このspecでは記述しない。

`just mozc` は、設定の適用（`mozc/roma-def.ts` を引数なしで実行）である。`just mozc diff` は、設定の差分（`mozc/roma-def.ts` に `--dry-run` を付けて実行）を表示する。

`config1.db` は `mozc.config.Config` メッセージのproto2 wire形式であり、`%USERPROFILE%\AppData\LocalLow\Mozc\config1.db` に配置される。この機能は管理フィールドのwireレコードを直接読み書きし、外部のコンパイラは使わない。管理フィールドは `session_keymap`（フィールド番号41、enum `SessionKeymap`、`CUSTOM` は0）、`custom_keymap_table`（42、bytes）、`custom_roman_table`（43、bytes）である。

## 用語

- キーマップレコード: `状態\tキー\tコマンド` の3列からなる、キーマップTSVの1行。
- 管理フィールド: `config1.db` のうち、この機能が書き込む `session_keymap`、`custom_keymap_table`、`custom_roman_table` の3つのフィールド。

## ローマ字テーブルのコンパイル

コンパイルは、宣言が構成したマッピング集合をUTF-16コード単位順にソートした `ローマ字\tかな` レコード列へ変換する。コンパイル結果は宣言の内容だけで決まり、OS設定を変更しない。Mozcのローマ字テーブルは最長一致で入力を消費するため、MS-IME用の `行キー\=行キー` レコードに相当する子音単独エントリは生成しない。

### 振る舞い

| Given | When | Then |
|---|---|---|
| 有効なTypeScript宣言 | コンパイルする | 宣言が対応付けたすべてのマッピングを `ローマ字\tかな` レコードとして含める。出力はこれらのみを含める。 |
| ローマ字キーまたはかな値にTAB、CR、LF、NULを含む宣言 | コンパイルする | 禁止文字を示して失敗し、完成した出力を生成せず、OS設定を変更しない。 |

## キーマップテーブル

`keymap.tsv` は、Mozc内蔵のMS-IMEキーマップ（google/mozcの `data/keymap/ms-ime.tsv`）と同一の内容から、次の2行だけを変更したTSVである。

- `Composition` の `Henkan` 行を `Convert` から `DisplayAsFullKatakana` へ変更する。
- `Conversion` の `Henkan` 行を `ConvertNext` から `DisplayAsFullKatakana` へ変更する。

変換キーは入力文字列を全角カタカナ表示にして確定待ちにする（MS-IMEのF7相当）。全角半角キーは、`DirectInput` で `IMEOn`、`Precomposition`・`Composition`・`Conversion` で `IMEOff` であり、すべての状態でIMEを切り替える。SuggestionとPredictionは、それぞれ `Composition` と `Conversion` のキーマップに従う。

### 振る舞い

| Given | When | Then |
|---|---|---|
| keymap.tsv | 読み込む | `#` で始まる行と空行を除いた各行をキーマップレコードとして扱う。3列でない行があればその行を示して失敗し、設定を適用しない。キーマップレコードが1件もなければ失敗し、設定を適用しない。 |
| keymap.tsv の内容 | config1.db へ書き込む | 内容をそのまま `custom_keymap_table` に設定する。キーマップレコードの妥当性はこの機能では検証せず、Mozcがキーマップを読み込むときに判断する。 |
| keymap.tsv | Mozcが読み込む | Mozcは `custom_keymap_table` の先頭行を読み飛ばす。このTSVは先頭行を説明コメントに使うため、キーマップレコードの前に `状態\tキー\tコマンド` のヘッダ行を置く。ヘッダ行は未知の状態名としてMozcに無視され、キーマップには影響しない。 |

## config1.db の生成と適用

適用は、ローマ字テーブルとキーマップテーブルを管理フィールドとして `config1.db` に書き込み、`%USERPROFILE%\AppData\LocalLow\Mozc\config1.db` へ配置する。現在の `config1.db` があるときは、管理フィールドだけを新しい内容に差し替え、それ以外のフィールドをバイト列のまま保持する。現在の `config1.db` がないときは、管理フィールドだけからなる `config1.db` を新規に生成する。

### 振る舞い

| Given | When | Then |
|---|---|---|
| 正常にコンパイルできる宣言とkeymap.tsv、かつ現在の `config1.db` がある環境 | 適用する | 現在の `config1.db` を解析し、`session_keymap` の変更、キーマップレコードの追加・除去、ローマ字マッピングの追加・除去、または変更がない旨をフィールドごとに表示してから、管理フィールドを新しい内容にした `config1.db` を生成して配置する。配置の前に現在の `config1.db` をtempディレクトリへバックアップし、バックアップ先のパスを表示する。管理フィールド以外のフィールドはバイト列のまま保持される。 |
| 正常にコンパイルできる宣言とkeymap.tsv、かつ現在の `config1.db` がない環境 | 適用する | 現在の設定がない旨と、ローマ字マッピングがすべて追加対象であることを表示してから、管理フィールドだけからなる `config1.db` を配置する。キーマップレコードの個別表示はしない。バックアップは作らない。 |
| `config1.db` の配置先ディレクトリがない環境 | 適用する | ディレクトリを作成して配置する。 |
| `config1.db` があるが、管理フィールドの一部が未設定の環境 | 適用または差分を実行する | 未設定の管理フィールドについて、その旨と追加対象であることを表示する。適用では、未設定の管理フィールドを追加した `config1.db` を配置する。 |
| `config1.db` があるが、バックアップの作成が失敗する環境 | 適用する | バックアップの失敗を示して失敗し、`config1.db` を変更しない。 |
| `config1.db` の読み取りまたはwire解析に失敗する環境 | 適用または差分を実行する | 失敗した旨を示して終了し、`config1.db` を変更しない。 |
| 有効な入力がある環境 | `--dry-run` を付けて実行する | 適用と同じ差分を表示し、OS設定を変更しない。 |
| 正常にコンパイルできる宣言 | `--preview` を付けて実行する | OS設定を変更せず、コンパイルした `ローマ字=かな` レコードの一覧とマッピング件数を表示する。 |
| `apply` または `diff` 以外のモード引数を指定する | `just mozc <mode>` を実行する | 指定したモード値を示して失敗し、OS設定を変更しない。 |

## 未確定事項

- 適用後、Mozcのプロセスが `config1.db` を再読み込みする条件（再起動の要否）。Mozcインストール後に確認する。
