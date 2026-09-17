# startup Spec

`~/.agents/scripts/startup` は、harness（pi / dsh）起動時に1回実行される共通の priming スクリプトである。pi と dsh の両方から detached 実行されるため、**個々のタスクは二重実行に耐えること**を契約とする。この spec はスクリプトが現在担当するタスクの契約であり、タスクの追加・削除はこの spec とスクリプトの同時更新を要求する。キャッシュ（timestamp file 等）の方式はここでは定義しない。タスクごとに必要になったときの実装選択肢である。

## 実行の前提

| 項目 | 契約 |
| --- | --- |
| 呼び出し元 | pi 拡張 `startup`、dsh plugin `dotfiles-dsh-startup`（両方 detached で呼ぶ） |
| 複数回実行 | 許容する。各タスクが自身で冪等性を持つ |
| 完了待ち | しない。スクリプトは全タスクを fire-and-forget で起動して即座に終了する |
| 失敗 | スクリプトの失敗が呼び出し元（harness の起動）に影響しない |
| 終了コード | 常に 0 |

## タスク

| タスク | health check | 起動コマンド | 二重実行への耐性 |
| --- | --- | --- | --- |
| deja index | なし（deja 側で freshness 判定） | `deja index` | deja 自身の flock で直列化、fresh なら no-op |
| camoufox server | `${CAMOUFOX_BASE_URL:-ws://127.0.0.1:9378/camoufox}` の authority に対する TCP 接続 | `bun server.mjs`（cwd: `~/.dsh/plugins/web-search`） | ポート衝突で 2 個目は終了（無害） |
| openserp | `GET ${OPENSERP_BASE_URL:-http://127.0.0.1:7000}/ready` が 2xx | `openserp serve -a <host> -p <port> --quiet` | ポート衝突で 2 個目は終了（無害） |

- camoufox server は health check が失敗したときだけ起動する。server.mjs 自身が Linux の Xvfb / x11vnc の維持を行い、出力は `<XDG_CACHE_HOME:-~/.cache>/pi/web-search/camoufox-server.log` へ追記する
- `server.mjs` が存在しない、`bun` / `openserp` / `deja` が PATH に無い場合は、そのタスクを黙ってスキップする
- openserp の host / port は接続先 URL の authority から取る（dsh / pi の web-search 拡張と同じ解決）

## スコープ外

- ツール実行時のサーバー起動待ちとタイムアウトは pi / dsh の web-search 拡張の受け持ち（このスクリプトは起動待ちをしない）
- タスクの成功・失敗の通知、ログの集約
