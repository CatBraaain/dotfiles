# readable-coding 出典資料

このフォルダ（`sources.ignore/`）は `dotfiles-manager` の build で dist へコピーされない開発資料。SKILL.md のカタログを開発・調整するときの参照用であり、展開先の `~/.agents/skills/` には配布されない。

助言IDの体系:

| prefix | 出典 |
| --- | --- |
| `RC<n>.<m>` | The Art of Readable Code 第 `n` 章の `m` 番目の助言 |
| `CC<n>.<m>` | Clean Code 第 `n` 章の `m` 番目の助言 |
| `CO<n>.<m>` | Code Complete 第2版（COmplete）第 `n` 章の `m` 番目の助言 |
| `RF-<name>` | Refactoring 第2版のカタログ（refactoring.com） |
| `CCJ<n>.<m>` | clean-code-javascript Ch `n` の `m` 番目の助言 |
| `CCT<n>.<m>` | clean-code-typescript Ch `n` の `m` 番目の助言 |

本文書の各要約は原書の逐語転載ではなく、内容をこの skill の開発用に自前で言い換えたもの。原文は各出典を参照すること。章番号は各書の構成に基づく。監査反映で追加した項目には正本未確認の節番号・便宜番号を含み、正本確認後に振り直す。

判定種別（観点マトリクスの「判定」列）:

| 判定 | 意味 |
| --- | --- |
| 採用 | SKILL.md の項目として収録されている |
| 採用（背景） | 項目化されていないが、カタログ全体の前提として反映 |

未採用の助言はマトリクス直下の「未採用の助言」で理由付きで管理する。

## 観点マトリクス

6ソースの全助言と SKILL.md の対応表。行が SKILL.md の項目（A1〜I5、SKILL.md の記載順）で、列がソース。セルはその項目の根拠助言ID（列ヘッダの prefix を省略した `n.m` 形式、RF 列のみカタログ名）。`*` 付きは包含（その項目の適用例の一部として暗黙に含まれる）。各助言は必ず1つの行だけに現れ、未採用の助言は下位節の未採用リストに置く。

行の末尾に、項目化されない前提（採用（背景）とカテゴリ単位の包含・採用）を1行にまとめて置く。

SKILL.md の I4（出典のない回避コメント）と D10（const に入れた arrow function）は出典を持たない独自項目のため、ソース列がすべて空の行としている。

| 項目ID | 項目 | RC | CC | CO | RF | CCJ | CCT | 判定 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A1 | 抽象名 | 2.2 | 2.1, 2.3, 2.11* | 11.1, 11.6 |  | 1.1 | 1.1 | 採用 |
| A2 | 単位が読めない名前 | 2.4 |  | 11.4* |  |  |  | 採用 |
| A3 | 検証状態が読めない名前 | 2.5* |  |  |  |  |  | 採用 |
| A4 | 真偽が読めない名前 | 2.6 |  | 11.5* |  |  |  | 採用 |
| A5 | 二重否定 | 2.7 |  |  |  | 2.13 | 2.13 | 採用 |
| A6 | 範囲の包含が不明な名前 | 3.2, 3.3 |  |  |  |  |  | 採用 |
| A7 | 意図が一意でない名前 | 3.1 | 2.2* |  |  |  |  | 採用 |
| A8 | 一貫しない語彙 |  | 2.9, 17.4 |  | change-function-declaration* | 1.2 | 1.3 | 採用 |
| A9 | 曖昧な動詞 | 2.1 | 3.7* | 7.7 |  | 2.3 | 2.3 | 採用 |
| A10 | 出所が読めない取得動詞 | 3.4 |  |  |  |  |  | 採用 |
| A11 | 副作用が読めない動詞 |  | 17.1* |  |  |  |  | 採用 |
| A12 | 発音でき検索できる名前 | 2.3* | 2.4, 2.5, 2.8* | 16.4* |  | 1.3, 1.5* | 1.2, 1.4, 1.6* | 採用 |
| A13 | 冗長な型接頭辞を避ける |  | 2.6 |  |  | 1.6* | 1.7* | 採用 |
| B1 | 複雑な条件は変数で受ける | 8.1, 8.2, 8.3, 8.5* | 17.2* | 12.1, 19.1 | decompose-conditional, extract-variable | 1.4, 2.12 | 1.5, 2.12 | 採用 |
| B2 | magic number | 5.3* |  | 11.7, 12.3 |  |  |  | 採用 |
| B3 | 同じ条件の繰り返し |  |  |  |  |  |  | 採用 |
| B4 | 同じ結果の条件をまとめる |  |  |  | consolidate-conditional-expression |  |  | 採用 |
| B5 | magic string・boolean 羅列は enum で意図を語る |  |  | 12.2 |  |  | 1.9 | 採用 |
| C1 | 深いネスト | 7.4 | 3.2* | 16.3*, 19.3 | remove-control-flag, replace-nested-conditional-with-guard-clauses |  |  | 採用 |
| C2 | 条件の向き | 7.1 |  |  |  |  |  | 採用 |
| C3 | 末尾条件のループ | 7.3 |  | 16.2 |  |  |  | 採用 |
| C4 | 式の中に副作用を隠さない | 8.4 |  |  |  |  |  | 採用 |
| C5 | 配列の選別・加工はパイプラインで |  |  |  | replace-loop-with-pipeline |  |  | 採用 |
| D1 | 副作用の混入 |  | 3.12, 3.13 | 7.6 | separate-query-from-modifier | 2.8, 2.9 | 2.8, 2.9 | 採用 |
| D2 | 長い関数の分割 | 10.1, 10.2*, 10.3*, 11.1, 11.2 | 3.1, 3.3, 3.4, 17.3 | 7.2, 7.4* | extract-function, split-phase | 2.2, 2.4 | 2.2, 2.4 | 採用 |
| D3 | booleanフラグ引数 |  | 3.9 |  | remove-flag-argument | 2.7 | 2.7 | 採用 |
| D4 | 引数が多すぎる |  | 3.8, 3.10* |  | introduce-parameter-object | 2.1 | 2.1 | 採用 |
| D5 | エラー処理の分離 |  | 3.15, 7.2* |  |  |  |  | 採用 |
| D6 | 未使用の変数・引数の削除 |  |  |  |  |  |  | 採用 |
| D7 | 例外に文脈を付ける |  | 7.4 |  |  |  |  | 採用 |
| D8 | 省略可能引数はデフォルト値で受ける |  |  |  |  | 1.7, 2.6* | 1.8, 2.6* | 採用 |
| D9 | catch を握りつぶさない |  |  | 8.1 |  | 8.1, 8.2 | 8.2, 8.3 | 採用 |
| D10 | const に入れた arrow function |  |  |  |  |  |  | 採用 |
| E1 | 宣言位置 | 9.2 |  | 10.2 | slide-statements |  |  | 採用 |
| E2 | スコープを狭める |  |  | 10.1 |  |  |  | 採用 |
| E3 | 再代入 | 9.3 |  |  |  |  | 3.3* | 採用 |
| E4 | 無意味な中間変数 | 9.1 |  |  | inline-variable |  |  | 採用 |
| E5 | 変数の使い回し | 9.4 |  | 7.5, 10.3 | split-variable |  |  | 採用 |
| F1 | 読み順 | 4.2* | 3.5*, 5.1 | 14.3 |  | 9.2 | 9.3 | 採用 |
| F2 | 初期化順 |  |  | 14.1, 14.2* |  |  |  | 採用 |
| F3 | 段落分け | 4.1*, 4.5 |  | 31.1*, 31.2 |  |  |  | 採用 |
| F4 | 死んだコード | 13.3 | 4.4 |  | remove-dead-code | 2.18, 10.2 | 2.17, 10.2 | 採用 |
| F5 | 不要な間接化 |  |  |  | inline-function |  |  | 採用 |
| F6 | 重複の抽出 |  | 3.16 |  | consolidate-duplicate-conditional-fragments* | 2.5 | 2.5 | 採用 |
| G1 | テスト名 | 14.3 |  |  |  |  | 6.4 | 採用 |
| G2 | 1テスト1振る舞い | 14.4, 15.1* | 9.3 |  |  | 6.1 | 6.3 | 採用 |
| G3 | 失敗メッセージ | 6.2*, 14.2* |  |  |  |  |  | 採用 |
| H1 | 不要な依存 | 13.2, 13.4 |  |  |  |  |  | 採用 |
| H2 | 賢いワンライナー |  |  |  | substitute-algorithm* | 2.17 | 2.16 | 採用 |
| H3 | 抽象の先取り |  |  |  |  |  |  | 採用 |
| I1 | 意図説明コメント | 5.1 | 4.3 | 32.3 |  | 10.3, 10.4 | 10.3, 10.4 | 採用 |
| I2 | 説明変数で消せるコメント |  |  |  |  |  |  | 採用 |
| I3 | 出典付きの回避コメント |  | 4.2 |  |  |  |  | 採用 |
| I4 | 出典のない回避コメント |  |  |  |  |  |  | 採用 |
| I5 | 乖離したコメント |  |  |  |  |  |  | 採用 |
| — | カタログ全体の前提 | 1.1, 1.2, 5.2*, 5.4*, 6.1, 6.4*, 7.5, 7.6, 13.1, 14.1 | 4.1, 9.2, 12.3 | 7.1, 32.1, 32.2 | rename-variable, replace-inline-code-with-function-call |  | 10.1 | 採用（背景） |

