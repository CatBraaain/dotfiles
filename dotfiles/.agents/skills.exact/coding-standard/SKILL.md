---
name: coding-standard
description: >-
  コードを読みやすくし、小さく保つための good/bad 例集。名前・条件・制御フロー・関数・変数・構成・テスト・選択・コメントの50例を収める。コードを書く・変更・レビューする前に必ず読み、適用する。コードを変更・評価しない調査、文書・設定だけの作業には使わない。
---

# Coding Standard

## 読みやすさの技法

コードを下のカタログの全項目と漏れなく照合する。カタログの項目をレビューに使うときは、指摘に項目ID（例: A1）を添える。

各 after は「合格の一例」であり、唯一の正解ではない。

### A 名前

名前は中身・単位・状態・制約を語る。読み手は名前から予測して読む。

#### A1 抽象名 (Readable Code)

`data` `info` `value` など中身を言わない名前。入っているものを具体的に言う。

##### before

```ts
const data = await fetchUser(id);
```

##### after

```ts
const user = await fetchUser(id);
```

#### A2 単位が読めない名前 (Readable Code)

`timeout` がミリ秒か秒か分からない。単位を名前に添える。

##### before

```ts
await sleep(timeout); // timeout = 5000（ミリ秒）
```

##### after

```ts
await sleep(timeoutMs);
```

#### A3 検証状態が読めない名前

ユーザー入力（未検証）と検証済みの区別が名前から分からない。安全に関わる区別は名前で分ける。

##### before

```ts
export function normalize(url: string): URL {
  if (!url.startsWith("https:")) {
    throw new Error("https only");
  }
  return new URL(url);
}
```

##### after

```ts
export function normalize(unsafeUrl: string): URL {
  if (!unsafeUrl.startsWith("https:")) {
    throw new Error("https only");
  }
  return new URL(unsafeUrl);
}
```

#### A4 真偽が読めない名前 (Readable Code)

`flag` は何の真偽か分からない。`is/has/can/should` 接頭辞で振る舞いを語る。

##### before

```ts
const flag = rows.length === 0;
```

##### after

```ts
const isEmpty = rows.length === 0;
```

#### A5 二重否定 (Readable Code)

`!isNotFound`（見つかっていない、でない）は読み直しが起きる。肯定形にする。

##### before

```ts
const isNotFound = rows.length === 0;
if (!isNotFound) retry();
```

##### after

```ts
const isFound = rows.length > 0;
if (isFound) retry();
```

#### A6 範囲の包含が不明な名前 (Readable Code)

`end` に含めるのか不明。包含境界は `first/last`、上限下限は `max/min`。

##### before

```ts
function page(items: Item[], end: number) {
  return items.slice(0, end + 1); // end を含む
}
```

##### after

```ts
function page(items: Item[], last: number) {
  return items.slice(0, last + 1);
}
```

#### A7 意図が一意でない名前 (Readable Code)

`filter` は残すのか除くのか曖昧。一意な語にする。

##### before

```ts
const result = users.filter(isDeleted);
```

##### after

```ts
const deletedUsers = users.filter(isDeleted);
```

#### A8 一貫しない語彙 (Clean Code)

同じ概念を `user` `member` `customer` と別の語で呼ぶ。同種のものには同じ語彙を使い、違いを名前で比較できるようにする。

##### before

```ts
function loadUser(id: string) {}
function fetchMember(id: string) {}
function getCustomer(id: string) {}
```

##### after

```ts
function loadUser(id: string) {}
function fetchUser(id: string) {}
function getUser(id: string) {}
```

#### A9 曖昧な動詞

`check` は「検証して真偽を返す」のか「確認してから操作する」のか動詞から読めない。検証なら `validate`、条件を問うなら `has/is`、行為を直接言う。

##### before

```ts
function process(user: User) {
  checkUser(user);
  grant(user);
}
```

##### after

```ts
function process(user: User) {
  validateUser(user);
  grant(user);
}
```

#### A10 出所が読めない取得動詞

`get/load/fetch` は出所と重さが違う。メモリなら `get`、ストレージなら `load`、ネットワークなら `fetch`、と何をどこから取得するのか動詞から分かるようにする。

