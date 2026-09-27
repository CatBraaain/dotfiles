---
name: web-interaction-recording
description: ユーザーが Playwright Test または Vitest から Playwright を使う E2E テストの録画を明示的に求めたときに使う。録画の実行を別途指示されなくても、通常の E2E とは別に主要操作をレビューできるアサーション付き録画ケースを作り、テストごとの MP4 にタイトル・経過時間・疑似カーソル・クリック波紋・入力テキスト帯を付け、ユーザーが録画済み動画を見て go/no-go を判断できる状態にする。録画の指示がない E2E 作業や録画済み動画のレビューだけでは使わない。
---

# Web Interaction Recording

## 録画の境界

対象は、ユーザーが録画を求めた Playwright Test、または Vitest から Playwright ライブラリでブラウザーを操作する E2E テスト。通常の E2E の網羅性は維持し、そのテストとは別に主要なウェブ使用フローごとの録画専用操作ケースを作る。録画ケースでは一連の操作と画面上の結果を人が追えるようにし、結果を検証する自動アサーションも置く。録画の実行を別途指示されなくても、録画ケースを実行して動画を生成する。通常の E2E には録画用の設定変更・実行・動画生成を適用しない。既存のランナーを録画のためだけに移行しない。

録画は操作と画面上の結果を人がレビューするためのもの。ランナーの自動テスト結果と、ユーザーが動画を見て行う go/no-go 判断を区別する。画面上の表示からアサーションの成否を推測せず、実際に実行したランナーの結果を自動テストの合否とする。テストデータの選定はテストケースを設計する側の責務であり、この skill は入力値の検査やマスクを追加しない。

## 録画を組み込む

まず対象プロジェクトのランナー、既存の E2E helper / fixture、reporter、動画の保存先、主要なウェブ使用フローを調べる。どちらのランナーでも Playwright のページ動画を WebM で保存し、`ffmpeg` で無音の H.264 MP4 に変換する。ページ画面を隠さない上部余白にテストタイトルと経過時間を表示する。参考モジュールは skill 内で実行するツールではなく、対象プロジェクトへコピーまたは必要な部分を移植して調整する素材である。

- [references/recording-fixture.ts](references/recording-fixture.ts): Playwright Test 用 fixture。`page` に疑似カーソル、クリック波紋、文字入力とショートカットを示す固定幅の暗いテキスト帯を重ね、`clickWithMotion(page, locator)` でクリック前のカーソル移動を録画する。
- [references/recording-reporter.ts](references/recording-reporter.ts): Playwright Test 用 reporter。添付された WebM のうち最後の試行の最初のページを各テスト1本として選び、`ffmpeg` でタイトル・経過時間を描画して `./recordings/` に MP4 を保存する。

### Playwright Test の場合

Playwright Test の `video: 'on'` を録画専用 spec のトップレベル、または録画専用 project の設定に置き、ファイルや `--grep` 等で録画ケースだけを実行する。`video` は worker scope の設定なので describe 内の `test.use()` には置かない。録画時に参考 fixture と reporter を組み込み、録画ケースが fixture の `test` を使うようにする。既存の `expect` やカスタム fixture は維持する。カスタム fixture を使うプロジェクトでは、無条件に import を置き換えず、既存 `test` に録画用の `page` fixture を統合する。既存 reporter は残し、録画 reporter を追加する。例（パスはコピー先に合わせる）:

```ts
// playwright.config.ts
reporter: [["list"], ["./tests/support/recording-reporter.ts"]],

// tests/checkout.recording.spec.ts
import { expect } from "@playwright/test";
import { clickWithMotion, test } from "./support/recording-fixture";
test.use({ video: "on" });
test("checkout flow", async ({ page }) => {
  await page.goto("/checkout");
  await clickWithMotion(page, page.getByRole("button", { name: "Submit" }));
  await expect(page.getByRole("status")).toHaveText("Order placed");
});
```

### Vitest から Playwright を使う場合

既存の Vitest E2E helper とテスト選択・起動方法を維持する。参考 fixture と reporter は `@playwright/test` に依存するので、そのまま import しない。参考 fixture の `installOverlay` と `clickWithMotion` を Playwright ライブラリの `Page` / `Locator` 型で helper へ移植し、録画するページを作る前に `context.addInitScript(installOverlay)` を登録する。参考 reporter の `convertVideo` 相当の処理を helper へ移植し、上部余白への描画と保存先を合わせる。既存の装飾・変換処理が要件を満たすなら重複して追加しない。