### 未採用の助言

SKILL.md カタログに採用しなかった助言。主題（観点マトリクス改編前の観点名）ごとにまとめる。

| 主題 | 助言 | 理由 |
| --- | --- | --- |
| 名前はスコープ・文脈・規約に合わせた形にする | RC2.8 | 規約の所在は言語規約・リンター・プロジェクト AGENTS.md |
|  | RC2.9 | 長さの数値基準は持たない。A1 の具体名原則で自然に担保 |
|  | CC2.7 | 品詞の慣習は言語規約・リンター領域。動詞選択は A9-A11 で採用 |
|  | CO11.3 | 文字数の数値基準は持たない |
|  | CO11.8 | 言語規約の所在はプロジェクト・リンター |
| 誤解を招く名前を避ける | RC3.5 | 候補並列比較はレビュー手法であり、成文ルールにできない |
| 抽象名より具体名を選ぶ | RC2.10 | 具体名の選択は RC2.1・RC2.2 と A1 の適用例として包含。新規の観点は持たない |
|  | RC2.11 | 語彙を探す手続きは RC2.1 の補足。観点は RC2.1/A9 が既に持つ |
| 整形は一貫した規約に任せる | RC4.3 | 縦整列は prettier 等フォーマッタ領域。手整形規約にしない |
|  | RC4.4 | 並び順の統一は言語規約・フォーマッタ領域 |
|  | RC4.6 | コメントは原則禁止（I）のため位置規約が不要 |
|  | RC4.7 | 列順の一貫性は個別判断。項目化しない |
|  | CC5.2 | 行長・折り返しはフォーマッタ領域 |
|  | CC5.3 | チーム規約の所在はプロジェクト AGENTS.md |
|  | CCJ9.1 | 大文字小文字の規約はフォーマッタ・言語規約領域 |
|  | CCT9.1 | ツールチェーン整備は本 skill の対象外 |
|  | CCT9.2 | フォーマッタ・言語規約領域 |
|  | CCT9.4 | import 整理はフォーマッタ・リンター領域 |
|  | CCT9.5 | パスエイリアスはビルド設定領域 |
|  | RC4.8 | 処理の見た目と意味のまとまりの一致は RC4.1 に包含。整形の細目はフォーマッタ領域 |
|  | CC10.1 | クラス内の構成順は言語規約・フォーマッタ領域。精神は F1 が担保 |
| コメントすべきものだけを書く | RC5.5 | ファイル概要コメントは I の原則と競合。F1 の読み順で構造が語る |
|  | RC5.6 | TODO・FIXME は ticket で管理。コメントに残さない |
|  | CCT10.5 | TODO は ticket で管理。コメントに残さない |
| コメントは正確で簡潔に書く | RC6.3 | 名前付き引数・D4 のオブジェクト引数で解決する |
| 条件は読み手の自然な向きと順序に置く | RC7.2 | if/else の順序は判断が案件依存。C1・C2 で主要な効果を担保 |
|  | CO15.1 | if/else の順序は判断が案件依存（RC7.2 と同様） |
| コードの価値は理解の速さで測る | CC1.1 | RC1.1/1.2 と同一内容で、カタログ全体の前提として重複 |
| 素直で構造化されたコードを書く | RC12.1 | 設計プロセスの助言。カタログはコードの形の判定集 |
|  | CO17.1 | 小さい関数前提では早期return・ガード節（C1）を積極採用しており、警告と逆向き。C1 を優先 |
|  | CO17.2 | 再帰は対象コードで頻出しない |
|  | CO17.3 | goto は対象言語にほぼ不存在 |
|  | CO19.4 | 構造化プログラミングは現代言語のデフォルト前提 |
|  | CO19.6 | 空文はリンター（no-empty 系）が担う |
|  | RC12.2 | 問題の言い換えは設計プロセスの助言。RC12.1 と同様 |
| ケーススタディは既存技法の適用例として扱う | CC14.1 | 動くコードから段階的に整理する実演。個別操作は I5/E4/F4 の適用例 |
|  | CC15.1 | 古い JUnit を読みやすくする実演。新規観点なし |
| テストの入力は最小限で具体的にする | RC14.5 | 入力値の設計判断は文脈依存。形式規約に含めない |
|  | RC14.6 | 網羅 vs 維持の判断はプロジェクトのQA規約が担う |
|  | CO22.1 | 境界条件の入力設計は文脈依存（RC14.5/14.6 と同理由） |
| テストも読みやすさの対象にする | RC14.7 | AGENTS.md が自作helper禁止（node:assert/strict 使用）を定める。G3 の説明変数で担保 |
| テストは1概念に絞り、独立に走らせる | RC15.2 | テスト基盤の構成はプロジェクト依存 |
|  | CC9.1 | プロセス規約は本 skill の対象外 |
|  | CC9.4 | テストの実行性質はプロジェクト構成依存 |
|  | CCT6.1 | プロセス規約（CC9.1 と同理由） |
|  | CCT6.2 | テストの実行性質はプロジェクト構成依存（CC9.4 と同理由） |
|  | CC8.2 | 学習テストはプロセス規約（CC9.1 と同理由） |
|  | CC12.1 | 全テストを通す規則はプロセス規約（CC9.1 と同理由） |
| 単純設計の規則は既存の観点とプロセス規約で担保する | CC12.2 | 重複なしの規則は CC3.16（F6 重複の抽出）と同義 |
|  | CC12.4 | クラス・メソッドの最小化は設計判断。精神は H2/H3 が担保 |
| 語彙は概念ごとに1つに統一する | CC2.10 | 語彙の選択源は A1 の具体名原則に包含 |
|  | CO11.2 | A1 の具体名原則に包含 |
| 同種の分岐は表や多態で構造化する | CC3.6 | 多態への置換は OOP 設計判断。H3 に抵触しうる |
|  | CCJ2.14 | 多態への置換は OOP 設計判断（CC3.6 と同理由） |
|  | CCT2.14 | 多態への置換は OOP 設計判断 |
|  | CO15.2 | case・表駆動の選択は設計判断。B4 で主要効果を担保 |
|  | CO15.3 | 分岐の並び順基準は案件依存 |
|  | CO19.2 | 表駆動は設計判断。B1-B4 の式レベル整理で担保 |
|  | CO19.5 | 制御文の順序基準は案件依存 |
|  | RF-replace-conditional-with-polymorphism | 多態への置換は OOP 設計判断（CC3.6・CCJ2.14・CCT2.14 と同理由） |
| 引数は少なく、役割が読める形にする | CC3.11 | キーワード引数・D4 で代替 |
|  | CO7.8 | 引数順の統一は規約・設計判断寄り（D4 の領域） |
|  | RF-preserve-whole-object | オブジェクトごと渡す引数の形は D4 の判断軸。結合度とのトレードオフは設計判断 |
| エラー処理は例外で正常系から追い出す | CC3.14 | エラーコード vs 例外は言語慣習依存。D5・D7 で読みやすさ効果を採用 |
|  | CC7.1 | CC3.14 と同理由 |
|  | CC7.3 | Java 固有の議論 |
|  | RF-replace-exception-with-precheck | 例外 vs 事前チェックは言語慣習・契約設計依存。D5・D7 で読みやすさ効果を採用 |
| null と特殊ケースは一元化する | CC7.5 | null 返却禁止は言語・型システム依存。A3 の名前による区別で安全を見える化 |
|  | CC7.6 | 同上 |
|  | RF-introduce-special-case | A3 の名前による区別で足りる場面が多く、パターン追加は H3 に抵触しうる |
| 副作用を分離し、コマンドとクエリを分ける | CCJ2.10 | グローバル汚染は言語・モジュール設計の領域 |
|  | CCT2.10 | グローバル汚染は言語・モジュール設計の領域 |
|  | CO13.3 | グローバルデータの回避は言語・モジュール設計の領域（CCJ2.10/CCT2.10 と同理由） |
| 宣言型の式と型システムで意図を語る | CCJ2.11 | パラダイムの選好は設計判断。C4・E4 の個別技法で読みやすさ効果を採用 |
|  | CCJ2.15 | 型判定の多態置換は設計判断 |
|  | CCJ2.16 | 同上 |
|  | CCT2.11 | パラダイムの選好は設計判断 |
|  | CCT2.15 | 型システム活用の細目は言語固有。B5 で意図表現を採用 |
|  | CCT2.18 | イテレータ・ジェネレータの採用は設計判断 |
| 前提条件は型と言語機能で語る | RF-introduce-assertion | 前提の表明は言語依存が強い。TS では型・早期 throw・B5 で担保するのが I 節の方針 |
| カプセル化で契約と実装を分ける | CCJ3.1 | カプセル化は OOP 設計判断。H3 に抵触しうる |
|  | CCJ3.2 | 同上 |
|  | CCT3.1 | カプセル化は OOP 設計判断 |
|  | CCT3.2 | 同上 |
|  | CCT3.4 | type vs interface は言語細目 |
|  | CC6.1 | データ抽象は OOP 設計判断（CCJ3.1/3.2 未採用と同理由） |
|  | CC6.2 | 手続き型と OOP のパラダイム選好は設計判断 |
|  | CC6.3 | 列車衝突の回避はカプセル化の再設計を伴う。中間変数で受ける緩和は B1 が近似 |
|  | CC6.4 | オブジェクトとデータ構造の混在回避は設計判断 |
|  | CC6.5 | visitor 等のパターン選択は設計判断 |
|  | CC8.1 | 第三者コードの境界ラップは設計判断。H3 に抵触しうる |
|  | RF-encapsulate-variable | 変数のアクセサ化は OOP 設計判断。主要効果は E2 が担保 |
|  | RF-encapsulate-record | レコードのクラス化はデータ構造の設計判断。H3 に抵触しうる |
|  | RF-encapsulate-collection | コレクション公開の回避はインターフェース設計判断 |
|  | RF-hide-delegate | 委譲先の隠蔽はモジュール間の設計判断 |
|  | RF-remove-middle-man | 過剰な委譲メソッドの除去はモジュール間の設計判断 |
|  | RF-replace-function-with-command | コマンドオブジェクトへの置き換えは OOP 設計判断。H3 に抵触しうる |
|  | RF-replace-constructor-with-factory-function | 生成方法の隠蔽は設計判断 |
| 値オブジェクト化は設計判断に委ねる | RF-replace-primitive-with-object | フルの Value Object 化は設計判断。軽量版は B5 と A2 で採用済み |
|  | RF-change-reference-to-value | 参照 vs 値は設計・言語判断 |
|  | RF-change-value-to-reference | 同上 |
| クラスとモジュールは小さく保つ | CCJ4.1 | クラス構文の選択は言語・設計領域 |
|  | CCJ4.2 | fluent API は API 設計判断。D1 と競合しうる |
|  | CCT4.1 | クラス設計の原則。D2 は関数レベルで採用 |
|  | CCT4.4 | fluent API は設計判断 |
|  | CC10.2 | クラスの小ささ（SRP）は設計判断（CCJ4.1 未採用と同理由）。D2 は関数レベルで採用済み |
|  | CC10.3 | クラスの凝集は設計判断 |
|  | RF-extract-class | クラスの責務分割は設計判断。D2 は関数レベルで採用。H3 に抵触しうる |
|  | RF-inline-class | 機能を失ったクラスの統合は設計判断 |
| コードの移動と統合は構造判断で個別に扱う | RF-move-function | 置き場所はモジュール構造の設計判断。ファイル内の読み順は F1 が担保 |
|  | RF-move-field | 同上 |
|  | RF-move-statements-into-function | 関数へ移す文の判断は F1・F3 の軸で個別対応 |
|  | RF-move-statements-to-callers | 同上 |
|  | RF-parameterize-function | 似た関数の統合は D3 と緊張関係にあり案件依存。F6 の判断軸で個別対応 |
| 継承よりコンポジションで組み合わせる | CCJ4.3 | 継承 vs コンポジションは設計判断 |
|  | CCT4.3 | 継承 vs コンポジションは設計判断 |
|  | RF-replace-subclass-with-delegate | 継承 vs 委譲は設計判断（CCJ4.3/CCT4.3 の未採用理由と同じ） |
|  | RF-replace-superclass-with-delegate | 同上 |
| 継承階層の整理は設計判断に委ねる | RF-pull-up-method | 継承階層間の移動は設計判断。SOLID 系未採用（CCJ5.x/CCT5.x）と同方針 |
|  | RF-pull-up-field | 同上 |
|  | RF-pull-up-constructor-body | 同上 |
|  | RF-push-down-method | 同上 |
|  | RF-push-down-field | 同上 |
|  | RF-replace-type-code-with-subclasses | 階層の新設は設計判断 |
|  | RF-extract-subclass | 同上 |
|  | RF-extract-superclass | 同上 |
|  | RF-extract-interface | 同上 |
|  | RF-collapse-hierarchy | 階層の統合は設計判断 |
| SOLID の原則を守る | CCJ5.1 | SOLID はクラス設計の原則。本 skill は関数・式レベルの可読性が対象。H3 に抵触しうる |
|  | CCJ5.2 | 同上 |
|  | CCJ5.3 | 同上 |
|  | CCJ5.4 | 同上 |
|  | CCJ5.5 | 同上 |
|  | CCT5.1 | SOLID はクラス設計の原則。H3 に抵触しうる |
|  | CCT5.2 | 同上 |
|  | CCT5.3 | 同上 |
|  | CCT5.4 | 同上 |
|  | CCT5.5 | 同上 |
|  | CC10.4 | 変更からの隔離（DIP）は設計判断 |
| システムの構築と進化はアーキテクチャ設計に委ねる | CC11.1 | 構築と使用の分離はアーキテクチャ領域 |
|  | CC11.2 | 依存性注入は設計判断 |
|  | CC11.3 | スケールアップの判断はプロセス・アーキテクチャ領域 |
| 非同期は読める直列の形で書く | CCJ7.1 | 並行処理の書式は言語・実行環境依存 |
|  | CCJ7.2 | 同上 |
|  | CCT7.1 | 並行処理の書式は言語・実行環境依存 |
|  | CCT7.2 | 同上 |
|  | CC13.1 | 並行性防御原則は言語・実行環境依存（CCJ7.1/7.2 未採用と同理由） |
|  | CC13.2 | 同期ブロックの最小化は並行固有。精神は D2 が担保 |
| コメントすべきでないものを書かない | CCJ10.1 | 業務ロジックへのコメント許可は I の原則より緩い。構造と名前で語る |
|  | RC5.7 | 悪いコードへの説明コメントは CC4.1（採用（背景））と同内容。コードを書き直す |
| 関数の切り出しは凝集と結合で判断する | CCT4.2 | 凝集・結合の設計判断。D2・XC7.2 相当は関数で採用 |
| 失敗は観測可能にする | CCT8.1 | Error 型の統一は言語慣習。D7 で文脈を採用 |
| 残りの発見法則は既存項目でカバーする | CC17.5 | G29→B1、G30→A5、G10→E1、G11→A8、N5→RC2.9 と既に同内容。T5 はテスト中身の対象外。抜粋方針は Ch17 冒頭で明示済み |
| 関数は小さく、1つのことをする | CO7.3 | 行数の数値基準は持たない。D2 の抽象レベル・目的で判定 |
|  | CO19.7 | 複雑度の数値基準は持たない（CO7.3 と同理由） |
| ループは目的に合った形と出口にする | CO16.1 | ループ形式は言語慣習に従う。C3 のみ採用 |
|  | CO16.5 | 家事処理の位置は言語のループ意味論で解決 |
|  | RF-split-loop | 分割 vs 統一は性能・可読性のトレードオフが案件依存。F6・F3 の判断軸で個別対応 |
| ネストを浅く保つ | CO31.3 | インデントはフォーマッタ領域 |
| 変数は減らし、スコープは狭くする | RF-replace-temp-with-query | 問い合わせ化はクラス設計依存。B1 の変数受付で主要効果を担保 |
|  | RF-replace-derived-variable-with-query | 導出値の問い合わせ化はクラス設計依存（RF-replace-temp-with-query と同理由） |