##### before

```ts
const data = getData(); // 何のデータを、どこから?
const config = loadData(); // ネットワークへ取りに行くのか?
```

##### after

```ts
const data = getUserDataFromCache();
const config = fetchConfigFromApi();
```

#### A11 副作用が読めない動詞

`get` は副作用のない取得の慣習。取得に伴って作成・書き込みが起きるなら、名前に含める。

##### before

```ts
const session = getSession(user); // 無いと新規作成される
```

##### after

```ts
const session = getOrCreateSession(user);
```

#### A12 発音でき検索できる名前 (Clean Code)

発音できない名前は議論と検索（grep）を妨げる。略語は一般に知られているものだけにする。

##### before

```ts
const u = await db.findUser(id); // 後で `u` で grep しても大量にヒットする
```

##### after

```ts
const user = await db.findUser(id);
```

#### A13 冗長な型接頭辞を避ける (Clean Code / Code Complete)

宣言や推論で分かる型を名前に繰り返さない（ハンガリアン記法の乱用を避ける）。

##### before

```ts
const userNameString = user.name;
const isActiveBool = user.isActive;
```

##### after

```ts
const userName = user.name;
const isActive = user.isActive;
```

### B 式と条件

複雑な条件は名前が意味を語る形へ。裸のリテラルと重複した条件を残さない。

#### B1 複雑な条件は変数で受ける (Readable Code)

複数条件の意図を `if` に直接書かず、名前が意味を語る変数で受ける。込み入った否定は De Morgan の法則で整理してから受ける。

##### before

```ts
const THIRTY_DAYS_MS = 2_592_000_000;
if (
  user.age >= 20 &&
  user.hasId &&
  !user.banned &&
  Date.now() - user.registeredAt > THIRTY_DAYS_MS
) {
  grant(user);
}
```

##### after

```ts
const THIRTY_DAYS_MS = 2_592_000_000;

const isEligibleForGrant =
  user.age >= 20 &&
  user.hasId &&
  !user.banned &&
  Date.now() - user.registeredAt > THIRTY_DAYS_MS;
if (isEligibleForGrant) {
  grant(user);
}
```

#### B2 magic number (Refactoring.com / Clean Code / Code Complete)

裸の数値リテラルは意味が読めない。名前付き定数にする。

##### before

```ts
if (retryCount > 3) {
  throw new Error("too many retries");
}
```

##### after

```ts
const MAX_RETRIES = 3;
if (retryCount > MAX_RETRIES) {
  throw new Error("too many retries");
}
```

#### B3 同じ条件の繰り返し (Refactoring.com / Readable Code)

同じ条件式が複数箇所に複製されている。述語関数に括り出す。

##### before

```ts
function shipOrder(order: Order) {
  if (order.status === "paid" && !order.cancelled) {
    queueForShipping(order);
  }
}
function getShippableOrders(orders: Order[]) {
  return orders.filter((o) => o.status === "paid" && !o.cancelled);
}
```

##### after

```ts
function isShippable(order: Order) {
  return order.status === "paid" && !order.cancelled;
}
function shipOrder(order: Order) {
  if (isShippable(order)) {
    queueForShipping(order);
  }
}
function getShippableOrders(orders: Order[]) {
  return orders.filter(isShippable);
}
```

#### B4 同じ結果の条件をまとめる (Consolidate Conditional Expression / Refactoring.com)

同じ結果を返す複数の条件は、1つの条件にまとめる。

##### before

```ts
if (code === "expired") {
  return reject(code);
}
if (code === "invalid") {
  return reject(code);
}
```

##### after

```ts
if (code === "expired" || code === "invalid") {
  return reject(code);
}
```

### C 制御フロー

ネストは浅く、条件は予測どおりの向きで、副作用を演算子に隠さない。

#### C1 深いネスト (Readable Code)

ネストは深くしない。ガード節・早期 `continue` / `return` で平坦にする。

##### before

```ts
for (const o of orders) {
  if (o.paid) {
    if (o.total > 0) {
      ship(o);
    }
  }
}
```

