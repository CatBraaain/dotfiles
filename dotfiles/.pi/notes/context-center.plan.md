# context-center.plan.md

AGENTS.md / rules / skills を「追加コンテキスト」として一元管理し、ファイル単位で動的に有効化・無効化する pi extension の計画。rules.plan.md を統合・発展させる。

## 目的

pi は AGENTS.md（directory-scoped・常時読込）と skills（progressive disclosure）をネイティブに読み込むが、これらは常にすべて載るため:

- グローバル AGENTS.md の「開発時は〜」のようなコンテキストが、非開発タスクでも載り続ける
- 一度適用した skill の本文が、以後ずっと履歴を圧迫する

これを**ユーザーがファイル単位で動的に on/off できる**ようにし、常に「今どのコンテキストが入っているか」を明示する。あわせて Claude Code 互換の `.claude/rules/*.md`（pattern-scoped on-demand）も取り込み、rules と AGENTS.md を区別せずすべて additional context として扱う。

## コンセプト: すべては additional context

AGENTS.md も rules も skill も、本質は「LLM に与える markdown 命令/素材」。差はスコープ指定と載せ方だけ。これを1つの extension で統一管理する:

- 常時系（AGENTS.md・`paths` 無し context）: 既定で ON、手動で OFF 可
- 要求型（`paths` 付き context）: ファイル操作で自動活性、または手動 ON
- skill 本文: 適用（read）後に履歴から除去可（**listing は触らない**）

## 対象と読込元

| 種別                             | 読込元                                                                                       | 既定                               | 制御方式                                                         |
| -------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------- |
| native context files             | pi が自動発見（`~/.pi/agent/AGENTS.md`・親dir・cwd の AGENTS.md/CLAUDE.md）                  | 常時 ON                            | `before_agent_start` で per-file 無効化                          |
| 動的コンテキスト（`paths` 付き） | `~/.pi/contexts/*.md`・`./.pi/contexts/*.md`・`~/.claude/rules/*.md`・`./.claude/rules/*.md` | `paths` マッチで自動活性 / 手動 ON | `before_agent_start` で注入                                      |
| 動的コンテキスト（`paths` 無し） | 同上                                                                                         | 常時 ON                            | `before_agent_start` で注入・手動 OFF 可                         |
| skill 本文                       | pi が listing（system prompt）・本文は read で履歴へ                                         | 適用後は履歴に残る                 | `context` hook で消費済み本文を id pair で除去（listing 不触及） |

## アーキテクチャ: 2 hook 役割分担

### before_agent_start — systemPrompt 再構築（AGENTS.md 無効化 + 動的コンテキスト注入）

pi はセッション開始時に AGENTS.md を `buildSystemPrompt()`（**非公開**）で systemPrompt に焼き込む。`<project_context>` ブロック内に各ファイルが `<project_instructions path="...">` でラップされる。毎 turn の `before_agent_start` が焼き済み `event.systemPrompt` と構造データ `event.systemPromptOptions.contextFiles`（`{path, content}[]`）を渡し、拡張が `{ systemPrompt }` を返すと**その turn 上書き**される。

処理:

1. 有効 contextFiles = `contextFiles.filter(f => !disabledContextFiles.has(f.path))`
2. 有効な動的コンテキスト（自動活性 ∪ 手動ON）∩ 非無効化 を収集
3. `<project_context>` ブロック全体を、有効 contextFiles + 有効動的コンテキストから再構築（`<project_instructions path="...">` 形式で統合）。全無ならブロックごと削除
4. `event.systemPrompt` の同ブロックを再構築物で置換 → `return { systemPrompt }`
5. ついでに `event.systemPromptOptions.skills` から既知 skill 一覧（filePath→name）をモジュール状態へ refresh（`context` hook で使う）

注意:

- `buildSystemPrompt` は非公開のため**全文再構築せずブロック領域置換**（`<project_context>` 〜 `</project_context>`）。置換失敗時は fail-open（元のまま返す）
- 他拡張の `before_agent_start` 連鎖を壊さないよう、`event.systemPrompt`（連鎖済）に対して部分置換する
- systemPrompt は compaction 対象外（毎 turn 再送）→ AGENTS.md 無効化・動的コンテキストとも compaction 耐性あり

### context — messages filter（skill 消費済み本文の除去）

skill 本文は systemPrompt でなく `read` の toolResult として履歴に入る。`AssistantMessage.content[]` の `{type:"toolCall", id, name:"read", arguments:{path}}` と `ToolResultMessage{role:"toolResult", toolCallId, toolName:"read"}` が `id === toolCallId` で対。

処理（毎 turn・stateless・非破壊）:

1. `event.messages` から assistant の read toolCall を走査し `toolCallId → arguments.path` の map を構築
2. 各 read toolResult について、対応 path が**無効化 skill のディレクトリ配下**なら、その toolCallId を除去対象に追加
3. 除去対象の toolResult メッセージを削除 ＋ 対応する assistant 側 toolCall block を content から splice（**ペア抜き必須**: 片方だけ残すと unpaired tool_use で provider がエラー）
4. `return { messages: filtered }`

stateless にしたことで `/reload` 後も messages から再構築でき、事前の tool_call 追跡が不要。