録画対象のテストでは `browser.newContext({ recordVideo: { dir: recordings, size }, viewport: size })` からページを作る。ページと context を閉じてから `page.video()?.saveAs(webmPath)` で WebM を保存し、MP4 に変換する。シナリオが失敗しても `finally` で保存を試み、保存・変換例外は個別に捕捉して元のテスト失敗を上書きせず、録画失敗として別に報告する。describe 階層を含む完全なテストタイトルを helper へ渡し、並列実行するケースの出力名が衝突しないようにする。再試行を使う場合は試行別の一時ファイルへ保存し、全試行後に最後の試行の対象ページの MP4 だけを確定して先行試行の一時ファイルを片付ける。最終試行を選別できない構成なら、その制約と残った動画を報告し、各テスト1本と主張しない。context を閉じる前に動画を保存しようとしない。

### 共通の確認

`ffmpeg` の `libx264` と `drawtext` が利用できることを確認する。既存の package manager、Playwright バージョン、プロジェクト・ブラウザ設定で録画ケースを実行する。録画を有効にした設定や helper が後続の通常実行でも録画する場合、依頼が一時的な録画なら組み込みの変更を残さない。報告する MP4 は実際に出力されたパスから確認する。変換エラーはテスト合否とは別に報告し、MP4 が欠けた場合は録画完了としない。

## 操作を読みやすくする

録画開始前に画面サイズを一定にし、必要なテストだけを実行する。操作を人が追える間隔で進めるが、待機時間の追加で録画ケースのアサーションの意味を変えない。移動を見せたいクリックには `clickWithMotion(page, locator)` を使う。途中のマウス移動イベントを実時間で発生させてから `locator.click()` するため、カーソルが対象へ移動してクリック位置に波紋が出る。通常の `locator.click()` には移動のペーシングがない。必要なクリックがポップアップや画面遷移を起こすときは、遷移前に動きが見えることを確認する。

画面下部中央の固定幅の暗い帯に、入力中の文字を一つの連続した文字列として表示する。`Ctrl + A` / `Meta + A` は操作名に置き換え、続く文字入力は新しい文字列として表示し、Backspace では削除後の文字列に更新する。表示対象の最後のキー（keydown がない場合は値の更新）による帯の更新から約600ms後に帯全体を300msでフェードさせる。Backspace 直後の文字入力は、削除結果が見えるまで表示を最大160ms遅らせる。帯の位置と幅は文字列が変わっても動かない。`locator.fill()` のように keydown なしで文字入力対象に `input` が起きた場合は、その対象の値を表示する。checkbox など文字入力対象でない要素の `input` は表示しない。文字が順に増える様子を見せたいシナリオでは、操作の意味が変わらないことを確かめて `pressSequentially()` を使う。

装飾は DOM に要素を追加する。スクリーンショット比較や全要素数を調べるアサーションには影響しうるため、その間だけ装飾を隠すなどして期待値とテストの意味を維持し、装飾なしの結果とも照合する。維持できなければ録画の制約として報告し、合否が変わらないとは主張しない。

参考 fixture や上記の Vitest helper が装飾・保存するのは指定した `page` だけである。ポップアップ、複数ページ、iframe 内の操作を主に確認したい場合は、対象ページへの組み込みと動画の選択を調整してから「各テストの操作が収まる」と報告する。画面外のアサーションやネットワーク結果は映像だけでは判定しない。

## 確認と報告

録画ケースごとに MP4 が1本あるか、上部に describe 階層を含むタイトルと経過時間が読めるか、連続フレームでカーソルの中間位置・拡大する波紋・画面下部中央で動かない帯への連続した文字入力と帯全体のフェードが確認できるか、失敗したテストも録画されたかを確認する。ショートカット、Backspace、keydown なしの文字入力、非文字入力対象の操作を含む場合は、文字列の更新と、非文字入力の値が帯に出ないことも確認する。`ffprobe` で動画の映像コーデックと再生時間を確認し、対象の MP4 をそれぞれ再生して、開始から終了までテストの操作と画面上の結果を追えるか確かめる。ユーザーが動画を見て go/no-go を判断できるよう、各録画ケース・対象の主要なウェブ使用フロー・動画のパス・アサーションを含む自動テスト結果を対応付ける。通常の E2E の実行結果と録画ケースの実行結果、動画に対する人手の go/no-go 判断を区別し、映像だけでは判断できない点も報告する。

動画レビューまで依頼された場合は、失敗テストを先に確認し、指摘には動画パス、経過時間、見えた事実を添える。失敗と判定できない見た目は観測として区別し、動画を見ただけでテストのアサーションが成功したと結論しない。