##### after

```ts
for (const o of orders) {
  if (!o.paid || o.total <= 0) continue;
  ship(o);
}
```

#### C2 条件の向き (Readable Code)

左辺は調べる対象、右辺は定数。読み手の「主語と述語」になる。

##### before

```ts
while (maxAttempts > attempts) {
  attempts++;
}
```

##### after

```ts
while (attempts < maxAttempts) {
  attempts++;
}
```

#### C3 末尾条件のループ (Code Complete)

`do/while` は条件が末尾にあり見逃しやすい。先頭条件の形へ。

##### before

```ts
let nextPage;
do {
  nextPage = await fetchNext();
} while (hasMorePages);
```

##### after

```ts
let nextPage = await fetchNext();
while (hasMorePages) {
  nextPage = await fetchNext();
}
```

#### C4 式の中に副作用を隠さない (Readable Code)

三項演算子・`&&`・`||`・`map` の中に制御や副作用を隠さない。値の決定と変換は、副作用と分ける。

##### before

```ts
const label = count > 1 ? (console.warn("many"), "items") : "item";
const names = users.map((u) => {
  audit.push(`visited-${u.id}`);
  return u.name;
});
```

##### after

```ts
if (count > 1) {
  console.warn("many");
}
const label = count > 1 ? "items" : "item";

const names = users.map((u) => u.name);
users.forEach((u) => audit.push(`visited-${u.id}`));
```

### D 関数と副作用

関数は一つのことだけ、引数は少なく、名前と振る舞いを一致させる。

#### D1 副作用の混入 (Clean Code)

関数は「する」か「答える」かの一方。`get` なのに状態を変えない。

##### before

```ts
function getConfig(): Config {
  audit.push("config-read");
  return settings;
}
```

##### after

```ts
function getConfig(): Config {
  return settings;
}

function logConfigRead(): void {
  audit.push("config-read");
}
```

#### D2 長い関数の分割 (Refactoring.com / Clean Code)

複数の抽象レベル・目的が1つの関数に混在している。意味のある小関数へ抽出し、本体を手順として読める形にする。

##### before

```ts
function processOrder(order: Order) {
  // 検証
  if (!order.paid) throw new Error("unpaid");
  // 合計計算
  let total = 0;
  for (const item of order.items) {
    total += item.price * item.quantity;
  }
  // 送信
  api.post(`/orders/${order.id}`, { total });
}
```

##### after

```ts
function processOrder(order: Order) {
  assertPaid(order);
  api.post(`/orders/${order.id}`, { total: calcTotal(order.items) });
}

function assertPaid(order: Order) {
  if (!order.paid) throw new Error("unpaid");
}

function calcTotal(items: Item[]) {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}
```

#### D3 booleanフラグ引数 (Clean Code)

フラグ引数は呼び出し側の意味（`true` が何を意味するか）を読めなくする。関数を2つに分ける。

##### before

```ts
function renderButton(label: string, isPrimary: boolean) {}
renderButton("Save", true);
renderButton("Cancel", false);
```

##### after

```ts
function renderPrimaryButton(label: string) {}
function renderSecondaryButton(label: string) {}
```

#### D4 引数が多すぎる (Clean Code / Refactoring.com)

独立した引数が多い関数は呼び出し側で順序を間違えやすい。意味のあるまとまりへオブジェクト化する。

##### before

```ts
function createUser(
  name: string,
  email: string,
  role: string,
  expiresAt: number,
  locale: string,
) {}
```

##### after

```ts
interface NewUser {
  name: string;
  email: string;
  role: string;
  expiresAt: number;
  locale: string;
}
function createUser(user: NewUser) {}
```

#### D5 エラー処理の分離 (Clean Code)

通常処理にエラー分岐を混在させず、エラー処理を本体から分離する。

##### before

```ts
async function sync() {
  try {
    const data = await fetchAll();
    const filtered = data.filter(isActive);
    await push(filtered);
  } catch (error) {
    console.error("sync failed", error);
    retry();
  }
}
```

##### after

