# web-fetch-extraction

## 目的

`web_fetch` のフェッチ結果（ページ全文）がそのまま親エージェントのコンテキストに入り、コンテキストを汚染する問題を解決する。
子エージェント（別 LLM 呼び出し）でフェッチ結果を加工し、**親には加工結果だけを返す**。原文全文は `details.raw` に退避する（`details` は LLM コンテキストに送られないため汚染しない）。

原則: 親は原文を直接読まない。オーケストレーションで親がコード全体を持たないのと同型。

## 対象

- `web_fetch`（`dotfiles/.pi/agent/extensions.exact/web-search/index.ts`）
- `web_search` は結果が短い（5件）ため**対象外**。必要性が観測されれば同パターンで後日適用。

## 現状

`web_fetch` の `execute` は `fetchOne`（trafilatura → Jina Reader → md.dhr.wtf のフォールバック）で取得した Markdown 全文を、そのまま `content` に返している。

```ts
return { content: [{ type: "text", text }], details: { title, backend } };
```

## 設計

### API: optional `ask`（1ツール・分岐なし）

| 呼び出し                         | 挙動                                                                 |
| -------------------------------- | -------------------------------------------------------------------- |
| `web_fetch({ url })`             | デフォルトの構造化要約                                               |
| `web_fetch({ url, ask: "..." })` | `ask` を NL 指示として子に渡し、要約でも抽出でも依頼内容に従って加工 |

- 既存の `url` に `ask?: string` を追加するだけ。ツール数は増やさない。
- **要約 / 抽出のモード分岐は作らない**。抽出したいときは `ask` に自然言語で書けばよい（例:「認証エラーのレスポンス例を原文のまま抜粋して」）。
- **raw モードは作らない**（掃除済み MD を親の `content` に載せる経路も作らない）。汚染回避が主目的なので、親向け全文返却は自己矛盾になる。
- **ファイル書き出し + 出典ポインタも作らない**（v1）。再読・検証用としては魅力的だが、`web_fetch` の典型用途は一発加工で足りる。コスト（パス管理・親が全文 read する抜け道）に見合わない。

### 出力

```ts
return {
  content: [{ type: "text", text: processedText }], // 加工結果のみ
  details: { title, backend, raw: fullText }, // 全文はここ（LLM に送られない・デバッグ用）
};
```

### 子 LLM 呼び出し: createAgentSession（同プロセス・in-memory）

拡張と同一プロセスで動かす。CLI spawn はしない（プロセス起動・認証再解決・JSON パースのコストを回避）。

- `SessionManager.inMemory()`: セッション保存しない
- `noTools: "all"`: ツールなし = 実質 LLM 1回
- `DefaultResourceLoader({ systemPromptOverride })`: 加工専用の軽いシステムプロンプト
- 認証・モデルはデフォルト（親セッションと同じ AuthStorage/ModelRegistry を流用）
- `signal` は親の `ctx.signal` を伝播（abort 時に子セッションも中止）

### LLM 処理関数の抽象化（テスト性）

既存の `fetchOne(query, signal, notify, backends?)` がバックエンドを外部注入できるのと同じ精神で、LLM 処理も関数として切り出し、デフォルト実装（createAgentSession 版）をテストからモック差し替え可能にする。

```ts
export type PageProcessor = (input: {
  fullText: string;
  ask: string | undefined;
  signal?: AbortSignal;
}) => Promise<string>;
```

- デフォルト実装 `defaultPageProcessor`: createAgentSession を使う
- `web_fetch` の `execute` は `processPage(fullText, ask, signal, processor?)` を呼ぶ
- テストは固定文字列を返すモック `processor` を注入して、ask 受け渡し・フォールバック・出力構造だけを検証する（実 LLM を叩かない）

## プロンプト

システムプロンプトは1本。`ask` の有無でモードを切り替えない。

```
You process a web page for another AI agent.
If an ask is provided, follow it (summarize, extract verbatim, etc.).
If no ask is provided, output a structured summary with sections:
## 概要
## 主要な数値・事実
## 手順/コード（あればそのまま）
## 注意点
Preserve exact numbers, names, versions, code blocks, and tables when relevant.
Be concise. Do not invent content that is not on the page.
If the ask cannot be answered from the page, say so clearly and briefly describe what the page is actually about.
```

- `ask` ありのときはユーザーメッセージ側に ask を載せる（システムは共通）。
- 数値・コード・固有名は可能な限り原文を保持する旨をシステム側で固定（親の ask が雑でも潰れにくくする）。
- 出力言語は**日本語固定**（親エージェントが日本語運用のため）。※要検討: ページ言語維持 / 親の指示言語に追従。一旦日本語固定で実装し、運用して違和感があれば見直す。

## フロー

