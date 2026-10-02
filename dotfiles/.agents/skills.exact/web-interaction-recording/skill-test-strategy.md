# Web Interaction Recording の試用戦略

対象プロジェクトをまだ持たないユーザーが、公開 [TodoMVC デモ](https://demo.playwright.dev/todomvc/) の1フローで `web-interaction-recording` を試すための戦略。録画専用ケースを実行し、アサーションの結果と注釈入り最終 MP4 を確認するまでを試用の完了条件とする。

録画の手順・見た目・待ち時間・報告の正本は、この文書と同じディレクトリの `SKILL.md`。同梱 helper の使い方と制約は `assets/README.md` を参照する。本書は対象フローと確認内容だけを定める。

## 環境と状態の分離

- 新規の隔離ディレクトリに Playwright Test の録画環境を用意する。既存プロジェクトの設定を変更せず、通常の E2E と録画ケースのファイル・設定・出力先を分ける。通常の E2E には録画注釈や録画用の待機を加えない。
- 試行ごとに新しい browser context を作り、保存済みの storage state やユーザーのブラウザープロファイルを引き継がない。初期 URL で Todo が0件であることをアサートしてから開始する。再試行でも同じ初期状態に戻す。
- 対象は公開サイトであり、ページの取得には通信が必要となる。サイトのソースファイルや配信内容は編集せず、合成データ2件をブラウザー内で操作する。通信制限・サイト停止・UI変更で実行できない場合は、その事実を報告し、成功扱いや別サイトへの無断変更をしない。
- 注釈は `assets/load-overlay.mjs` の `loadRecordingOverlay(page, state)` を通して、録画中の実行ページ DOM に追加する。helper は実操作やアサーションを代行しないため、録画ケース側でそれらを実行し、注釈へ実イベントと値を渡す。

## 録画するフローとアサーション例

`Read a book` と `Buy milk` を順に追加し、前者だけを完了にする。Completed で完了済みだけを表示し、Clear completed で削除する。関連する操作と結果を1本の動画に収める。

以下は Playwright Test のアサーション例。`visibleLabels` はサイトの Todo 一覧内の可視行ラベル、`remaining` は未完了件数の表示、`bookCheckbox` は `Read a book` 行の checkbox を指す。注釈の文字ではなくサイト本来の要素に locator を限定する。具体的な locator は実行時の DOM に照合する。

| 操作 | 観測する結果とアサーション例 |
| --- | --- |
| `Read a book` を入力し Enter で追加 | 可視行が1件でラベルが一致する。`expect(visibleLabels).toHaveText(["Read a book"])`。未完了件数は `expect(remaining).toHaveText("1 item left")` |
| `Buy milk` を入力し Enter で追加 | 可視行が2件で追加順に並ぶ。`expect(visibleLabels).toHaveText(["Read a book", "Buy milk"])`。未完了件数は `expect(remaining).toHaveText("2 items left")` |
| `Read a book` の checkbox をクリック | `expect(bookCheckbox).toBeChecked()`。`Buy milk` の checkbox は `not.toBeChecked()`。未完了件数は `expect(remaining).toHaveText("1 item left")` |
| Completed をクリック | 選択中のフィルターが Completed となり、`expect(visibleLabels).toHaveText(["Read a book"])`。`Buy milk` 行は `not.toBeVisible()`。未完了件数は1のまま |
| Clear completed をクリック | Completed の可視行が0件となり、`expect(visibleLabels).toHaveCount(0)`。削除前の `Read a book` 行も `toHaveCount(0)`。未完了件数は1のままで、Clear completed は `not.toBeVisible()` |

Completed の空表示は「全 Todo の削除」ではなく「表示対象の完了済み Todo がなくなった状態」である。削除ステップでは、消える前の行と、消えた後の空の一覧・未完了件数を動画で対応付ける。

DOM 注釈は全要素数やスクリーンショット比較に干渉しうる。検証対象を Todo の要素に限定し、画素比較では必要な区間だけ注釈を隠す。DOM 全体の要素数を検証する場合は、非表示だけでは要素が残るため注釈を除去する。注釈なしの同じフローとも結果を照合し、検証の意味を維持できない場合は制約として報告する。

## 完了条件と検証範囲

次の証拠を揃えて試用の完了を判断する。文書・ケースの作成やギャラリーの閲覧だけでは完了としない。

- 録画ケースを実際に実行し、初期状態と各操作のアサーションについて、実行コマンドとランナーの結果を残す。注釈の完了表示から合格を推測しない。
- 録画を確定して WebM を保存し、`ffmpeg` で無音の H.264 MP4 に変換する。`ffprobe` で映像コーデックと再生時間を確認し、最終試行の MP4 を1本確定する。保存・変換の失敗はテスト合否とは別に報告する。
- 最終 MP4 を開始から終了まで再生し、各操作・操作対象・画面変化と注釈が対応することを `SKILL.md` の「確認と報告」に照合する。短時間の表示は必要に応じて連続フレームで確認する。欠落や配置制約が残る場合は対象を明示し、録画完了とはしない。
- ケース名、実行結果、WebM と最終 MP4 の実在パス、確認した内容、未検証事項を対応付けて報告する。自動テストの合否と、ユーザーが動画を見て行う go/no-go 判断を分ける。

この1フローで試すのは、文字入力・Enter・checkbox・フィルター・削除に伴う注釈と録画出力の連携である。popup・別タブ・iframe・ページ遷移、背景テーマの切替、動きを減らす設定、失敗時の保存、並列実行・再試行などの全機能を検証済みとはしない。これらは別の対象とケースが必要となる。

## 貼り付け用の録画依頼例

以下をエージェントへの依頼として使う。

```text
web-interaction-recording を使い、新規の隔離ディレクトリに Playwright Test の録画専用環境を作成して、https://demo.playwright.dev/todomvc/ の操作を注釈入り MP4 に録画して。

通常の E2E と録画ケースは分離し、新しい browser context の空の Todo 一覧から開始する。Read a book と Buy milk を順に入力して Enter で追加し、Read a book だけを完了にして、Completed で絞り込み、Clear completed で完了済みを削除する。このフローを1本に収め、skill-test-strategy.md の例に沿って各操作後の結果をアサートする。

SKILL.md と assets/README.md に従い、同梱 helper で録画中のページ DOM に注釈を追加する。サイトのソースファイルは編集しない。注釈が検証に干渉しないようにし、注釈なしの結果とも照合する。

ケースを実際に実行し、WebM を ffmpeg で無音の H.264 MP4 に変換する。ffprobe と最終 MP4 の全編再生で確認し、ケース名、実行コマンドとアサーション結果、動画の実在パス、注釈の確認内容、制約と未検証事項を報告する。MP4 生成・確認前には録画完了とせず、この1フローで skill 全機能を検証済みとはしない。
```