```ts
async function sync() {
  try {
    await syncAll();
  } catch (error) {
    console.error("sync failed", error);
    retry();
  }
}

async function syncAll() {
  const data = await fetchAll();
  const filtered = data.filter(isActive);
  await push(filtered);
}
```

#### D6 未使用の変数・引数の削除 (Refactoring.com)

使用されない引数・変数は保守対象を増やすだけ。定義から取り除く。

##### before

```ts
function createUser(
  name: string,
  email: string,
  legacyId?: string,
  externalRef?: string,
) {
  const user = { name, email };
  const createdAt = new Date();
  db.insert(user);
}
```

##### after

```ts
function createUser(name: string, email: string) {
  const user = { name, email };
  db.insert(user);
}
```

#### D7 例外に文脈を付ける (Clean Code)

例外メッセージは原因と対象を含む。`failed` だけでは調査の出発点にならない。

##### before

```ts
if (!res.ok) {
  throw new Error("request failed");
}
```

##### after

```ts
if (!res.ok) {
  throw new Error(`fetchUser failed: status=${res.status} id=${id}`);
}
```

### E 変数

スコープを最小に、再代入を避け、使い回さない。

#### E1 宣言位置 (Readable Code)

宣言は使う直前で。使用箇所から遠い宣言は読み手の保持量を増やす。

##### before

```ts
let totalRows, maxRetries;

// --- ここから 50 行の無関係な処理 ---

const summary = `${totalRows} rows, ${maxRetries} retries`;
```

##### after

```ts
// --- ここから 50 行の無関係な処理 ---

const totalRows = 0;
const maxRetries = 3;
const summary = `${totalRows} rows, ${maxRetries} retries`;
```

#### E2 スコープを狭める (Readable Code)

変数の見える範囲は必要最小限に。広いスコープに置かれた可変変数は、どこで変わるか追えなくなる。

##### before

```ts
let activeUsers: User[] = [];

function loadUsers() {
  activeUsers = db.activeUsers();
}
function greet() {
  for (const u of activeUsers) {
    console.log(`hi ${u.name}`);
  }
}
```

##### after

```ts
function loadUsers(): User[] {
  return db.activeUsers();
}
function greet(users: User[]) {
  for (const u of users) {
    console.log(`hi ${u.name}`);
  }
}
```

#### E3 再代入 (Readable Code)

一度決まった値は変わらない方が追いやすい。再代入を避け、段階に名前を付ける。

##### before

```ts
let name = raw.trim();
name = name.toLowerCase();
name = name + suffix;
```

##### after

```ts
const trimmed = raw.trim();
const lowered = trimmed.toLowerCase();
const name = lowered + suffix;
```

#### E4 無意味な中間変数 (Readable Code)

値の由来が自明で、名前が何も語らない中間変数は消す。名前が意図を語る説明変数 (B1) は消さない。

##### before

```ts
const result = computeTotal(items);
return result;
```

##### after

```ts
return computeTotal(items);
```

#### E5 変数の使い回し (Code Complete)

1つの変数を複数の目的で再利用する。目的ごとに名前と寿命を分ける。関数の引数の再割り当ても同じ。

##### before

```ts
let tmp = new Date();
log(tmp);
tmp = new Date(deadlineEpoch);
save(tmp);

function formatName(name: string) {
  if (!name.trim()) {
    name = "unknown";
  }
  return name;
}
```

##### after

```ts
const createdAt = new Date();
log(createdAt);
const deadline = new Date(deadlineEpoch);
save(deadline);

function formatName(rawName: string) {
  const displayName = rawName.trim() ? rawName : "unknown";
  return displayName;
}
```

### F 構成と構造

読み順・段落・分割を整え、死んだコードと重複を残さない。

#### F1 読み順 (Readable Code)

ファイルは新聞記事のように、冒頭に主要な流れ、末尾に細部。JavaScript 等は関数の巻き上げで主要な流れを上に置ける。巻き上げがない言語 (Python・PowerShell 等) では、主要な関数を上に定義し、サブ関数をその下へ、実行の呼び出しは最後の行に置く。

##### before

