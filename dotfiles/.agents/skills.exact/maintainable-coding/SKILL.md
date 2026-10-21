---
name: maintainable-coding
description: >-
  保守性を意識した実装手段の選択のためのパターンカタログ。原始的・手続き的・静的な実装を、宣言的・動的なライブラリや言語機能へ置き換える before/after/why の変換例を収める。コードを書く・変更・レビューする前に必ず読み、適用する。コードを変更・評価しない調査、文書・設定だけの作業には使わない。
---

# Maintainable Coding

## 適用境界

リポジトリに残るコード（本体・テスト・ビルド/検証コードを含む）を書く・変更・レビューする前に必ず読む。readable-coding（書き方の可読性）と同時に照合してよい。実装手段の選択をこのカタログが担い、読みやすさの技法を readable-coding が担う。`/tmp` 等の使い捨て検証スクリプトと、コードを変更・評価しない調査、文書・設定だけの作業には使わない。

## 使い方

コードを書くときは、実装手段を選ぶ局面でカタログを確認する。レビューするときは、コードをカタログの全項目と照合し、指摘にパターンID（例: Validation1）を添える。

- before は誤りではない。その場では動くが、条件の追加・データの多様化で肥大化しやすい書き方である。
- after は合格の一例であり、唯一の正解ではない。プロジェクトに導入済みのライブラリ・既存の helper があれば、新規依存を足すよりそれを優先する。
- why に適用条件を書く。条件が合わないコードに適用しない。
- パターンは方向性を示す。例に特定のライブラリが出ていなくても、「静的 → 動的」「手続き的 → 宣言的」という変換自体を同種の問題へ適用する。

## パターン

### Validation 検証

外から来るデータ（入力・API 応答・ファイル内容）は、検証してから型を与える。

#### Validation1 手動フィールド検証 → スキーマ検証

フィールドを1つずつ `typeof` で確認する分岐を、スキーマの宣言に置き換える。

##### before

```ts
function parseUser(input: unknown): User {
  if (typeof input !== "object" || input === null) {
    throw new Error("invalid user");
  }
  const { name, age } = input as { name?: unknown; age?: unknown };
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("invalid name");
  }
  if (typeof age !== "number" || !Number.isInteger(age)) {
    throw new Error("invalid age");
  }
  return { name, age };
}
```

##### after

```ts
import { z } from "zod";

const userSchema = z.object({
  name: z.string().min(1),
  age: z.number().int(),
});

type User = z.infer<typeof userSchema>;

function parseUser(input: unknown): User {
  return userSchema.parse(input);
}
```

##### why

検証ルールと型が1つのスキーマに集まり、`as` キャストと分岐が消える。ルールの追加は1行の宣言で済み、エラーメッセージの形式が揃う。Python では pydantic が同じ役割を持つ。

### Type 型と分岐

値の種類を1つの判別フィールドで表現し、分岐の網羅をコンパイラに検証させる。

#### Type1 型ガード連鎖 → 判別可能ユニオン + exhaustive switch

`typeof`・`instanceof` と `as` キャストを連ねた分岐を、判別フィールドを持つユニオンに置き換える。

##### before

```ts
type Event = { type: string; payload: unknown };

function handle(event: Event) {
  if (event.type === "click") {
    const { x, y } = event.payload as { x: number; y: number };
    // ...
  } else if (event.type === "key") {
    const { key } = event.payload as { key: string };
    // ...
  }
}
```

##### after

```ts
type ClickEvent = { type: "click"; x: number; y: number };
type KeyEvent = { type: "key"; key: string };
type Event = ClickEvent | KeyEvent;

function handle(event: Event) {
  switch (event.type) {
    case "click": {
      const { x, y } = event;
      // ...
      break;
    }
    case "key": {
      const { key } = event;
      // ...
      break;
    }
    default: {
      const _exhaustive: never = event;
      break;
    }
  }
}
```

##### why

`payload` の `as` キャストが消え、各分岐の型が正確になる。variant を追加したとき `default` の `never` 代入がコンパイルエラーになり、分岐漏れを実行前に検出する。

### Waiting 待機

終了条件が外部にある処理は、条件の成立を待つ。経過時間では待たない。

#### Waiting1 固定 sleep → 条件成立までの動的待機

結果が出る「はず」の時刻まで待つのを、結果を直接観測して待つのに置き換える。

##### before

```ts
await page.click("#submit");
await sleep(5000); // 結果が出るはずの時刻まで待つ
const result = await page.textContent(".result");
```

##### after

Playwright のように待機が組み込まれている環境では、それを直接使う:

```ts
await page.click("#submit");
const result = await page.textContent(".result"); // 要素を自動で待つ
// 明示的に待つとき:
await page.waitForSelector(".result", { state: "visible" });
```

組み込まれていない環境では、条件成立まで polling する:

```ts
async function waitFor<T>(
  check: () => Promise<T | undefined>,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let delayMs = 100;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== undefined) return value;
    await sleep(delayMs);
    delayMs = Math.min(delayMs * 2, 1000);
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}
```

##### why

固定 sleep は「遅すぎる（無駄な待ちの積み重ね）」か「早すぎる（条件未成立で失敗）」のどちらかになる。条件を直接待つと、速い環境では即座に進み、遅い環境ではタイムアウトまで確実に待つ。この変換は「完了の証拠を観測する」という方向性であり、selector・ファイルの存在・API 応答など、観測対象ごとに適用する。

### Parallelism 並行

互いに独立した I/O は並列に出す。順序の保証が要る箇所だけ直列にする。

#### Parallelism1 直列 await ループ → Promise.all / Promise.allSettled

ループの中で1件ずつ `await` するのを、まとめて並列実行に置き換える。

##### before

```ts
const users: User[] = [];
for (const id of ids) {
  users.push(await fetchUser(id));
}
```

##### after

全件の成功が必須なら `Promise.all`:

```ts
const users = await Promise.all(ids.map(fetchUser));
```

一部の失敗を許容するなら `Promise.allSettled`:

```ts
const results = await Promise.allSettled(ids.map(fetchUser));
const users = results.flatMap((r) =>
  r.status === "fulfilled" ? [r.value] : [],
);
```

##### why

N 件の直列待ち（所要時間の合計）が、最も遅い1件の時間に縮む。`allSettled` は1件の失敗で全体を落とさないときに使う。レート制限のある相手へ無制限に並列化しない。件数が増えるときは分割するか、制限付き並列の helper を使う。

### Parsing 構造化データ

構造を持つ文字列（URL・パス・JSON・YAML・HTML）は、その構造を知るパーサーへ渡す。正規表現で削り出さない。

#### Parsing1 正規表現での文字列解析 → 専用パーサー

文字列パターンの一致で構造を取り出すのを、パーサーの返す構造に置き換える。

##### before

```ts
const match = url.match(/https:\/\/([^/]+)\/([^/]+)\/(.+)/);
if (!match) throw new Error(`invalid url: ${url}`);
const [, host, owner, repo] = match;
```

##### after

```ts
const { host, pathname } = new URL(url);
const [, owner, repo] = pathname.split("/").filter(Boolean);
```

##### why

`new URL` はポート・認証情報・クエリ・percent-encoding を処理済みの構造で返す。正規表現は形式の変化（`http`、`#hash`、エンコードされた文字）で壊れる。JSON・YAML・パスも同じで、`JSON.parse`・YAML パーサー・`path` モジュールなど、対象の構造を知る手段へ渡す。

### Environment 環境と設定

プロセス外から読む設定は、入口で1回だけ検証し、型付きの値として流す。

#### Environment1 環境変数の直参照 → 検証済み設定オブジェクト

`process.env` を使う場所ごとに読み替えるのを、入口での検証に置き換える。

##### before

```ts
const dbUrl = process.env.DATABASE_URL!;
const port = Number(process.env.PORT ?? "3000");
const debug = process.env.DEBUG === "1";
```

##### after

```ts
import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().default(3000),
  DEBUG: z.boolean().default(false),
});

const env = envSchema.parse(process.env);
```

##### why

欠落・型違いが、使う箇所ごとではなく起動時に1箇所で失敗する。`!` と散らばった `Number()` 変換が消え、以降のコードは型付きの `env` を参照するだけでよい。Python では pydantic-settings が同じ役割を持つ。

### Command プロセス

外部コマンドは、変数の挿入をエスケープする実行器へ渡す。文字列連結でコマンドを組み立てない。

#### Command1 execSync + 文字列連結 → shell 実行の helper

同期 API と文字列連結でのコマンド組み立てを、エスケープ付きの実行に置き換える。

##### before

```ts
import { execSync } from "node:child_process";

const head = execSync(`git -C ${dir} rev-parse HEAD`).toString().trim();
```

##### after

```ts
import { $ } from "bun";

const head = (await $`git -C ${dir} rev-parse HEAD`).stdout.toString().trim();
```

##### why

テンプレートリテラルの変数が自動でシェルエスケープされ、空白を含むパスでの破綻とインジェクションを防ぐ。非同期で書けて、非ゼロ終了で例外になる。同期が必要な場面でのみ `execSync` を使う。