```
親: web_fetch({ url }) or web_fetch({ url, ask })
  └─ execute
       1. fetchOne(url) → fullText, backend        （既存ロジックそのまま）
       2. pageTitle(url) → title                    （既存ロジックそのまま）
       3. processPage(fullText, ask, signal):
            a. fullText が巨大ならトランケート（閾値は別途、仮: 50KB）
            b. createAgentSession(in-memory, noTools, systemPromptOverride)
            c. session.prompt(共通プロンプト + 任意の ask + <content>fullText</content>)
            d. 最終 assistant テキストを取得
            e. 子 LLM 失敗時はフォールバック（下記）
       4. return { content:[処理結果], details:{ title, backend, raw: fullText } }
```

## フォールバック

- **子 LLM エラー/タイムアウト**: `content` には短いエラー文言のみ（例: `（加工失敗: <原因>。details.raw に全文）`）。全文は `details.raw` に必ず残す。親コンテキストにはエラー文言しか入らないので汚染は最小。
- **ページ巨大**: `fullText` を閾値（仮: 50KB）でトランケートしてから子 LLM へ。`details.raw` には**トランケート前の全文**を保持。閾値・チャンク分割要否は運用して調整。

## 伝言ゲームとリカバリ（運用上の前提）

子経由は必ず情報を落とす。比較対象は「直接読む理想」ではなく「全文で親コンテキストを汚染した状態」。

- 不十分なら **`ask` を変えて取り直す**のを正規の手とする（同じ URL で再呼び出し可）。
- `web_fetch` が言えるのは「このページについて」まで。「ウェブに無い」は search / オーケストレーション側の判断。

## 後から足す兆候（先回りしない）

### 判定ラベル（取れた / 一部 / このページにはない）

親が次を誤歸因する実例が観測されたら、返答フォーマットに判定＋中身を足す。

- あるのに「無い」と早合点する
- このページに無いのに ask をいじり続けて探し続ける
- 本当に無いのに探し続ける / あるのに諦める

v1 では本文のみ。ラベル設計は観測後。

### ファイル書き出し + 出典ポインタ

要約の検証のため親が指定行だけ読む必要が頻発したら検討。v1 では作らない。

### 親向け raw（掃除済み MD を content に載せる）

原則に反するので基本は足さない。どうしても必要なら、汚染を承知した例外経路として別途設計する（デフォルトにはしない）。

## テスト方針

既存 `index.test.ts`（`bun --install=auto run index.test.ts`、自作 `describe`/`it` + `node:assert/strict`）のパターンを踏襲。

追加する検証（モック processor 注入、実 LLM は叩かない）:

- `web_fetch({ url })`（ask なし）→ content は加工結果、details.raw に全文
- `web_fetch({ url, ask })` → ask が processor に渡っていること
- モック processor が受け取る引数（fullText, ask, signal）の検証
- 子 LLM 失敗フォールバック: content はエラー文言、details.raw に全文
- 巨大テキストのトランケート: processor に渡る text は閾値以下、details.raw は全文
- 既存テスト（fetchOne フォールバック・表示・pageTitle）は温存

実 LLM を叩く統合テストは、processor をデフォルト実装にした上で `// 実行: bun ...` で手動実行可能にする（CI には載せない、既存の実バックエンドテストと同じ扱い）。

## 未決定・懸念点

- **子セッションを使い回すか**: 毎回 `createAgentSession` を new すると初期化コストが積む。システムプロンプトは共通なので使い回しは以前より簡単。一旦「毎回 new」で実装し、ボトルネック観測でプール/使い回しを検討。
- **signal 伝播の方法**: `createAgentSession` のオプションで `signal` を受け取れるか、`session.abort()` を親 signal の abort で呼ぶラッパが必要か。実装時に SDK の型を確認して決める。
- **出力言語**: 日本語固定で始める。運用して違和感あればページ言語維持等に見直し。
- **トランケート閾値**: 仮 50KB。子モデルのコンテキストウィンドウと実ページサイズ分布を見て調整。

## タスク

- [ ] `PageProcessor` 型と `defaultPageProcessor`（createAgentSession 版）を実装
- [ ] `processPage(fullText, ask, signal, processor?)` を実装（トランケート・フォールバック）
- [ ] `web_fetch` の parameters に `ask?: string` を追加
- [ ] `web_fetch` の `execute` を `fetchOne` → `processPage` → 出力、に組み替え
- [ ] `details.raw` に全文を保持
- [ ] 共通システムプロンプト定義（ask 有無はユーザーメッセージ側）
- [ ] signal 伝播の実装（SDK 型確認含む）
- [ ] テスト追加（モック processor・ask 受け渡し・フォールバック・トランケート）
- [ ] 既存テストの回帰確認
- [ ] 手動で実 LLM を通す（ask なし要約・ask あり抽出寄り・失敗時）