```ts
const MAX = 100;
function parseLine(l: string) {}
export function main() {}
```

##### after

```ts
export function main() {}

function parseLine(l: string) {}
const MAX = 100;
```

巻き上げがない言語では、最後の行で入口を呼ぶ:

```python
def main():
    for line in read_input():
        print(parse_line(line))

def read_input():
    ...
def parse_line(line):
    ...

main()
```

#### F2 初期化順

概要を上に置くより、依存関係と初期化順を優先する。

##### before

```ts
export const registry = buildRegistry(); // 下の定数に依存
const DEFAULTS = {};
```

##### after

```ts
const DEFAULTS = {};
export const registry = buildRegistry();
```

#### F3 段落分け (Readable Code)

連続した処理を空白行で論理段落に分け、構造を目で追えるようにする。

##### before

```ts
const raw = readInput();
const data = parse(raw);
const valid = data.filter(isValid);
const label = valid.length > 1 ? "items" : "item";
const summary = `${valid.length} ${label}`;
write(summary);
```

##### after

```ts
const valid = readInput().map(parse).filter(isValid);

const label = valid.length > 1 ? "items" : "item";
const summary = `${valid.length} ${label}`;

write(summary);
```

#### F4 死んだコード

コメントアウトされたコードは読み手の時間を奪う。削除する。必要になったら履歴から戻す。

##### before

```ts
function main() {
  // const legacy = loadLegacyConfig();
  // apply(legacy);
  const config = loadConfig();
  apply(config);
}
```

##### after

```ts
function main() {
  const config = loadConfig();
  apply(config);
}
```

#### F5 不要な間接化 (Refactoring.com)

名前が説明を加えないラッパーは保守対象を増やすだけ。呼び出し位置へ展開する。

##### before

```ts
function getName(user: User) {
  return user.name;
}
console.log(getName(user));
```

##### after

```ts
console.log(user.name);
```

#### F6 重複の抽出 (Clean Code)

同じロジックの複製は、1つの名前付き処理へまとめる。

##### before

```ts
function importUsers(rows: Row[]) {
  for (const row of rows) {
    if (!isValid(row)) continue;
    db.insert("users", row);
  }
}
function importOrders(rows: Row[]) {
  for (const row of rows) {
    if (!isValid(row)) continue;
    db.insert("orders", row);
  }
}
```

##### after

```ts
function importValidRows(table: string, rows: Row[]) {
  for (const row of rows) {
    if (!isValid(row)) continue;
    db.insert(table, row);
  }
}
```

### G テスト

テストは仕様書。振る舞いを文章で語らせ、1テスト1振る舞い。assert の比較対象は説明変数で受け、「何と何を比べてどうなるか」を読めるようにする。

#### G1 テスト名

テストは仕様書。名前は振る舞いを文章で言う。

##### before

```ts
it("works", () => {});
```

##### after

```ts
it("returns empty when no rows match", () => {});
```

#### G2 1テスト1振る舞い (Clean Code)

別の振る舞いは別のテストへ。1テストに複数の振る舞いを混ぜない。

##### before

```ts
it("handles repository", () => {
  assert.deepEqual(findAll([]), []);
  assert.throws(() => findAll(broken), Error);
});
```

##### after

```ts
it("returns empty when no rows match", () => {
  assert.deepEqual(findAll([]), []);
});

it("throws on broken repository", () => {
  assert.throws(() => findAll(broken), Error);
});
```

#### G3 失敗メッセージ (Clean Code)

失敗時に input が読めるようにする。実際値・期待値は assertion が diff として表示するため手書きせず、diff に現れない input の文脈だけメッセージに添える。

##### before

```ts
for (const input of cases) {
  assert.strictEqual(normalize(input), expected);
}
```

##### after

```ts
for (const input of cases) {
  assert.strictEqual(
    normalize(input),
    expected,
    `input: ${JSON.stringify(input)}`,
  );
}
```

### H 選択と契約

動作要件と安全境界を満たす、保守対象が最も小さいコードを選ぶ。最小化は、明示要求、信頼境界での入力検証、データ損失を防ぐエラーハンドリング、セキュリティ、アクセシビリティの基本に優先しない。