## The Art of Readable Code

- Dustin Boswell, Trevor Foucher. The Art of Readable Code. O'Reilly Media, 2010. ISBN 978-0-596-80229-2

### Ch1 コードは理解しやすく

| ID | 助言 | 要約 |
| --- | --- | --- |
| RC1.1 | 理解しやすさを最優先指標にする | コードの良さを「他の人が理解にかかる時間」で測る |
| RC1.2 | 短さよりも理解の速さ | コードは短いほど良いとは限らない。理解が速い方が勝つ |

### Ch2 名前に情報を詰める

| ID | 助言 | 要約 |
| --- | --- | --- |
| RC2.1 | 具体的な語を選ぶ | `get` のような汎用動詞より `fetch`・`download` のように処理の中身を言う |
| RC2.2 | 空の名前を避ける | `tmp`・`retval`・`void` は名前として情報を持たない。慣習的な局所スコープ（交換用 tmp 等）を除く |
| RC2.3 | ループ変数の慣習 | `i`/`j`/`k` は慣習として通じる。それ以外の変数は具体的に |
| RC2.4 | 単位を名前に添える | `delay` でなく `delaySecs`、`size` でなく `sizeMB` |
| RC2.5 | 重要な属性を名前に | `password` でなく `plaintextPassword` のように、誤用につながる属性を語る |
| RC2.6 | 真偽値は is/has/can を付ける | `spaceLeft` より `hasSpaceLeft`。真偽が読める形に |
| RC2.7 | 否定形を避ける | `disableSsl` より `useSsl`。二重否定の読み直しを防ぐ |
| RC2.8 | 命名規約に従う | 既存コードの規約を壊すと読み手の検索と推論を妨げる |
| RC2.9 | 名前の長さはスコープに比例 | 大スコープの変数は長く具体的に、数行のスコープなら短くてよい |
| RC2.10 | 抽象名より具体名 | 読み手が動作を想像できる具体名を選ぶ（`ServerCanStart()` より `CanListenOnPort()`） |
| RC2.11 | より具体的な語を探す | `get` 系の語彙が合わないとき、シソーラス等でより具体的な語を探す |

### Ch3 誤解されない名前

| ID | 助言 | 要約 |
| --- | --- | --- |
| RC3.1 | 曖昧な語を絞る | `filter` は「選ぶ」のか「除外する」のか読めない。`select`/`exclude` のように一意に |
| RC3.2 | 境界は max/min で | `cartTooBig` でなく `MAX_ITEMS_IN_CART`。上限・下限を名前で語る |
| RC3.3 | 範囲の包含を明示 | `first`/`last`（含む）と `begin`/`end`（end は含まない）を使い分ける |
| RC3.4 | 読み手の期待を裏切らない | `get` は軽量・副作用なしの慣習。期待と異なる動作なら名前を変える |
| RC3.5 | 複数案を並べて誤解を検討 | 候補名を並べて最も誤解が少ないものを選ぶ |

