# review-kit の試用戦略

対象プロジェクトをまだ持たないユーザーが、公開 [TodoMVC デモ](https://demo.playwright.dev/todomvc/) の1フローで `review-kit` を試すための戦略。録画専用ケースを実行し、アサーションの結果と、ステップごとの注釈入り動画とビューアを確認するまでを試用の完了条件とする。

録画の入力・手順・待ち時間・確認と報告は、この文書の親ディレクトリにある `../SKILL.md` に従う。本書は対象フローと確認内容だけを定める。

## 環境と状態の分離

- 新規の隔離ディレクトリに Playwright Test の録画環境を用意する。既存プロジェクトの設定を変更せず、通常の E2E と録画ケースのファイル・設定・出力先を分ける。通常の E2E には録画注釈や録画用の待機を加えない。
- 試行ごとに新しい browser context を作り、保存済みの storage state やユーザーのブラウザープロファイルを引き継がない。初期 URL で Todo が0件であることをアサートしてから開始する。再試行でも同じ初期状態に戻す。
- 対象は公開サイトであり、ページの取得には通信が必要となる。サイトのソースファイルや配信内容は編集せず、合成データ2件をブラウザー内で操作する。通信制限・サイト停止・UI変更で実行できない場合は、その事実を報告し、成功扱いや別サイトへの無断変更をしない。
- 注釈は `assets/load-overlay.mjs` の `loadRecordingOverlay(page, state)` を通して、録画中の実行ページ DOM に追加する。helper は実操作やアサーションを代行しないため、録画ケース側でそれらを実行し、注釈へ実イベントと値を渡す。
- ステップごとに、操作対象の実矩形を `getBoundingClientRect()` で採寸して `taskAnchor` と `target.rect` へ渡す。TodoMVC の入力欄は入力・Enter ステップの anchor に、追加された行は checkbox ステップの anchor に使う。anchor は renderer 側の固定値ではなく、そのつど採寸した実測値を使う。
- `theme` には観測したサイトの明暗を渡す。TodoMVC は背景観測（`../SKILL.md`「録画を組み込む」の「背景観測」）で初回分類した値をそのまま使い、録画中に背景が変わらないなら更新しない。

## 録画するフローとアサーション例

`Read a book` と `Buy milk` を順に追加し、前者だけを完了にする。Completed で完了済みだけを表示し、Clear completed で削除する。操作と結果をステップに分解し、ステップ数はこのフローで確定した件数を使う。

以下は Playwright Test のアサーション例。`visibleLabels` はサイトの Todo 一覧内の可視行ラベル、`remaining` は未完了件数の表示、`bookCheckbox` は `Read a book` 行の checkbox を指す。注釈の文字ではなくサイト本来の要素に locator を限定する。具体的な locator は実行時の DOM に照合する。

| 操作 | 観測する結果とアサーション例 |
| --- | --- |
| `Read a book` を入力し Enter で追加 | 可視行が1件でラベルが一致する。`expect(visibleLabels).toHaveText(["Read a book"])`。未完了件数は `expect(remaining).toHaveText("1 item left")` |
| `Buy milk` を入力し Enter で追加 | 可視行が2件で追加順に並ぶ。`expect(visibleLabels).toHaveText(["Read a book", "Buy milk"])`。未完了件数は `expect(remaining).toHaveText("2 items left")` |
| `Read a book` の checkbox をクリック | `expect(bookCheckbox).toBeChecked()`。`Buy milk` の checkbox は `not.toBeChecked()`。未完了件数は `expect(remaining).toHaveText("1 item left")` |
| Completed をクリック | 選択中のフィルターが Completed となり、`expect(visibleLabels).toHaveText(["Read a book"])`。`Buy milk` 行は `not.toBeVisible()`。未完了件数は1のまま |
| Clear completed をクリック | Completed の可視行が0件となり、`expect(visibleLabels).toHaveCount(0)`。削除前の `Read a book` 行も `toHaveCount(0)`。未完了件数は1のままで、Clear completed は `not.toBeVisible()` |

Completed の空表示は「全 Todo の削除」ではなく「表示対象の完了済み Todo がなくなった状態」である。削除ステップでは、消える前の行と、消えた後の空の一覧・未完了件数を動画で対応付ける。

各ステップで操作終了を `phase: "checking"`、結果表示を `phase: "result"` と結果の実測矩形で渡し、注釈の最低表示時間（`../SKILL.md`「録画を組み込む」の「時間と実操作の同期」）に従う。ステップの進行は生成したビューアで確認する。

DOM 注釈は全要素数やスクリーンショット比較に干渉しうる。検証対象を Todo の要素に限定し、画素比較では必要な区間だけ注釈を隠す。DOM 全体の要素数を検証する場合は、非表示だけでは要素が残るため注釈を除去する。注釈なしの同じフローとも結果を照合し、検証の意味を維持できない場合は制約として報告する。

## 完了条件と検証範囲

次の証拠を揃えて試用の完了を判断する。文書・ケースの作成やギャラリーの閲覧だけでは完了としない。

- 録画ケースを実際に実行し、初期状態と各操作のアサーションについて、実行コマンドとランナーの結果を残す。注釈の check・READ 表示から合格を推測しない。
- ビューアで再生できる無音のステップ動画を確定して保存する。`ffprobe` で各ステップ動画の映像コーデックと再生時間を確認し、全ステップの動画を確定する。動画生成・保存の失敗はテスト合否とは別に報告する。
- 最終のステップ動画を開始から終了まで再生し、各操作・操作対象・画面変化と注釈が対応することを `SKILL.md` の「確認と報告」に照合する。task label が各ステップの操作対象の上に固定され、長文が折返しで全文表示されること、badge の check が操作終了からフェードインすること、結果枠と結果ラベルが1組ずつ表示されること、入力帯が下中央・キー表示が中央基準でサイトと逆の明暗になることを含む。ビューアを `file://` で開き、フローの縦積み表示・キャプションの常時表示・ライトボックスの操作つき再生とステップ移動・移動時と終了時の前の動画の停止が動くことも確認する。短時間の表示は必要に応じて連続フレームで確認する。欠落や配置制約が残る場合は対象を明示し、録画完了とはしない。
- ケース名、実行結果、保存したステップ動画とビューアの実在パス、確認した内容、未検証事項を対応付けて報告する。自動テストの合否と、ユーザーが動画を見て行う go/no-go 判断を分ける。

この1フローで試すのは、文字入力・Enter・checkbox・フィルター・削除に伴う注釈と録画出力の連携である。popup・別タブ・iframe・ページ遷移、背景テーマの切替、動きを減らす設定、失敗時の保存、並列実行・再試行、外タイトル合成（`assets/recording-example.mjs`）などの全機能を検証済みとはしない。これらは別の対象とケースが必要となる。

## 貼り付け用の録画依頼例

以下をエージェントへの依頼として使う。

```text
review-kit を使い、新規の隔離ディレクトリに Playwright Test の録画専用環境を作成して、https://demo.playwright.dev/todomvc/ の操作をステップごとの注釈入り動画とビューアに録画して。

通常の E2E と録画ケースは分離し、新しい browser context の空の Todo 一覧から開始する。Read a book と Buy milk を順に入力して Enter で追加し、Read a book だけを完了にして、Completed で絞り込み、Clear completed で完了済みを削除する。操作と結果をステップに分解し、skill-test-strategy.md の例に沿って各操作後の結果をアサートする。

review-kit の `SKILL.md` に従い、同梱 helper で録画中のページ DOM に注釈を追加する。各ステップの task anchor と対象矩形は実 DOM で採寸し、注釈の最低表示時間に従う。サイトのソースファイルは編集しない。注釈が検証に干渉しないようにし、注釈なしの結果とも照合する。

ケースを実際に実行し、ビューアで再生できる無音のステップ動画を保存する。ffprobe とステップ動画の再生、ビューアの動作確認で確認し、ケース名、実行コマンドとアサーション結果、ステップ動画とビューアの実在パス、注釈の確認内容、制約と未検証事項を報告する。動画とビューアの生成・確認前には録画完了とせず、この1フローで skill 全機能を検証済みとはしない。
```
