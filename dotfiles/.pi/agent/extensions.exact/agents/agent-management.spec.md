# agent管理Spec

agent定義・設定検証・選択・状態表示と、実行できない場合の報告を定める。読者は利用者と実装・テストの担当者。

## 概要

セッションは **agent** を実行する。agent は利用できるツール、依頼できる子agent、システムプロンプトを持ち、モデル候補の順序（class）の既定値を持つ実行主体である。本拡張は agent定義の管理と選択を行い、`/agent:<name>` コマンド・`--agent` フラグ・subagentツールの `agent` パラメータを提供する。class は `/class:<name>` コマンドと `--class` フラグで agent と独立に選択できる。mode は class名ごとのモデル候補テーブルを選ぶ単位であり、`/mode:<name>` コマンドと `--max` フラグで切り替えられる。

モデルの自動選択と切り替えはこの拡張だけが行う。ユーザーは `agents.yaml` で mode・class・agent を管理し、`/agent:<agent>` で実行するagent を、`/class:<name>` で class を、`/mode:<name>` でモデル候補テーブルを切り替えられる。

## 設定

設定ファイル: `~/.pi/agent/config/agents.yaml`

```yaml
default: main
defaultMode: standard

settings:
  zai:
    - multiply: zai.urgency
    - cron: "* 6-9 * * 1-5"
      multiply: 0
  deepseek:
    - cron: "* 1-3 * * 1-5"
      multiply: 0

modes:
  standard:
    high:
      - model: <provider>/<model>
      # usage スコアリングでの静的な重み。省略時は 1
      - model: <provider>/<model>
        weight: 1
      # この候補だけで使うルール配列（[モデル選択](model-routing.spec.md)）。provider設定を置き換える
      - model: <provider>/<model>
        settings:
          - multiply: <provider>.urgency
    middle:
      - model: <provider>/<model>
      - model: <provider>/<model>
    low:
      - model: <provider>/<model>
    vision:
      # 画像入力をサポートするモデルだけを置く
      - model: <provider>/<model>

  max:
    high:
      - model: openai-codex/gpt-<LATEST>-astra
    middle:
      - model: openai-codex/gpt-<LATEST>-astra
    low:
      - model: openai-codex/gpt-<LATEST>-sol
    vision:
      - model: <provider>/<model>

agents:
  main:
    class: middle
    tools: ["*"]
    subagents: [senior, junior, vision]
    systemPrompt: ["...", "..."]
  senior:
    class: high
    tools: ["*", "!recontext"]
    subagents: [junior, vision]
    systemPrompt: ["...", "..."]
  junior:
    class: low
    tools: ["*", "!recontext"]
    subagents: []
    systemPrompt: ["..."]
  vision:
    class: vision
    tools: ["*", "!recontext"]
    subagents: []
    # tools と systemPrompt は junior と同じ内容。class: vision のみが異なる
    systemPrompt: ["..."]
```