### Ch4 見た目の整え

| ID | 助言 | 要約 |
| --- | --- | --- |
| RC4.1 | 一貫したレイアウト | 似たコードは似た見た目に。読み手が構造を推論できる |
| RC4.2 | 関数を段落のように整理 | 関数内のブロックが段落として読めるように並べる |
| RC4.3 | 縦整列 | 対応する要素は列を揃えると差分が読める |
| RC4.4 | 一貫した順序 | 宣言・引数・属性の並び順をコード全体で統一する |
| RC4.5 | 空行で段落分け | 連続した処理を空行で論理段落に分ける |
| RC4.6 | コメントの位置を揃える | 繰り返し現れるコメントは同じ位置に置く |
| RC4.7 | 列の順序の一貫性 | 引数や表の列順を一貫させると読み手が記憶できる |
| RC4.8 | 処理の見た目を動作に合わせる | 処理の意味上のまとまりと見た目のまとまり（改行・ブロック）を一致させる |

### Ch5 コメントすべきことを知る

| ID | 助言 | 要約 |
| --- | --- | --- |
| RC5.1 | 自明なことはコメントしない | コードから読めることの逐語訳は価値がない |
| RC5.2 | 思考を記録する | 「なぜこの設計か」という判断の記録は読み手の助けになる |
| RC5.3 | 定数の意味を語る | 定数の値が選ばれた理由・背景は名前から読めない |
| RC5.4 | 読み手の予想される質問に答える | コードを読んで「なぜ？」と思う点にコメントする |
| RC5.5 | 大きな絵をコメント | ファイル・クラスの役割を要約する冒頭コメント |
| RC5.6 | 弱点の申告 | TODO・FIXME・ハックの明示 |
| RC5.7 | 悪いコードにコメントしない | 説明コメントを足すより、コードを書き直す |

### Ch6 コメントは正確で簡潔に

| ID | 助言 | 要約 |
| --- | --- | --- |
| RC6.1 | 簡潔に | だらだらしたコメントは読まれない |
| RC6.2 | 入出力の具体例で正確に | 具体例（`Example: "strip(\"abc\") → "abc"`）は説明文より正確 |
| RC6.3 | 名前付き引数コメント | 位置引数の前に `/* timeout_ms */` のように引数名を添える |
| RC6.4 | 情報密度の高い語を使う | キャッシュヒット率など、専門語で短く言い切る |

### Ch7 制御フローを読みやすく

| ID | 助言 | 要約 |
| --- | --- | --- |
| RC7.1 | 条件の引数順 | 左辺に調べる対象、右辺に定数（`while (bytes < maxBytes)`） |
| RC7.2 | if/else の順 | 肯定形・興味のある分岐・目立つ分岐を先に |
| RC7.3 | do/while を避ける | 条件が末尾にあると読み飛ばされる。先頭条件の形に |
| RC7.4 | ネストを最小化 | ガード節・早期 return で平坦にする |
| RC7.5 | 巨大な式を分割 | 説明変数・要約変数で式を小さくする（Ch8） |
| RC7.6 | 変数を減らす | 不要な変数は理解の邪魔（Ch9） |

### Ch8 巨大な式の分解

| ID | 助言 | 要約 |
| --- | --- | --- |
| RC8.1 | 説明変数 | 式の部分を名前付き変数に置き、意図を語らせる |
| RC8.2 | 要約変数 | 大きな式の結果全体を `userIsAuthorized` のような名前で受ける |
| RC8.3 | De Morgan の法則 | `!(a &amp;&amp; b)` を `!a \|  \| !b` に展開し、読みやすい形を選ぶ |
| RC8.4 | 短絡評価の悪用を避ける | `&&`/`\|  \|` にロジックを詰め込むと式が読めなくなる |
| RC8.5 | 論理の単純化 | 見た目で解けるレベルまで式を崩す（副問題の抽出と組み合わせ） |

### Ch9 変数と読みやすさ

| ID | 助言 | 要約 |
| --- | --- | --- |
| RC9.1 | 不要な変数を消す | 結果に名前を付けない中間変数・即座に使う一時変数は削除候補 |
| RC9.2 | スコープを狭める | 変数の見える範囲を最小に。宣言は使う直前に |
| RC9.3 | write-once を好む | 一度しか代入されない変数（const）は追いやすい |
| RC9.4 | 変数の目的を1つに | 1つの変数を複数目的に使い回さない |

### Ch10 無関係の下問題の抽出

| ID | 助言 | 要約 |
| --- | --- | --- |
| RC10.1 | 下問題を別関数へ | 本流に関係ない処理（ログ整形・エッジケース処理）を抽出する |
| RC10.2 | 抽出関数は純粋に | 抽出した関数は引数だけを見れば分かる形に |
| RC10.3 | 関数は短く、まとめて | 小さく純粋な関数を組み合わせて全体を構成する |

### Ch11 一度に一つのタスク

| ID | 助言 | 要約 |
| --- | --- | --- |
| RC11.1 | タスクを線形に並べる | 複数のタスクを交互に混ぜず、1つずつ区切って進める |
| RC11.2 | タスクは明示的な関数に | タスクの区切りが関数境界として見えるようにする |

### Ch12 考えをコードに

| ID | 助言 | 要約 |
| --- | --- | --- |
| RC12.1 | 平易な言葉で説明してから書く | 解決手順を普段の言葉で書き下し、その構造をそのままコードにする |
| RC12.2 | 問題を別の角度から捉える | 行き詰まったら、より小さい・簡単な問題へ言い換えてから解く |

### Ch13 より少ないコードを書く

| ID | 助言 | 要約 |
| --- | --- | --- |
| RC13.1 | 要件を疑う | 最も簡単に解決するなら、実装自体をなくせるかもしれない |
| RC13.2 | 標準ライブラリに親しむ | 車輪の再発明をやめ、既存機能で満たす |
| RC13.3 | 未使用コードを削除 | 死んだコード・コメントアウトされたコードは消す |
| RC13.4 | 使いやすい API を選ぶ | 同じ要件なら、より単純な API を持つ代替を選ぶ |

### Ch14 テストと読みやすさ

| ID | 助言 | 要約 |
| --- | --- | --- |
| RC14.1 | テストも読みやすさの対象 | 本番コードと同じ読みやすさ基準をテストに適用する |
| RC14.2 | 最小の失敗テスト | 失敗時の原因が特定しやすい小さなテストを保つ |
| RC14.3 | テスト名は振る舞いを説明 | `test1()` でなく、何を検証するかが名前から読める形に |
| RC14.4 | テストごとに1つの関心事 | 1テストが検証するのは1つの振る舞いに絞る |
| RC14.5 | 単純な入力値 | 検証目的を達成する最小・最単純な入力を選ぶ |
| RC14.6 | 完璧を目指さない | テストの網羅より、主要経路の読みやすさと維持可能性を優先 |
| RC14.7 | 名前付きテストヘルパー | `assertStockEquals(expected, actual)` のような目的名のある helper で意図を語る |

### Ch15 「注意散漫最小化」テスト基盤

| ID | 助言 | 要約 |
| --- | --- | --- |
| RC15.1 | トップレベルのテスト関数 | テスト本体が読み手に見える位置・形式に置く |
| RC15.2 | テストの独立性 | 各テストは他に影響せず単独で走る |

## Clean Code

- Robert C. Martin. Clean Code: A Handbook of Agile Software Craftsmanship. Prentice Hall, 2008. ISBN 978-0-13-235088-4

### Ch1 きれいなコード

| ID | 助言 | 要約 |
| --- | --- | --- |
| CC1.1 | コードは読み手のために | 理解の速さを最優先する価値基準 |

### Ch2 意味のある名前

| ID | 助言 | 要約 |
| --- | --- | --- |
| CC2.1 | 意図を明示する名前 | 名前だけで「何をし、どう使い、何を返すか」が分かるようにする |
| CC2.2 | 誤解を招く名前を避ける | 実態と違う型・構造を連想させる名前（List でない `accountList` 等）は禁止 |
| CC2.3 | 意味のある区別 | `a1`/`a2` や `Info`/`Data` のようなノイズ語での区別は無意味 |
| CC2.4 | 発音できる名前 | 発音できないと議論できない |
| CC2.5 | 検索できる名前 | 単文字名は検索不能にする。名前は grep 可能な長さに |
| CC2.6 | エンコーディングを避ける | ハンガリアン記法・メンバ接頭辞（`m_`）は型情報の重複 |
| CC2.7 | クラス名は名詞、メソッド名は動詞 | 品詞の慣習を守る |
| CC2.8 | かわいらすぎる名前を避ける | 内輪ネタ名は検索も議論も妨げる |
| CC2.9 | 概念ごとに1語 | 同じ概念に `fetch`/`get`/`retrieve` を混ぜない |
| CC2.10 | 解決領域・問題領域の語を使う | CS 用語が通じるならそれを、そうでなければ業務用語を |
| CC2.11 | 意味のある文脈 | `firstName` 単独より `addr.firstName` のように文脈を与える |

### Ch3 関数

