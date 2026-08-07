# model-tiers

## 目的

子エージェント／子 LLM 呼び出しが増えるにつれ、呼び出し側に数十モデルから選ばせると誤選択・過大選択が起きる。
ユーザーが用意した **3 段階（high / middle / low）** に実モデルをマップし、呼び出し側は **意図（tier）だけ** を選ぶ／固定する。

原則: 呼び出し側に生の model ID を晒さない。実体の差し替えは設定ファイルだけ。

## 背景

- 既存の `subagent` は任意の `model` 文字列を `--model` に渡せる（数十択になりうる）
- `web_fetch` 加工（子 LLM 一発）や code-review 委譲など、子呼び出し経路が増える
- 既存の `model-router` は **親セッションの自動切替**用。本構想は **子呼び出し用のエイリアス**で、役割が違う（共存可）

## 命名

| 語 | 役割 |
| --- | --- |
| `tier` | 引数名・概念名（例: `subagent({ tier: "high" })`） |
| `high` / `middle` / `low` | tier の値（3 択） |

- tool 引数は生 `model` ではなく `tier`
- 設定側で `tiers.high → { provider, model }` に解決する
- 設定コメントまたは短い説明で「高い＝賢い／コスト高」など意図を明示し、曖昧さを潰す

## 設定ファイル

### 置き場所

**`settings.json` には書かない。** 独自ファイルにする。

理由:

- pi の `Settings` は公式キー前提。拡張用キーの公式 API がない
- `/settings` 保存や将来の migrate で消えるリスクがある
- このリポの既存拡張も拡張横の独自設定（`model-router/config.yaml` 等）

共有マップ（`subagent` / `web_fetch` / 将来の委譲が同じ定義を読む）なので、拡張専用より agent 直下がよい:

```
~/.pi/agent/model-tiers.yaml
```

sourceDir 側（chezmoi 管理）は例えば:

```
dotfiles/.pi/agent/model-tiers.yaml
```

### スキーマ案

```yaml
tiers:
  high:
    provider: anthropic
    model: claude-opus-4
  middle:
    provider: zai
    model: glm-5.2
  low:
    provider: commandcode
    model: deepseek/deepseek-v4-pro
```

- 3 キーとも必須（欠けたら起動時または解決時に明確なエラー）
- 解決結果は `modelRegistry` に存在するかを検証する（無い tier はスキップ／エラー。方針は実装時に決める）

## 呼び出し側ポリシー

| 呼び出し | tier の扱い | 理由 |
| --- | --- | --- |
| `web_fetch` 加工（execute 内の子 LLM） | 固定 `low` | 要約・抽出の一発。選ばせない |
| code-review 委譲 | 固定 `high` | 本格レビュー。選ばせない |
| `subagent` | 親が `tier` を選ぶ（省略時は `middle`） | タスク難易度が都度違う |

- 汎用 `subagent` だけ親に難易度判断を残す
- 用途が固定の経路はデフォルト固定し、選択コストをゼロにする
- 親向け description / AGENTS.md には「難易度に応じて tier を選べ」と書く（`subagent` のみ）

## 解決フロー

```
呼び出し側: tier（または用途デフォルト）
  └─ resolveTier(tier) → model-tiers.yaml を読む
       └─ { provider, model }
            └─ 子プロセスなら --model <model>
            └─ in-process なら createAgentSession の model 指定
```

- 解決ロジックは共有 helper にする（拡張ごとにコピペしない）
- 配置案: `dotfiles/.pi/agent/extensions.exact/_shared/model-tiers.ts` など（実装時に決めてよい）

## 非ゴール

- 親セッションの Ctrl+P モデル一覧を 3 択に減らすこと（それは `enabledModels` / `model-router` の領域）
- tier を 3 より増やすこと（v1）
- settings.json への埋め込み
- 呼び出し側に生 `model` 上書きを残すこと（残すとまた数十択に戻る。必要なら後から明示的に検討）

## model-router との関係

| | model-router | model-tiers |
| --- | --- | --- |
| 対象 | 親セッション | 子呼び出し |
| 入力 | 時間帯・429 等のルール | `high` / `middle` / `low` |
| 出力 | 親の現在モデル切替 | `--model` / session model |

相互依存しない。子は tier 解決結果だけを見る。

## 関連プラン

- `web-fetch-extraction.plan.md` — fetch 結果を子 LLM で加工（tier は `low` 固定想定）
- `pi-orchestrator.plan.md` — code-review 等は `subagent` + skill + NL（レビュー委譲時の tier は `high` 固定想定）

## 未決（実装時に決めてよい）

- yaml の正確なパス名（`model-tiers.yaml` でよいか）
- provider フィールドを必須にするか、model 文字列だけで `--model` に渡すか
- 未登録モデル時: hard error vs fallback to `middle`
- shared helper の配置と、どの拡張が最初に載せるか
- `subagent` の既存 `model` 引数を廃止するタイミング（破壊的変更の扱い）
- AGENTS.md に書く文言の最終形

## タスク（実装時）

- [ ] `model-tiers.yaml` のスキーマとサンプルを追加
- [ ] `resolveTier(tier)` 共有 helper（読込・検証・エラー）
- [ ] `subagent`: `model` → `tier`（省略時 `middle`）
- [ ] `web_fetch` 加工経路: `low` 固定で解決
- [ ] code-review 委譲経路: `high` 固定（専用 tool を作らないなら AGENTS.md + subagent 呼び出し側の慣例で足りるか確認）
- [ ] テスト（マップ解決・欠落キー・未知 tier・省略時デフォルト）
