# ADR: rime — 日本語入力環境の選定

|  |  |
| --- | --- |
| **Status** | Accepted |
| **Subject** | 日本語入力環境に MS-IME・Mozc などではなく Rime（Kagiroi スキーマ）を採用した理由 |

---

## 機能要件

| # | 機能要件 |
| --- | --- |
| F1 | MS-IME 標準の「n の過不足を修正（ローマ字入力時）」相当の変換をする（`kanda` → かんだ、 `konnnda` → かんだ） |
| F2 | Windows と Linux で同じ変換エンジンと設定を使う |
| F3 | 設定を YAML などのテキストファイルで dotfiles 管理でき、キー操作と変換ルールを利用者側で追加・変更できる |

## 候補比較

| 候補 | F1 n 補正 | F2 両 OS | F3 dotfiles 管理・拡張 | 判定 |
| --- | --- | --- | --- | --- |
| MS-IME | ✓ 標準機能（比較基準） | ✗ Windows のみ | △ ローマ字表は共通 DSL から生成、キー設定はレジストリのスナップショット。変更は可能だが解析・適用の独自実装を要した | 不採用 |
| Mozc | ✗ n 不足側（`konnitiha` → こんにちは）は標準・ローマ字テーブル・fork のいずれでも不可。n 過多側はローマ字テーブルで fork 不要に実現可。`use_typing_correction` は OSS 版に補正本体がなく prediction 限定 | ✓ | ✓/△ 設定はファイルで管理（text proto の設定管理・ローマ字表 TSV・GUI 設定の取り込みまで実装）。ローマ字テーブルとキーマップは変更可。変換辞書と連接評価の差し替えは現実的でない | 不採用 |
| Google 日本語入力 | 記録なし | ✗ Linux 非対応（Windows / macOS 向け） | 記録なし（扱いにくいという事後推測のみ残る） | 不採用（当初の判断記録なし） |
| Rime | ✓ speller/algebra と Lua でデータ駆動に実装できる | ✓ frontend は Weasel / fcitx5-rime | ✓ 設定は YAML / Lua。C++ プラグイン不要 | 採用 |

補足:

- Mozc は検討にとどまらず、設定管理の実装・導入・GUI 設定の取り込みまで行った最初の移行先だった。F1 を満たせないことがソース調査で確定し、Rime への再移行を決定した。
- 検討された中間構成は 2 つ。(a) MS-IME 継続＋dotfiles による設定管理（実際に運用した）。(b) Windows での MS-IME と Mozc の共存（`Win+Space` 切替。Mozc 導入時も MS-IME は無効化されないことを確認済み）。
- Google 日本語入力は Linux に非対応で、Linux では基盤の OSS である Mozc を使うことになる。採用可否の比較・判断記録は見つかっていない。
- ATOK・SKK は IME 候補としては現れていない（ATOK は MS-IME のキー設定プロファイル名としてのみ登場）。

## Rime 内の選定

Rime は IME の枠組みであり、日本語スキーマと frontend を別に選ぶ。

### スキーマ

| スキーマ | 構成 | 保守状況 | 判定 |
| --- | --- | --- | --- |
| gkovacs/rime-japanese | 語単位 code、連接評価なし | 更新停滞気味 | 不採用 |
| rimeinn/rime-kagiroi | モーラ単位 code、Mozc 由来の辞書と連接表、Lua Viterbi | 更新中 | 採用 |

両方ともカスタム YAML で拡張できる。Kagiroi は Mozc 由来の辞書・連接データを Rime で使う構成で、連接評価つきの候補決定と更新性を根拠に選んだ。採用時の本人の言葉は「kagiroiでもカスタムyamlできるなら、gkovacsを使う意味はなくてkagiroi一択でいいのでは？」「mozcと同じデータを使ってるみたいな」。スキーマ間の変換品質を実測比較した記録はない。

### frontend

| frontend | OS | 判定 |
| --- | --- | --- |
| Weasel | Windows | 採用 |
| fcitx5-rime | Linux | 採用 |
| ibus-rime、Squirrel | Linux / macOS | 対象外（利用環境にない） |