| ID | 助言 | 要約 |
| --- | --- | --- |
| CC3.1 | 関数は小さく | 第1の規則は小ささ。さらにその第1の規則は「さらに小さく」 |
| CC3.2 | ブロックとインデント | if/else/while の中身は1行、インデントは1〜2レベルに |
| CC3.3 | 1つのことをする | 関数内の処理を段落に分けられるなら、それは複数のことをしている |
| CC3.4 | 抽象レベルを1つに | 関数内の文はすべて同じ抽象レベルに揃える |
| CC3.5 | 降下則（stepdown） | 関数を上から読むと抽象度が1段ずつ下がるように並べる |
| CC3.6 | switch の扱い | switch は本質的に多態で置き換えを検討する |
| CC3.7 | 説明的な名前 | 長くても良いから、1つのことを丁寧に語る名前を |
| CC3.8 | 引数は少なく | 理想は0。1〜2は許容、3は避け、4以上は理由が必要 |
| CC3.9 | フラグ引数は醜い | `render(true)` は呼び出し側の意味が読めない。2関数に分ける |
| CC3.10 | 単項・二項形式 | 引数の数ごとに自然な形式（変換・質問・結合）を使う |
| CC3.11 | 動詞とキーワード | `assertExpectedEqualsActual` のように引数の役割を名前に含める |
| CC3.12 | 副作用を持たない | `checkPassword` がセッション初期化をするような二重の振る舞いを避ける |
| CC3.13 | コマンド・クエリ分離 | 「する」関数と「答える」関数を分ける。`set` して `true` を返さない |
| CC3.14 | エラーコードより例外 | 例外機構を使い、エラーコード分岐を本体から追い出す |
| CC3.15 | try/catch を抽出 | try/catch ブロックだけを本体にし、処理を別関数へ |
| CC3.16 | 繰り返しをなくす（DRY） | 重複は抽象化の漏れ。共通処理は1つにまとめる |

### Ch4 コメント

| ID | 助言 | 要約 |
| --- | --- | --- |
| CC4.1 | コメントは失敗の証 | コメントでなくコードで語れる形へ直すのが先 |
| CC4.2 | 良いコメント | 法務情報・意図の説明・明確化・警告・TODO・強調・公開APIのjavadoc |
| CC4.3 | 悪いコメント | つぶやき・重複・誤解を招く・履歴・位置マーカー・コメントアウトされたコード等 |
| CC4.4 | コメントアウトコードは削除 | VCS があるので残す理由がない |

### Ch5 整形

| ID | 助言 | 要約 |
| --- | --- | --- |
| CC5.1 | 縦の整形 | 新聞のメタファー（冒頭に概要、末尾に詳細）。関連は近く、段落は空行で |
| CC5.2 | 横の整形 | 1行の長さに上限を設け、演算子の前後で折る |
| CC5.3 | チーム規約 | 個人の好みより一貫した規約が勝つ |

### Ch6 オブジェクトとデータ構造

| ID | 助言 | 要約 |
| --- | --- | --- |
| CC6.1 | データ抽象 | 実装を隠し、データでなく振る舞いを公開する |
| CC6.2 | データ/オブジェクトの非対称性 | 手続き型と OOP のトレードオフを認識する |
| CC6.3 | ディミテルの法則 | 列車衝突（`a.getB().getC()`）を避ける |
| CC6.4 | ハイブリッド構造の回避 | オブジェクトとデータ構造の混在を避ける |
| CC6.5 | 構造の隠蔽 | visitor 等で内部構造を露出しない |

### Ch7 エラーハンドリング

| ID | 助言 | 要約 |
| --- | --- | --- |
| CC7.1 | 戻り値でなく例外 | エラーコードのif分岐をなくし、正常系を readable に保つ |
| CC7.2 | 最初に try/catch を書く | try ブロックのスコープを先に確定すると処理が整理される |
| CC7.3 | 非検査例外 | 検査例外は OCP 破壊等多害（Java 固有の議論） |
| CC7.4 | 例外に文脈を | 失敗した操作と種類をメッセージに含め、原因を追跡可能に |
| CC7.5 | null を返さない | 呼び出し側の null チェック忘れを誘発する |
| CC7.6 | null を渡さない | 引数の null は契約違反。渡す設計自体を避ける |

### Ch8 境界

| ID | 助言 | 要約 |
| --- | --- | --- |
| CC8.1 | 第三者コードの境界ラップ | `Map` 等を自前型で包み、境界を一元化する |
| CC8.2 | 学習テスト | 外部 API の理解をテストとして残す |

### Ch9 単体テスト

| ID | 助言 | 要約 |
| --- | --- | --- |
| CC9.1 | TDD三原則 | 実装前に失敗テスト、など。プロセス規約 |
| CC9.2 | きれいなテスト | テストの読みやすさも本番同様。build-operate-check の構造 |
| CC9.3 | テストごとに1概念 | 「1テスト1assert」を厳格化するより「1概念1テスト」 |
| CC9.4 | F.I.R.S.T. | Fast, Independent, Repeatable, Self-validating, Timely |

### Ch10 クラス

| ID | 助言 | 要約 |
| --- | --- | --- |
| CC10.1 | クラスの構成順 | 定数→変数→public→private（使用直下）の順 |
| CC10.2 | クラスは小さく（SRP） | 責務単位で測る |
| CC10.3 | 凝集 | インスタンス変数を全メソッドが使う状態へ |
| CC10.4 | 変更からの隔離（DIP） | 環境・詳細からクラスを隔離する |

### Ch11 システム

| ID | 助言 | 要約 |
| --- | --- | --- |
| CC11.1 | 構築と使用の分離 | main・factory で構築を切り出す |
| CC11.2 | 依存性注入 | 依存を外部から渡す |
| CC11.3 | スケールアップ | 最初はシンプルに、成長に合わせて進化する |

### Ch12 創発

| ID | 助言 | 要約 |
| --- | --- | --- |
| CC12.1 | 全テストを通す | 単純設計の第1規則 |
| CC12.2 | 重複なし | 第2規則 |
| CC12.3 | 意図を表現 | 第3規則。コードが自ら意図を語る |
| CC12.4 | クラス・メソッドの最小化 | 第4規則 |

### Ch13 並行性

| ID | 助言 | 要約 |
| --- | --- | --- |
| CC13.1 | 並行性防御原則 | 並行コードの分離・データスコープ制限・独立スレッド |
| CC13.2 | 同期ブロックは小さく | synchronized 領域を最小化する |

### Ch14 逐次的精緻化

| ID | 助言 | 要約 |
| --- | --- | --- |
| CC14.1 | 逐次的精緻化（Args） | 動くコードから段階的に整理する実演 |

### Ch15 JUnit 内部

| ID | 助言 | 要約 |
| --- | --- | --- |
| CC15.1 | JUnit 内部 | 古い JUnit を読みやすくする実演 |

### Ch17 においと発見法則（関連抜粋）

Ch17 は多数の heuristic の集成のため、本 skill に関連する主要なもののみ抜粋する。

| ID | 助言 | 要約 |
| --- | --- | --- |
| CC17.1 | 意図に反する動作を避ける | 驚きを生むコードは名前・構造から直す（G16 相当） |
| CC17.2 | 境界条件をカプセル化 | 境界の判定は1箇所に（G5 相当） |
| CC17.3 | 関数は1つのことを | F1 相当の繰り返し。名前の中の「and」は分割の合図 |
| CC17.4 | 名前は一意に | 同じ概念に同じ語、違う概念に違う語（N1/N2 相当） |
| CC17.5 | 未抜粋の heuristic（G29・G30・G10・G11・N5・T5 等） | 条件のカプセル化・否定条件の回避・縦の分離・一貫性など、既存項目と同内容か対象外のものが多い |

## Code Complete 第2版

- Steve McConnell. Code Complete, Second Edition. Microsoft Press, 2004. ISBN 978-0-7356-1967-8

### Ch7 高品質なルーチン

| ID | 助言 | 要約 |
| --- | --- | --- |
| CO7.1 | ルーチン化の正当な理由 | 重複排除・隠蔽・可読性等の目的があるときだけ関数にする |
| CO7.2 | 強い凝集 | 機能的凝集（1つの機能のみ）が最良。順次・通信的凝集は弱い |
| CO7.3 | ルーチンの長さ | 研究上は100〜200行程度までが理解コスト的に許容される |
| CO7.4 | 結合を弱める | 引数・戻り値だけの疎結合を保つ |
| CO7.5 | 引数を作業変数として使わない | パラメータへの再代入を避け、作業用のローカル変数を別に用意する |
| CO7.6 | 戻り値を返す関数は副作用を持たない | 値を返すルーチンはローカル変数の変更以外の副作用を持たず、副作用はプロシージャ側へ分離する |
| CO7.7 | ルーチン名は強い動詞+目的語 | `HandleOutput` より `PrintDocument` のように具体化する。真偽を返すルーチンは `Is/Has` を前置する |
| CO7.8 | 引数は入力→更新→出力の順で | 類似シグネチャ間で引数順を統一し、状態・エラー変数は末尾に置く。全引数を使用する |

### Ch8 防御的プログラミング

| ID | 助言 | 要約 |
| --- | --- | --- |
| CO8.1 | 例外処理の規律 | catch を空にしない、標準の例外型を使う、例外は例外的な状況だけに使う |

### Ch10 変数の使用における一般的な事項