### 天井（skill 除去・受入）

- **compaction**: 一度 compaction に掛かると toolResult は `summary` 文に溶け込み toolCallId も消える → 以後フィルタで狙えない。未圧縮ウィンドウ内のみ有効（**compaction 介入はしない**）
- **bash 経由読込**: `cat SKILL.md` 等は read toolResult でないため検知不可
- **過去の推論**: skill 本文に基づき生成された assistant 発言は残る（「なかったこと」にしない）。効能は未来 turn の再参照断ち＋token 節約

## 状態管理

2層:

- **個人永続**（`~/.pi/agent/dynamic-context.json`）: `disabledContextFiles`（絶対パス）・`enabledContextFiles`・`disabledSkills`（skill name）。startup/reload で読込。「自分だけ無効化」はここ。
- **セッション一時**（モジュール変数）: `autoActiveContexts`（`paths` マッチで自動活性した動的コンテキスト）・`knownSkills`（filePath→name）。new/resume/fork でリセット。`autoActiveContexts` は `/reload` 生存のため `pi.appendEntry` で保存・`session_start` で復元。

優先規則: **手動 > 自動**。有効 = `(自動活性 OR 手動ON) AND NOT 手動OFF`。

## UI・コマンド

ダイアログ無し。`ctx.ui.setStatus("ctx", ...)` のフッター1行で**現在適用中のコンテキストを常時明示**。

形式例: `ctx: global-AGENTS, project-AGENTS, dev-rules | skills: ponytail`

活性変化時に更新、空なら消去。

コマンド（`pi.registerCommand`）:

- `/ctx-list` — 全コンテキスト（native・動的・skill）と状態の一覧
- `/ctx-enable <name>` — 手動有効化（自動非マッチの取り込み等）
- `/ctx-disable <name>` — 手動無効化（AGENTS.md・動的・skill すべて対象。自動活性にも勝つ）
- `/ctx-reset` — セッションの自動活性セットをクリア（手動設定は維持）

## 決定事項

- extension 配置: `dotfiles/.pi/agent/extensions.exact/dynamic-context/`（グローバル展開）
- 読込元: `~/.pi/contexts/*.md`・`./.pi/contexts/*.md`・`~/.claude/rules/*.md`・`./.claude/rules/*.md`（claude-compat 統合。tasks.todo の claude-compat はここで解消）
- frontmatter: `paths`（Claude Code 現行。`globs` は非推奨）
- フック対象: 動的コンテキストの自動活性は read/write/edit のみ（grep 単独は諦め）
- AGENTS.md 制御: `before_agent_start` で per-file 無効化（`--no-context-files` 全OFF は使わない）
- skill 制御: **listing は触らない**。消費済み本文の `context` id-pair filter のみ。compaction 非介入
- 注入方式: 動的コンテキストも systemPrompt の `<project_context>` ブロックへ（`before_agent_start`）。messages 注入はしない
- 永続化: 手動設定は JSON ファイル（個人永続）、自動活性は appendEntry（セッション）、new/resume/fork でリセット
- 優先: 手動 > 自動
- UI: バナー常時明示のみ（ダイアログ無し）
- glob: `minimatch`（phantom deps 経由）
- コマンド: `/ctx-list` `/ctx-enable` `/ctx-disable` `/ctx-reset`

## タスク

- [ ] 読込元4ディレクトリから動的コンテキストをロード（frontmatter `paths` パース・`session_start` startup/reload で再読込）
- [ ] 全 contextFile の path 一覧を把握（native は `systemPromptOptions.contextFiles`、動的は自前読込）
- [ ] `before_agent_start`: 無効化フィルタ＋動的コンテキスト注入で `<project_context>` ブロック再構築・systemPrompt 上書き返却
- [ ] `tool_call`: read/write/edit の path → `paths` glob マッチ → `autoActiveContexts` 追加・バナー更新
- [ ] `context`: skill 消費済み本文の id-pair 除去（ペア抜き・stateless）
- [ ] knownSkills の refresh（`before_agent_start` で `systemPromptOptions.skills` から）
- [ ] 個人永続 JSON の読書き、appendEntry による `autoActiveContexts` の保存・復元
- [ ] バナー（`setStatus`）の更新・消去
- [ ] コマンド `/ctx-list` `/ctx-enable` `/ctx-disable` `/ctx-reset`
- [ ] テスト（`.test.ts`・Bun auto-install 向け describe/it 内蔵）

## メモ

- 他拡張（model-router 等）も `before_agent_start` を使い得る → `event.systemPrompt` への部分置換で共存
- AGENTS.md の絶対パスは環境依存だが個人永続なので問題なし。プロジェクト AGENTS.md は他ツールとの可搬性のため**ファイルは触らずプロンプトから除外するだけ**
- compaction 天井は短〜中セッションでは影響小。長セッションで効かない点は履歴の自然圧縮で緩和される
- 動的コンテキストの dedup: 同 path が複数ソースにあれば project > global、`~/.pi/contexts` と `~/.claude/rules` の名前衝突は先勝ち（実装時調整）
- `./.pi/contexts/*.md` は `~/.pi/contexts` のプロジェクトローカル対（不要なら読込元から外してよい）
