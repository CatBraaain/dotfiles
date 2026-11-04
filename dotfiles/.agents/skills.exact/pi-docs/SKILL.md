---
name: pi-docs
description: >-
  pi の導入済みドキュメントとサンプルを参照する。pi harness自体、SDK、extensions、themes、
  skills、prompt templates、TUI、keybindings、custom providers、models、packages、
  environment variables、MCP、codemode・非LLMモデルについて質問・調査・実装するときに使う。
  pi 以外の製品や、pi を使って行う一般的な開発作業には使わない。
---

# pi-docs

## 文書の読み方

ファイルのパスは、環境変数付き絶対パスのまま `read` の `path` に渡す。末尾が `/` の参照先は同じ形式で `ls` に渡し、必要なファイルを選んで `read` で読む。

| 話題 | 読む文書・サンプル |
| --- | --- |
| harness自体・概要 | `${PI_README_PATH}` |
| extensions | `${PI_DOCS_PATH}/extensions.md`、`${PI_EXAMPLES_PATH}/extensions/` |
| themes | `${PI_DOCS_PATH}/themes.md` |
| skills | `${PI_DOCS_PATH}/skills.md` |
| prompt templates | `${PI_DOCS_PATH}/prompt-templates.md` |
| TUI components | `${PI_DOCS_PATH}/tui.md` |
| keybindings | `${PI_DOCS_PATH}/keybindings.md` |
| SDK integrations | `${PI_DOCS_PATH}/sdk.md`、`${PI_EXAMPLES_PATH}/sdk/` |
| custom providers | `${PI_DOCS_PATH}/custom-provider.md` |
| models の追加 | `${PI_DOCS_PATH}/models.md` |
| packages | `${PI_DOCS_PATH}/packages.md` |
| environment variables | `${PI_DOCS_PATH}/environment-variables.md` |
| MCP servers | `${PI_DOCS_PATH}/mcp.md` |
| codemode scripts・classifiers・image models などの非LLMモデル | `${PI_DOCS_PATH}/codemode.md` |

harness の変更を実装する前に、関連するdocs・examplesを全文読み、関連する参照先も確認する。