| ID | 助言 | 要約 |
| --- | --- | --- |
| CO10.1 | 変数の参照を局所化 | 変数を使う文同士の距離（span）と生存期間（live time）を縮め、スコープを最小化する |
| CO10.2 | 宣言と初期化を使う直前に | 変数は最初に使う位置の近くで宣言・初期化する。初期化忘れを構造で防ぐ |
| CO10.3 | 1変数1用途 | 1つの変数を複数の目的に使い回さない。用途が変わるときは新しい名前を与える |

### Ch11 変数のパワー

| ID | 助言 | 要約 |
| --- | --- | --- |
| CO11.1 | 最も具体的な名前 | `day` より `daysSinceLastBackup` のように内容を限定的に語る |
| CO11.2 | 問題指向の名前 | 解く問題領域の語で名付ける |
| CO11.3 | 名前の最適長 | 研究上は10〜16文字程度が探索・理解のバランスが良い |
| CO11.4 | 計算値の修飾語 | 合計は `revenueTotal`、平均は `revenueAverage` のように接尾辞で |
| CO11.5 | 一般的な慣習 | ループ変数 i/j/k、真偽値は done/error/found/success 等の慣習 |
| CO11.6 | 一時変数に注意 | `temp`・`x` は保存しから省略まで幅広く読め、危険 |
| CO11.7 | 名前付き定数 | magic number は名前付き定数へ |
| CO11.8 | 命名規約 | 言語・プロジェクトの規約を一貫適用する |

### Ch12 基本データ型

| ID | 助言 | 要約 |
| --- | --- | --- |
| CO12.1 | 真偽変数で複雑な条件を文書化 | 複雑な論理式を `deadlinePassed` のような真偽変数に受けて式を読みやすくする |
| CO12.2 | 列挙型で可読性を上げる | 同種の定数群は列挙型でグループ化し、判定の意図と有効値を型で語る |
| CO12.3 | 名前付き定数を使う | リテラルを直接書かず名前付き定数で意味を語る |

### Ch13 特殊なデータ型

| ID | 助言 | 要約 |
| --- | --- | --- |
| CO13.3 | グローバルデータを避ける | グローバル変数はアクセサ経由に集約するか廃止し、暗黙の結合を作らない |

### Ch14 順次コードの構成

| ID | 助言 | 要約 |
| --- | --- | --- |
| CO14.1 | 依存する文は近くに | 順序依存のある文は隣接させ、依存を見える化する |
| CO14.2 | 依存を明示 | 変数初期化のような依存は、戻り値の利用で明示する |
| CO14.3 | 依存のない文も読み手の順序で | 依存関係のない文は、名前を上から下へ読めるよう対象読者の自然な順序で並べる |

### Ch15 条件文の使用

| ID | 助言 | 要約 |
| --- | --- | --- |
| CO15.1 | if/else の順序 | 正常ケースを先に。等値比較は定数を左にする流儀も紹介 |
| CO15.2 | 連鎖 if/else は case を検討 | 分岐が3つ以上・同種なら case・表駆動を検討 |
| CO15.3 | case の順序 | 頻度順・重要性順・アルファベット順から意図に合うものを選ぶ |

### Ch16 ループの制御

| ID | 助言 | 要約 |
| --- | --- | --- |
| CO16.1 | ループ形式の選択 | カウント付きは for、条件は while が自然 |
| CO16.2 | while への入口出口 | 先頭判定・末尾判定・中間判定（while true + break）から選ぶ |
| CO16.3 | ループの早期exit | 出口が複数でも意図が明確なら可。位置は目立たせる |
| CO16.4 | ループ変数の慣習 | i/j/k の慣習と、意味のあるループ変数名の使い分け |
| CO16.5 | 空ループと家事処理 | 空のループ本体を避け、増分等の家事処理は1箇所に |

### Ch17 特殊な制御構造

| ID | 助言 | 要約 |
| --- | --- | --- |
| CO17.1 | 複数 return は注意 | 大きいルーチンでは return を増やすと理解が難しくなる。小さいルーチンなら可 |
| CO17.2 | 再帰 | 終了条件を最初に置く。深い再帰は避ける |
| CO17.3 | goto | 現代の言語では不要な場面がほとんど |

### Ch19 制御に関する一般論

| ID | 助言 | 要約 |
| --- | --- | --- |
| CO19.1 | 真偽式の単純化 | 説明変数・De Morgan・複雑条件の関数化で読みやすく |
| CO19.2 | 決定表 | 複雑な条件組み合わせは表駆動で整理する |
| CO19.3 | ネストを浅く | break/continue/return・ガード節・関数分割で深さを減らす |
| CO19.4 | 構造化プログラミング | 順次・選択・反復の組み合わせで書く |
| CO19.5 | 制御文の順序 | 頻度順・数値順・論理順など、意図のある順序を選ぶ |
| CO19.6 | null 文を避ける | `if (x) ;` のような空の本体を書かない |
| CO19.7 | 複雑度の測定 | 制御構造の複雑さ（cyclomatic complexity 等）を測定し、深いネスト・複雑なルーチンを検出する |

### Ch22 開発者テスト

| ID | 助言 | 要約 |
| --- | --- | --- |
| CO22.1 | テストの入力設計 | 境界条件（0、1、N、最大値、空）を意図的にテストする |

### Ch31 レイアウトとスタイル

| ID | 助言 | 要約 |
| --- | --- | --- |
| CO31.1 | レイアウトは構造の伝達 | 整形の目的はコードの論理構造を視覚化すること |
| CO31.2 | 空白で段落を | 空行・空白が論理的なまとまりを示す |
| CO31.3 | インデント | レベルで構造を示す。深いインデントは分割の合図 |

### Ch32 自己文書化コード

| ID | 助言 | 要約 |
| --- | --- | --- |
| CO32.1 | スタイルが文書 | 良い名前・小さなルーチン・明快な制御が自己文書化の主体 |
| CO32.2 | コメントは最終手段 | コードで語れるものはコードで語る |
| CO32.3 | コメントすべきもの | 要約・意図・制約など、コードから読めないものだけ |

## Refactoring 第2版（refactoring.com カタログ）

- Martin Fowler. Refactoring: Improving the Design of Existing Code, 2nd Edition. Addison-Wesley, 2018. ISBN 978-0-13-475759-9
- オンラインカタログ: https://refactoring.com/catalog/