| 項目・操作 | 内容と振る舞い |
| --- | --- |
| 設定ファイル | 起動時に検証する。有効な場合は agent を利用でき、不正な場合はエラーを通知する（[設定の検証](#設定の検証)） |
| `default` | 新規セッションと保存済みセッションで開始するagent |
| `agents.<name>` | agent の定義 |
| `defaultMode` | 初期mode の既定値。定義済みのmode名を指定する。配布設定は `standard` |
| `modes.<mode>.<class>` | modeごとの完全なclassテーブル。値はモデル候補の配列で、配列の先頭から fallback順序として評価する。mode名・class名はいずれも設定で定める文字列 |
| 候補の `model` | 候補のモデル。`<provider>/<model>` 形式の文字列で、最初の `/` で provider と model に分割する（`commandcode/z-ai/glm-5.3-flash` なら provider が `commandcode`、model が `z-ai/glm-5.3-flash`）。model 部分には `<LATEST>` トークンを含められる（[モデル選択](model-routing.spec.md)） |
| 候補の `weight` | usage スコアリング（[モデル選択](model-routing.spec.md)）での静的な重み。正の有限数。省略時は `1` |
| 候補の `settings` | この候補だけで使うルール配列（[モデル選択](model-routing.spec.md)）。指定した場合はその provider の設定を丸ごと置き換える。省略時は provider設定を使う |
| `settings` | providerごとのルール配列（[モデル選択](model-routing.spec.md)）。省略可。候補から参照されない provider の定義も許可する |
| `class` | agent の既定class。必須 |
| `tools` | pi標準ツールと拡張機能の allowlist。指定したツールを実行し、未指定のツールを拒否してセッションを継続する。`["*"]` はすべてのツール、`[]` はツールなしを許可する。`"!<tool-name>"` は `"*"` を含んでもそのツールを除外する。`["*", "!<tool-name>"]` は有効である。 |
| `subagents` | subagentツールでの起動を許可する子agent の一覧。定義済みの agent が一覧に含まれる場合は起動し、含まれない場合や一覧が空の場合は起動せずセッションを継続する |
| `systemPrompt` | 次回のエージェント実行時に、配列要素を記載順で結合して追記するagent固有のシステムプロンプト。YAML のアンカーとエイリアスで複数agent間で要素を共有できる |
| `/agent:<name> [message]` | 指定したagent を即時に有効にする。モデルは切替先agent の既定class の候補を適用し、ツール・agent表示も切り替える。`message` を続けた場合は agent切り替え完了後にそのテキスト（前後の空白を除く）をユーザーメッセージとして送信し、切替先agent の設定で直ちにターンを開始する。`message` を省略した場合は切り替えのみ行う |
| `/class:<name>` | 設定された各class名で利用できる。切り替えは[モデルの適用タイミング](model-routing.spec.md#モデルの適用タイミング)に従う |
| `--class <name>` フラグ | 初期class（[モデル選択](model-routing.spec.md)）を指定する。実効class はセッション開始・`/new`・セッション切替・分岐でこの class に初期化される。未定義の値は warning で通知し、無視する。`--agent` と独立であり併用できる |
| `/mode:<name>` | 設定された各mode名で利用できる。切り替えは[モデルの適用タイミング](model-routing.spec.md#モデルの適用タイミング)に従う |
| `--max` フラグ | booleanフラグ。初期mode に `max` を指定する。`--agent`・`--class` と独立して併用できる |

`/agent:<name>`・`/class:<name>`・`/mode:<name>` は pi標準のコマンド名補完に現れる。`/class`・`/mode` の入力でそれぞれ設定名付きのコマンドを探せる。配布設定では `/max` の入力でも `/mode:max` が候補に現れ、その候補を選択して `/mode:max` として実行する。

## 設定の検証

拡張のロード時に設定ファイルを検証する。次のいずれかに該当する場合は `agents.yaml: <理由>` を throw して拡張のロードを失敗させ、pi は起動時の診断にロード失敗を表示する。不正な設定を一部分だけ適用することはなく、設定が有効な場合にだけ拡張のすべての機能（agent切替、ツール制限、subagent、モデルルーティング）を登録する。

- 設定ファイルがない・読めない・YAML として不正
- `default` か `agents` がない、型が違う
- `agents` の各定義がオブジェクトでない
- agent の `class` がない、文字列でない
- `defaultMode` がない・非空文字列でない、または `modes` に定義されていない
- `modes` がない・オブジェクトでない、各modeがオブジェクトでない
- 各modeのclass名集合が `defaultMode` のclass名集合と異なる（欠落・余分なclassがある）
- agent がmodeテーブルに定義されていないclass を参照している
- class の値が配列でない
- 候補が `model` / `weight` / `settings` 以外のキーを持つ
- 候補の `model` がない・文字列でない・最初の `/` で空にならない provider と model に分割できない、`weight` が正の有限数でない、`settings` が配列でない
- `settings` がオブジェクトでない、provider のルールが配列でない、ルールがオブジェクトでない
- ルールが `cron` / `multiply` 以外のキーを持つ、`multiply` が非負の有限数でも `<provider>.urgency` 形式でもない
- ルールの `cron` が文字列でない、5フィールドの標準構文として不正（フィールド数が違う・値がフィールド範囲外・範囲の下限が上限より大きい・名前やマクロを含む）
- `tools`・`subagents`・`systemPrompt` が配列でない、要素が文字列でない
- `tools` の否定指定が `!` だけ、または `"*"` 以外の同じツール名を許可と否定の両方で指定する
- `vision` がない、または `class` が `vision` でない
- main または senior の `subagents` が `vision` を含まない
- junior の `subagents` が `vision` を含む
- `default` が未定義の agent を指している
- `subagents` が未定義の agent を含む

## Agent表示

セッション開始時と agent・class・mode の切り替え時に、現在の agent と実効class を表示する。

```text
🤖 agent: <currentAgent>
💎 class: <class-name> (<source>)
```

class が未選択のときは agent行のみを表示する。class行の末尾には、最後に mode・class・モデルを選んだ主体を必ず表示する。表示のテキスト色はグレーとする。

| 表示 | 設定するタイミング |
| --- | --- |
| `(manual)` | ユーザーの `/model`・`/class:<name>`・`/mode:<name>`・`/agent:<name>` による選択 |
| `(auto)` | セッション初期化・新規開始・再開・分岐時の初期選択 |
| `(agent)` | `recontext` のクラス指定を適用したとき |

この表示はモデルルーティングの自動・手動状態とは別に管理する。`/class:<name>`・`/mode:<name>`・`/agent:<name>` の操作後は `(manual)` と表示するが、候補の自動再評価は従来どおり行う。候補再評価・429フォールバックでは表示を変更せず、`/reload` では保存した表示を維持する。無視された要求・同じクラスへの変更なしの要求では表示を変更しない。

## 実行できない場合の報告

エージェントがタスクを遂行できない場合は、理由（権限不足、力量・情報不足など）を添えて報告する。報告先（subagent実行中は依頼元エージェント、直接実行時はユーザー）の指定は拡張コードで強制せず、各agent の systemPrompt の規範に委ねる。