同じ要件を満たせるなら、変更しない・削除する、既存の helper・型・パターンを再利用する、標準ライブラリを使う、プラットフォーム機能を使う、導入済みの依存を使う、必要最小限の固有コードを足す、の順に軽い選択肢を優先する。この優先度は探索順や実装を固定するものではなく、保守対象、既存設計、安全境界を踏まえて選ぶための目安である。

#### H1 不要な依存

軽い選択肢を優先する。標準機能で満たせるなら依存を増やさない（新規依存は承認が必要）。

##### before

```json
{ "dependencies": { "left-pad": "^1.3.0" } }
```

##### after

```json
{ "dependencies": {} }
```

使用箇所は標準の `String.prototype.padStart()` に置き換える。

#### H2 賢いワンライナー (Code Complete)

賢いコードより退屈なコードを優先する。演算子優先順位に頼った式は崩す。

##### before

```ts
const total = items.reduce((a, i) => a + i.price * (1 - i.discount ?? 0), 0);
```

##### after

```ts
let total = 0;
for (const item of items) {
  total += item.price * (1 - (item.discount ?? 0));
}
```

#### H3 抽象の先取り

現時点の動作に寄与しない抽象・設定・拡張点は避ける。ただし、明示要求または既存設計との整合のために必要なものは、その理由を優先する。

##### before

```ts
type Options = { format?: "json" | "yaml"; verbose?: boolean };
// format は json しか使わない、verbose は未使用
```

##### after

```ts
type Options = {};
```

### I コメント

コメントは書かない。1行でも書きたくなったら順に他の置き場を試す: 名前・構造・型 → 設計記録 → コミットメッセージ。

書いてよいのは出典付きの1行だけ。上流（ライブラリ、OS、API、言語処理系）のバグ・欠陥や制約を回避する非自明なコードに、理由と出典（issue URL等）を1行で書く。上流が修正されたときに外せる。出典のないコメントは書かない。実装と乖離したコメントは、実装に合わせて直すか消す。「公式サンプルにもコメントがある」「読み手が仕様を知らないかもしれない」は書く理由にならない。サンプルや docs の情報も、名前・構造で語せるならコメントに置かない。

#### I1 意図説明コメント (Readable Code)

名前が語っている情報の逐語訳。削除する。

##### before

```ts
// ユーザー名を大文字にして表示用にする
const displayName = user.name.toUpperCase();
```

##### after

```ts
const displayName = user.name.toUpperCase();
```

#### I2 説明変数で消せるコメント (Readable Code)

コメントの代わりに、条件を名前のある変数へ抽出する。

##### before

```ts
// 残高が十分かつ口座が凍結されていない場合のみ引き出す
if (account.balance >= amount && !account.frozen) {
  withdraw(account, amount);
}
```

##### after

```ts
const canWithdraw = account.balance >= amount && !account.frozen;
if (canWithdraw) {
  withdraw(account, amount);
}
```

#### I3 出典付きの回避コメント (Readable Code)

上流の欠陥・制約の回避は、理由と出典を1行で書いてよい唯一のケース。

##### before

```ts
// Safari では focus() が効かないため手動で呼ぶ
el.focus();
```

##### after

```ts
// Safari では focus() が効かないケースがあるため手動で呼ぶ
// https://bugs.webkit.org/show_bug.cgi?id=14207
el.focus();
```

#### I4 出典のない回避コメント

同じ内容でも出典がなければ書かない。理由が設計記録に置けるならそちらへ。

##### before

```ts
// Safari では focus() が効かないため手動で呼ぶ
el.focus();
```

##### after

```ts
el.focus();
```

#### I5 乖離したコメント (Clean Code)

実装と異なるコメントは無コメントより危険。実装に合わせて直すか、削除する。

##### before

```ts
// 毎回キャッシュを無効化してから取得する
function fetchUser(id: string) {
  return cache.get(id) ?? db.findUser(id);
}
```

##### after

```ts
function fetchUser(id: string) {
  return cache.get(id) ?? db.findUser(id);
}
```
