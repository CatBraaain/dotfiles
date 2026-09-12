# dotfiles-dsh-quota-line

dsh web UI の入力欄の上に、**現在選択中のモデルの provider** の quota を単純
テキストで常時表示する。`dsh-quota-panel` の右下カプセルをこの行に置き換えた
プラグイン。

Behavior contract: **SPEC.md** (Japanese, the review artifact).

## What it shows

選択中 provider の quota を 1 行で出す:

```
zai 13% 5h 24% wk   (GLM Coding Plan を選択中)
codex 8% 5h 31% wk  (ChatGPT subscription を選択中)
```

- `conversation.input.dock` スロット（composer カードの直上、公式 docstring で
  "Full-width entries above the composer card"）に session-scope list entry として
  登録する
- **表示対象は、今選んでいるモデルの provider だけ**。client の live 状態
  （`sessions` + `modelDirectories`、composer model seat の共有状態）から
  focused session の実効 provider を読む（契約は dsh-provider-usage の client
  half から移植）。route provider id と quota 行の対応は
  `zai` / `zai-coding-cn` → `zai`、`openai-codex` → `codex`。選択が未解決・
  未対応 route・その provider の quota 取得失敗のいずれでも行を出さない。
  切替は poll を待たず即座に追従する
- zai（GLM Coding Plan）: `{origin}/api/monitor/usage/quota/limit`。`unit`/`number`
  の印で 5h 窓と週次プールを同定し、印が無い行は reset 時刻順で敷き詰める
  （dsh-glm-quota 方式）。実数 counter（remaining/currentValue/usage）から
  percent を算出し、旧 `percentage` フィールドにフォールバックする
  （pi-usage `providers/zai.ts` 方式）
- codex（ChatGPT subscription）: `chatgpt.com/backend-api/wham/usage`。
  `primary_window` → 5h、`secondary_window` → weekly（positional、pi-usage
  `providers/codex.ts` 方式）
- 週次窓の無いプランは 5h のみ。TIME_LIMIT（MCP 月次）は表示しない
- host は wire に利用可能な全 provider を載せる（選択中 provider 以外の行は
  client が描画しないだけ。fail した provider は `errors` に入る）

## Credentials

| provider | 参照先 |
|---|---|
| zai | settings `llm-pi-ai.providers.*`（id/baseUrl が zai 系）の `apiKeyEnv`/`apiKeyEnvRef` を harness credentials service で解決 → 既知 ref（`ZAI_API_KEY` 等）→ プロセス env。監視 API は `Authorization: <生キー>`（Bearer なし） |
| codex | harness credential records の `llm-pi-ai/openai-codex`（dsh の sign-in flow が書く grant）。期限 30 秒前までに credential store の排他ロック内で refresh（single-use refresh token の二重消費を防ぐ dsh-provider-usage 方式）。grant が無ければ行を出さない |

キー・トークンはこのプロセス外に出ない。route は quota の数値のみを返す。

## Wire contract

`GET /plugins/quota-line/quota.json`（host half が `webServer.register` の exact
route で提供、120 秒 TTL キャッシュ + in-flight dedup、`?refresh=1` で強制更新）:

```json
{
  "ok": true,
  "fetchedAt": 1789234398123,
  "providers": [
    { "id": "zai", "plan": "lite", "rolling": { "percent": 13, "resetsAt": 1771073738 }, "weekly": { "percent": 24, "resetsAt": 1744137600 } }
  ],
  "errors": { "codex": "no codex credential grant — sign in via dsh to enable this row" }
}
```

全 provider 失敗時は `{ "ok": false, "error": "..." }`。client は 60 秒 poll +
visibility 復帰時再取得し、選択中 provider に対応する行の描画だけを行う。
zai の監視 API が HTTP 200 でエラーボディ（`success: false` / 非 200 `code`）を
返した場合は provider 失敗扱いにする。

## Ported code & licenses

- `src/parse.ts` — normalize logic ported from
  [pi-usage](https://github.com/narumiruna/pi-extensions) (`packages/pi-usage`,
  MIT) and [ardss/dsh-glm-quota](https://github.com/ardss/dsh-glm-quota)
  (`plugin/index.js`, MIT)
- `src/index.ts` codex grant half — ported from
  [lizhouai/dsh-provider-usage](https://github.com/lizhouai/dsh-provider-usage)
  (`src/openai-codex.ts`, MIT)

Both upstreams are MIT; ported logic keeps the same behavior contracts.

## Install

Registered statically in the profile manifest: `dotfiles/.dsh/profiles/web/package.json`
の `dependencies` と `dsh.profile.bundles` に登録済み（`dsh-quota-panel` を置換）。
`chezmoi apply` で build & install。Restart dsh afterwards.

## Build

Host half（`src/index.ts`）は `run_build.sh` が `chezmoi apply` 時に
`dist/index.js` へビルドする（他のローカル plugin と同じ）。

Client bundle は `run_build.sh` の対象外（node entries のみ）。`lib/client.js` は
コミット済み。`src/client/` 編集後の再ビルド:

```sh
cd dotfiles/.dsh/plugins/quota-line
bun build src/client/index.ts --outfile lib/client.js --format=cjs --target=browser --external react \
  --banner 'window.__ModuleLoader__.load({ id: "dotfiles-dsh-quota-line", factory: (require) => { var module = { exports: {} }; var exports = module.exports;' \
  --footer 'return module.exports; } });'
```

## Development

```sh
cd dotfiles/.dsh/plugins/quota-line
bun test            # parse/format/active/apply tests
bunx tsc --noEmit   # typecheck (global @deepseek-ai/* via tsconfig paths)
```

`@types/react` は未インストールのため、`src/types/react.d.ts` がこの plugin が
使う react 面（createElement / useState / useEffect）の ambient 宣言を持つ。

## Unverified at runtime

ホスト側の実 API クエリとブラウザ表示は live dsh web session で未検証
（本プラグイン実装時点で zai キーは dsh credentials に未登録、codex grant も
未 sign-in のため）。最初の live 確認ポイント:

1. GLM プランのモデルを選択した状態で、入力欄の上に `zai ...` 行が出ること
   （dsh credentials に zai キー登録後。openrouter 等の非対応 provider 選択中は
   行が出ないこと）
2. codex モデル選択中は sign-in 前は非表示で、sign-in 後に出ること
3. codex grant の refresh（期限接近時）が store の排他ロック内で回ること
4. session 切替・モデル選択変更で行が即座に差し替わること
