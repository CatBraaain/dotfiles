# AGENTS.md

## 動作

- チャットでは必ず日本語で回答すること
- プログラミングのソースコードでは必ず英語を使用すること
- ユーザーが質問（? で終わる、または「教えて」「とは」「どうやって」等の疑問表現）の場合は、回答のみ行いツールを呼ばないこと
- ユーザーが明示的に依頼・指示した場合のみ実装や編集を開始すること

## Abbreviations

- `kwsk`: 詳しく教えて
- `is nani`: 詳しく教えて

## 技術スタック

- `python`は直接使わずに `uv` 経由で使う（`uv run`, `uv add` 等）
- - 独立した単一Pythonスクリプトには、先頭にインラインメタデータ（PEP 723）を入れること。これにより `pyproject.toml` 不要で `uv run script.py` だけで依存関係が解決されて実行可能になる
- タスクランナーは基本的に `just` を使う。ただし JS プロジェクトの場合は `package.json` の npm-scripts で十分であり justfile は不要
- JS/TS のパッケージマネージャー（pnpm, bun 等）はプロジェクトごとにユーザーに確認すること
- `vite-plus`（`vp` CLI）がある場合は node を直接利用せず `vp` 経由で実行すること
- 上記で規定されていない事項は、都度ユーザーに確認すること

## ビルド

- ビルド成果物は `dist/` ディレクトリに出力すること
- ただし cargo の場合はデフォルトの `target/` ディレクトリを使う

## リント・フォーマット

編集後は必ず該当するリンター、フォーマッター、タイプチェックを実行すること。プロジェクトに既存の設定・依存があればそれを優先し、なければ以下のデフォルトを使う。

- **Python**: `ruff format`, `ruff check`, `ty`
- **JavaScript/TypeScript**: `vite-plus` 依存があれば `vp format`, `vp check`、なければ `oxfmt`, `oxlint`
- **その他言語**: 適切なリンター・フォーマッターを選択して実行
- **不要**: powershell, shell script, justfile（選択肢が少ない、または文法が単純なため）

## テスト

- Python: `pytest`
- JavaScript/TypeScript: `vitest`
