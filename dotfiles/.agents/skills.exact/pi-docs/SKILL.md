---
name: pi-docs
description: >-
  pi の導入済みドキュメントとサンプルを参照する。pi harness自体、SDK、extensions、themes、
  skills、prompt templates、TUI、keybindings、custom providers、models、packages、
  environment variables、MCP、codemode・非LLMモデルについて質問・調査・実装するときに使う。
  pi 以外の製品や、pi を使って行う一般的な開発作業には使わない。
---

# pi-docs

## 資産パス

| 環境変数 | 参照先 |
| --- | --- |
| `PI_README_PATH` | README |
| `PI_DOCS_PATH` | `docs/` |
| `PI_EXAMPLES_PATH` | `examples/` |

## 文書の読み方

`docs/...` は `PI_DOCS_PATH`、`examples/...` は `PI_EXAMPLES_PATH` を基準に読む。

| 話題 | 読む文書・サンプル |
| --- | --- |
| harness自体・概要 | `PI_README_PATH` |
| extensions | `docs/extensions.md`、`examples/extensions/` |
| themes | `docs/themes.md` |
| skills | `docs/skills.md` |
| prompt templates | `docs/prompt-templates.md` |
| TUI components | `docs/tui.md` |
| keybindings | `docs/keybindings.md` |
| SDK integrations | `docs/sdk.md`、`examples/sdk/` |
| custom providers | `docs/custom-provider.md` |
| models の追加 | `docs/models.md` |
| packages | `docs/packages.md` |
| environment variables | `docs/environment-variables.md` |
| MCP servers | `docs/mcp.md` |
| codemode scripts・classifiers・image models などの非LLMモデル | `docs/codemode.md` |

harness の変更を実装する前に、関連するdocs・examplesを全文読み、関連する参照先も確認する。