| ID | 助言 | 要約 |
| --- | --- | --- |
| RF-extract-variable | [Extract Variable](https://refactoring.com/catalog/extractVariable.html) | 複雑な式の部分を、意図を語る名前の変数へ抽出する |
| RF-inline-variable | [Inline Variable](https://refactoring.com/catalog/inlineVariable.html) | 名前が式より読みやすくならない変数は式に戻す |
| RF-extract-function | [Extract Function](https://refactoring.com/catalog/extractFunction.html) | 意図に名前を付けて処理塊を関数へ切り出す |
| RF-inline-function | [Inline Function](https://refactoring.com/catalog/inlineFunction.html) | 本体を直接見た方が明快な間接化を解消する |
| RF-change-function-declaration | [Change Function Declaration](https://refactoring.com/catalog/changeFunctionDeclaration.html) | 関数名・引数を良い名前へ変える（Rename Function を含む） |
| RF-replace-temp-with-query | [Replace Temp with Query](https://refactoring.com/catalog/replaceTempWithQuery.html) | 一時変数を問い合わせ（メソッド）へ置き換える |
| RF-decompose-conditional | [Decompose Conditional](https://refactoring.com/catalog/decomposeConditional.html) | 条件式と各分岐を、意図を語る関数へ分解する |
| RF-consolidate-conditional-expression | [Consolidate Conditional Expression](https://refactoring.com/catalog/consolidateConditionalExpression.html) | 同じ結果を返す一連の条件を1つにまとめる |
| RF-consolidate-duplicate-conditional-fragments | [Consolidate Duplicate Conditional Fragments](https://refactoring.com/catalog/consolidateDuplicateConditionalFragments.html) | 全分岐に重複する断片を条件の外へ出す |
| RF-replace-nested-conditional-with-guard-clauses | [Replace Nested Conditional with Guard Clauses](https://refactoring.com/catalog/replaceNestedConditionalWithGuardClauses.html) | ネストした条件をガード節へ置き換える |
| RF-introduce-special-case | [Introduce Special Case](https://refactoring.com/catalog/introduceSpecialCase.html) | 特殊ケース（null 等）の重複判定を特殊ケースオブジェクトへ集約する |
| RF-remove-dead-code | [Remove Dead Code](https://refactoring.com/catalog/removeDeadCode.html) | 到達しないコードを削除する |
| RF-substitute-algorithm | [Substitute Algorithm](https://refactoring.com/catalog/substituteAlgorithm.html) | 実装をより明快なアルゴリズムで置き換える |
| RF-split-loop | [Split Loop](https://refactoring.com/catalog/splitLoop.html) | 異なる目的を1ループで回している場合、ループを目的ごとに分割する |
| RF-replace-loop-with-pipeline | [Replace Loop with Pipeline](https://refactoring.com/catalog/replaceLoopWithPipeline.html) | ループと途中変数による配列の集計・変換をパイプライン（filter/map 等）へ置き換える |
| RF-split-variable | [Split Variable](https://refactoring.com/catalog/splitVariable.html) | 1つの変数に複数の目的がある場合、目的ごとの変数へ分割する |
| RF-remove-flag-argument | [Remove Flag Argument](https://refactoring.com/catalog/removeFlagArgument.html) | フラグ引数を除去し、呼び出し先を明示する個別の関数へ分ける |
| RF-introduce-parameter-object | [Introduce Parameter Object](https://refactoring.com/catalog/introduceParameterObject.html) | 同じ引数群が繰り返される場合、1つのオブジェクトへまとめる |
| RF-separate-query-from-modifier | [Separate Query from Modifier](https://refactoring.com/catalog/separateQueryFromModifier.html) | 値を返す処理と副作用のある処理を別関数へ分ける |
| RF-slide-statements | [Slide Statements](https://refactoring.com/catalog/slideStatements.html) | 関連する文を近くへ移動させる |
| RF-remove-control-flag | [Remove Control Flag](https://refactoring.com/catalog/removeControlFlag.html) | 制御フラグによるループ制御を break/continue/return へ置き換える |
| RF-split-phase | [Split Phase](https://refactoring.com/catalog/splitPhase.html) | 異なる抽象レベルの処理（フェーズ）を分離する |
| RF-replace-inline-code-with-function-call | [Replace Inline Code with Function Call](https://refactoring.com/catalog/replaceInlineCodeWithFunctionCall.html) | 既存関数と同等の処理をインラインで書いている場合、関数呼び出しへ置き換える |
| RF-rename-variable | [Rename Variable](https://refactoring.com/catalog/renameVariable.html) | 変数を良い名前に変える |
| RF-encapsulate-variable | [Encapsulate Variable](https://refactoring.com/catalog/encapsulateVariable.html) | 変数の直接参照を関数（アクセサ）で包む |
| RF-encapsulate-record | [Encapsulate Record](https://refactoring.com/catalog/encapsulateRecord.html) | レコードの直接利用をクラスで包む |
| RF-encapsulate-collection | [Encapsulate Collection](https://refactoring.com/catalog/encapsulateCollection.html) | コレクションの直接公開を避け、追加・削除メソッドで操作する |
| RF-replace-primitive-with-object | [Replace Primitive with Object](https://refactoring.com/catalog/replacePrimitiveWithObject.html) | プリミティブ値を値オブジェクトへ置き換える |
| RF-extract-class | [Extract Class](https://refactoring.com/catalog/extractClass.html) | クラスを責務ごとに分割する |
| RF-inline-class | [Inline Class](https://refactoring.com/catalog/inlineClass.html) | 機能を失ったクラスを別クラスへ統合する |
| RF-hide-delegate | [Hide Delegate](https://refactoring.com/catalog/hideDelegate.html) | 委譲先への直接アクセスを委譲メソッドで隠す |
| RF-remove-middle-man | [Remove Middle Man](https://refactoring.com/catalog/removeMiddleMan.html) | 過剰な委譲メソッドを取り除き直接参照へ戻す |
| RF-move-function | [Move Function](https://refactoring.com/catalog/moveFunction.html) | 関数を属するモジュールへ移動する |
| RF-move-field | [Move Field](https://refactoring.com/catalog/moveField.html) | フィールドを属するモジュールへ移動する |
| RF-move-statements-into-function | [Move Statements into Function](https://refactoring.com/catalog/moveStatementsIntoFunction.html) | 関数へ移すべき文を関数内へ移動する |
| RF-move-statements-to-callers | [Move Statements to Callers](https://refactoring.com/catalog/moveStatementsToCallers.html) | 関数から呼び出し側へ文を移動する |
| RF-replace-derived-variable-with-query | [Replace Derived Variable with Query](https://refactoring.com/catalog/replaceDerivedVariableWithQuery.html) | 導出した値の保持を、都度の問い合わせへ置き換える |
| RF-change-reference-to-value | [Change Reference to Value](https://refactoring.com/catalog/changeReferenceToValue.html) | 参照セマンティクスのオブジェクトを値セマンティクスへ変える |
| RF-change-value-to-reference | [Change Value to Reference](https://refactoring.com/catalog/changeValueToReference.html) | 値セマンティクスのオブジェクトを参照セマンティクスへ変える |
| RF-replace-conditional-with-polymorphism | [Replace Conditional with Polymorphism](https://refactoring.com/catalog/replaceConditionalWithPolymorphism.html) | 条件分岐を多態で置き換える |
| RF-introduce-assertion | [Introduce Assertion](https://refactoring.com/catalog/introduceAssertion.html) | 前提条件を表明するコードを追加する |
| RF-parameterize-function | [Parameterize Function](https://refactoring.com/catalog/parameterizeFunction.html) | 似た複数の関数をパラメータで1つにまとめる |
| RF-preserve-whole-object | [Preserve Whole Object](https://refactoring.com/catalog/preserveWholeObject.html) | オブジェクトから値をばらして渡す代わりに、オブジェクトごと渡す |
| RF-replace-exception-with-precheck | [Replace Exception with Precheck](https://refactoring.com/catalog/replaceExceptionWithPrecheck.html) | 例外での流れ制御を事前チェックへ置き換える |
| RF-replace-function-with-command | [Replace Function with Command](https://refactoring.com/catalog/replaceFunctionWithCommand.html) | 複雑な関数をコマンドオブジェクトへ置き換える |
| RF-replace-constructor-with-factory-function | [Replace Constructor with Factory Function](https://refactoring.com/catalog/replaceConstructorWithFactoryFunction.html) | コンストラクタ直接呼び出しをファクトリ関数へ置き換える |
| RF-pull-up-method | [Pull Up Method](https://refactoring.com/catalog/pullUpMethod.html) | メソッドを継承階層の上位クラスへ移動する |
| RF-pull-up-field | [Pull Up Field](https://refactoring.com/catalog/pullUpField.html) | フィールドを継承階層の上位クラスへ移動する |
| RF-pull-up-constructor-body | [Pull Up Constructor Body](https://refactoring.com/catalog/pullUpConstructorBody.html) | コンストラクタ本体の共通部分を上位クラスへ移動する |
| RF-push-down-method | [Push Down Method](https://refactoring.com/catalog/pushDownMethod.html) | メソッドを継承階層の下位クラスへ移動する |
| RF-push-down-field | [Push Down Field](https://refactoring.com/catalog/pushDownField.html) | フィールドを継承階層の下位クラスへ移動する |
| RF-replace-type-code-with-subclasses | [Replace Type Code with Subclasses](https://refactoring.com/catalog/replaceTypeCodeWithSubclasses.html) | 型コードをサブクラスで置き換える |
| RF-extract-subclass | [Extract Subclass](https://refactoring.com/catalog/extractSubclass.html) | クラスから特化したサブクラスを抽出する |
| RF-extract-superclass | [Extract Superclass](https://refactoring.com/catalog/extractSuperclass.html) | 共通部分をスーパークラスへ抽出する |
| RF-extract-interface | [Extract Interface](https://refactoring.com/catalog/extractInterface.html) | インターフェースを抽出する |
| RF-collapse-hierarchy | [Collapse Hierarchy](https://refactoring.com/catalog/collapseHierarchy.html) | 過剰に細かい継承階層を統合する |
| RF-replace-subclass-with-delegate | [Replace Subclass with Delegate](https://refactoring.com/catalog/replaceSubclassWithDelegate.html) | 継承を委譲へ置き換える |
| RF-replace-superclass-with-delegate | [Replace Superclass with Delegate](https://refactoring.com/catalog/replaceSuperclassWithDelegate.html) | スーパークラスを委譲へ置き換える |

## clean-code-javascript（GitHub）

- Ryan McDermott. clean-code-javascript. https://github.com/ryanmcdermott/clean-code-javascript
- Clean Code の概念を JavaScript へ移植した単一 README のガイド（94.7k stars、確認日 2026-10-18）
- 内容は Clean Code（CC）の言語別具体化であり、CCn.m と同じ根拠のものは対応表で同等と扱う

### Ch1 Variables

| ID | 助言 | 要約 |
| --- | --- | --- |
| CCJ1.1 | 意味があり発音できる変数名 | `yyyymmdstr` のような名前ではなく、読めて発音できる具体名に |
| CCJ1.2 | 同種のものには同じ語彙 | `getClient`・`fetchCustomer` の混在をやめる |
| CCJ1.3 | 検索できる名前 | 逐語的な単文字名は検索不能にする |
| CCJ1.4 | 説明変数 | ネストした式を名前のある変数で受ける |
| CCJ1.5 | メンタルマッピングを避ける | 読み手に「i は何だっけ」と想起させない |
| CCJ1.6 | 不要な文脈を名前に加えない | クラス名が語る文脈を変数名で繰り返さない（`Car.name` でなく同クラス内では `name`） |
| CCJ1.7 | 短絡や条件分岐よりデフォルト引数 | 省略時の値は引数のデフォルト値で宣言する |

### Ch2 Functions

| ID | 助言 | 要約 |
| --- | --- | --- |
| CCJ2.1 | 引数は理想的に2個まで | 引数が増えると組合せテストも読み取りも破綻する |
| CCJ2.2 | 関数は1つのことをする |
| CCJ2.3 | 関数名はすることを語る |
| CCJ2.4 | 抽象レベルを1つに |
| CCJ2.5 | 重複コードを削除する |
| CCJ2.6 | デフォルトオブジェクトは Object.assign で | 省略時のオブジェクトを手で組み立てない |
| CCJ2.7 | フラグ引数を使わない | 2つの関数に分ける |
| CCJ2.8 | 副作用を避ける（part 1） | 関数は名前が語ることだけをする |
| CCJ2.9 | 副作用を避ける（part 2） | 名前に現れない出力（書き込み）をしない |
| CCJ2.10 | グローバル関数を上書きしない | 組み込み・共有の関数を汚染しない |
| CCJ2.11 | 命令型より関数型を好む | ミューテーションの連鎖より map/filter 等の式で表す |
| CCJ2.12 | 条件をカプセル化する | 複雑条件は `isPasswordValid()` のような関数で包む |
| CCJ2.13 | 否定条件を避ける | `!isNotEditable` の二重読みをしない |
| CCJ2.14 | 条件分岐を避ける（多態） | 同種の分岐は多態で置き換える |
| CCJ2.15 | 型検査を避ける（part 1） | 文字列比較による型判定ではなく多態を検討する |
| CCJ2.16 | 型検査を避ける（part 2） | 型判定の連鎖より型システムを使う |
| CCJ2.17 | 過度に最適化しない | 動く・読めるコードが先。最適化は計測後 |
| CCJ2.18 | 死んだコードを削除する | 未使用コードは残さない |

### Ch3 Objects and Data Structures

| ID | 助言 | 要約 |
| --- | --- | --- |
| CCJ3.1 | getter/setter を使う | オブジェクト内部への直接アクセスよりアクセサで意図を語る |
| CCJ3.2 | private メンバを持たせる | 外部契約と内部実装を分ける |

### Ch4 Classes

| ID | 助言 | 要約 |
| --- | --- | --- |
| CCJ4.1 | ES5 関数より ES6 クラス | 言語の標準構造を使う |
| CCJ4.2 | メソッドチェーン | 連続操作を読める鎖で表す |
| CCJ4.3 | 継承よりコンポジション | 継承の結合を避ける |

### Ch5 SOLID

| ID | 助言 | 要約 |
| --- | --- | --- |
| CCJ5.1 | 単一責任の原則（SRP） | クラス・モジュールの変更理由を1つに |
| CCJ5.2 | 開放閉鎖の原則（OCP） | 拡張に対して開き、修正に対して閉じる |
| CCJ5.3 | リスコフの置換原則（LSP） | 派生型は基底型と置換可能に |
| CCJ5.4 | インターフェース分離の原則（ISP） | 使わないメソッドを実装させない |
| CCJ5.5 | 依存性逆転の原則（DIP） | 具象でなく抽象に依存させる |

### Ch6 Testing

| ID | 助言 | 要約 |
| --- | --- | --- |
| CCJ6.1 | 1テスト1概念 | テストは1つの概念だけを検証する |

### Ch7 Concurrency

| ID | 助言 | 要約 |
| --- | --- | --- |
| CCJ7.1 | コールバックでなく Promise | 入れ子のコールバックより Promise チェーン |
| CCJ7.2 | Promise より async/await | 直列に読める形で非同期を書く |

### Ch8 Error Handling

| ID | 助言 | 要約 |
| --- | --- | --- |
| CCJ8.1 | 捕捉したエラーを無視しない | 空 catch で握りつぶさず、失敗を観測可能にする |
| CCJ8.2 | reject された Promise を無視しない | 同上。`.catch` で失敗を扱う |

### Ch9 Formatting

| ID | 助言 | 要約 |
| --- | --- | --- |
| CCJ9.1 | 一貫した大文字小文字 | ファイル・関数・変数の命名ケースを統一する |
| CCJ9.2 | 呼び出し元と呼び出し先は近く | 関数はその呼び出し元の近くに置く |

### Ch10 Comments

| ID | 助言 | 要約 |
| --- | --- | --- |
| CCJ10.1 | ビジネスロジックの複雑さだけコメントする | 複雑な業務ロジックの説明のみコメントを許す |
| CCJ10.2 | コメントアウトコードを残さない | VCS があるので削除する |
| CCJ10.3 | 履歴コメントを書かない | 変更履歴は VCS が持つ |
| CCJ10.4 | 位置マーカーを避ける | `// ---- Section ----` のような区切り装飾を書かない |

## clean-code-typescript（GitHub）

- Labs42. clean-code-typescript. https://github.com/labs42io/clean-code-typescript
- Clean Code の概念を TypeScript へ移植した単一 README のガイド（9.8k stars、確認日 2026-10-18）
- CCJ と同根の内容が多く、TypeScript 固有の助言（enum・type/immutability・TS エコシステム）を含む

### Ch1 Variables

| ID | 助言 | 要約 |
| --- | --- | --- |
| CCT1.1 | 意味のある変数名 | 具体的で内容を語る名前 |
| CCT1.2 | 発音できる変数名 | 議論と検索ができる名前 |
| CCT1.3 | 同種のものには同じ語彙 | 概念ごとに1語 |
| CCT1.4 | 検索できる名前 | 読み手が grep できる長さ |
| CCT1.5 | 説明変数 | 式を名前で受ける |
| CCT1.6 | メンタルマッピングを避ける | 読み手に対応を覚えさせない |
| CCT1.7 | 不要な文脈を加えない | 構造が語る文脈を名前で繰り返さない |
| CCT1.8 | 短絡や条件分岐よりデフォルト引数 | 省略値はシグネチャで宣言 |
| CCT1.9 | enum で意図を語る | magic string や boolean 羅より enum（union）で値域と意味を語る |

### Ch2 Functions

| ID | 助言 | 要約 |
| --- | --- | --- |
| CCT2.1 | 引数は理想的に2個まで |
| CCT2.2 | 関数は1つのことをする |
| CCT2.3 | 関数名はすることを語る |
| CCT2.4 | 抽象レベルを1つに |
| CCT2.5 | 重複コードを削除する |
| CCT2.6 | デフォルトオブジェクトは assign か分割 | 省略時オブジェクトの構築を簡潔に |
| CCT2.7 | フラグ引数を使わない |
| CCT2.8 | 副作用を避ける（part 1） |
| CCT2.9 | 副作用を避ける（part 2） |
| CCT2.10 | グローバル関数を上書きしない |
| CCT2.11 | 命令型より関数型を好む |
| CCT2.12 | 条件をカプセル化する |
| CCT2.13 | 否定条件を避ける |
| CCT2.14 | 条件分岐を避ける（多態） |
| CCT2.15 | 型検査を避ける | TS では型システムを使う |
| CCT2.16 | 過度に最適化しない |
| CCT2.17 | 死んだコードを削除する |
| CCT2.18 | イテレータとジェネレータ | 遅延評価の列挙で目的を語る |

### Ch3 Objects and Data Structures

| ID | 助言 | 要約 |
| --- | --- | --- |
| CCT3.1 | getter/setter を使う |
| CCT3.2 | private/protected メンバを持たせる |
| CCT3.3 | イミュータビリティを優先 | 変更よりも新しい値を作る |
| CCT3.4 | type と interface の使い分け | union には type、実装契約には interface |

### Ch4 Classes

| ID | 助言 | 要約 |
| --- | --- | --- |
| CCT4.1 | クラスを小さく | 1クラス1責務 |
| CCT4.2 | 高凝集・低結合 | 関連は集め、依存は切る |
| CCT4.3 | 継承よりコンポジション |
| CCT4.4 | メソッドチェーン |

### Ch5 SOLID

| ID | 助言 | 要約 |
| --- | --- | --- |
| CCT5.1 | 単一責任の原則（SRP） |
| CCT5.2 | 開放閉鎖の原則（OCP） |
| CCT5.3 | リスコフの置換原則（LSP） |
| CCT5.4 | インターフェース分離の原則（ISP） |
| CCT5.5 | 依存性逆転の原則（DIP） |

### Ch6 Testing

| ID | 助言 | 要約 |
| --- | --- | --- |
| CCT6.1 | TDD三原則 | 失敗テスト→実装のリズム |
| CCT6.2 | F.I.R.S.T. 規則 | Fast, Independent, Repeatable, Self-validating, Timely |
| CCT6.3 | 1テスト1概念 | 1つのテストが検証するのは1概念 |
| CCT6.4 | テスト名は意図を明かす | 名前から検証内容が読える |

### Ch7 Concurrency

| ID | 助言 | 要約 |
| --- | --- | --- |
| CCT7.1 | コールバックより Promise |
| CCT7.2 | Promise より async/await |

### Ch8 Error Handling

| ID | 助言 | 要約 |
| --- | --- | --- |
| CCT8.1 | throw/reject は常に Error 型 | プリミティブを投げない |
| CCT8.2 | 捕捉したエラーを無視しない |
| CCT8.3 | reject された Promise を無視しない |

### Ch9 Formatting

| ID | 助言 | 要約 |
| --- | --- | --- |
| CCT9.1 | TSLint から ESLint への移行 | ツールチェーン整備 |
| CCT9.2 | 一貫した大文字小文字 |
| CCT9.3 | 呼び出し元と呼び出し先は近く |
| CCT9.4 | import を整理する | 並び順・未使用 import の排除 |
| CCT9.5 | TypeScript エイリアス | 相対パス地獄を避ける |

### Ch10 Comments

| ID | 助言 | 要約 |
| --- | --- | --- |
| CCT10.1 | コメントより自己説明コード | コードで語れるものはコードで |
| CCT10.2 | コメントアウトコードを残さない |
| CCT10.3 | 履歴コメントを書かない |
| CCT10.4 | 位置マーカーを避ける |
| CCT10.5 | TODO コメント | 実装予定の明示に TODO を使える |
