# create-session拡張機能Spec

`create_detached_session` ツールで、ユーザーが対話を引き継ぐ独立した標準mainセッションをtmuxウィンドウとして作成し、初期依頼を即実行する。作成先は標準設定・標準権限のmainであり、呼び出し元セッションとの会話継続・結果待ち・成果回収は行わない。対象読者は、この拡張とtmux-serverユニットを保守・変更する人である。

## ツールの入力

| パラメータ | 必須 | 内容 |
| --- | --- | --- |
| `initialRequest` | 必須 | 新セッションで即実行する初期依頼。前後の空白を除いて空であってはならない |
| `cwd` | 省略可 | 新セッションの作業ディレクトリ。省略時は呼び出し時の `ctx.cwd`。相対パスは呼び出し時の `ctx.cwd` 基準で絶対パスへ解決する |
| `name` | 省略可 | tmuxウィンドウ名。省略時は `main-HHMMSS`（呼び出し時刻）で自動採番する。前後の空白を除いた値を使う |

`initialRequest`・`cwd`・`name` のいずれかにNUL文字を含む呼び出し、空白のみの `initialRequest`、空白のみの `name`、`:` または `.` を含む `name` はツールエラーになる。`:` と `.` はtmuxのターゲット区切り文字であるため許可しない。自動採番名は1秒以内の連続作成で重なり得るが、ウィンドウ名の重複はtmuxが許容するため作成は失敗しない。

## 呼び出し元の制限

`create_detached_session` はmain agentだけが呼び出せる。次の2段階で制限する。

| 層 | 動作 |
| --- | --- |
| `~/.agents/config/agents.yaml` | main 以外の全agentの `tools` から `!create_detached_session` で除外する |
| 拡張の実行時ゲート | 環境変数 `PI_AGENT_NAME` が `main` でない呼び出し（未設定を含む）をツールエラーにする |

実行時ゲートは `PI_AGENT_NAME` を agents拡張が設定することを前提とする。agents拡張の負う名前の正本は `agents` 拡張のspecが定める。

## 承認

`create_detached_session` の実行は、1回のユーザー確認を必要とする。確認は選択ダイアログで、選択肢は次の4つである。

| 選択肢 | 効果 |
| --- | --- |
| `Allow once` | その呼び出しだけを許可する。次の呼び出しは再度確認する |
| `Allow in this session` | このセッションの残りの間、確認を省略する |
| `Allow in this turn` | 次のユーザーメッセージを受け付けるまでの間、確認を省略する |
| `No, deny (reason next)` | 実行しない。続けて任意の理由を入力できる |

- 承認の単位はツール全体であり、`initialRequest`・`cwd`・`name` の内容によらない。有効なsession・turn承認がある間は、入力が変わっても再確認しない。
- 選択肢の文言と有効期間の意味は guardrail拡張の選択ダイアログに合わせる。承認のstateは本拡張の中だけで管理し、guardrailのコマンド承認・パス許可とは独立に保持・失効する。
- 拒否時の理由入力は任意で、空欄・キャンセルは理由なしとして扱う。拒否はエラーとして呼び出し元に返し、以降の呼び出しには影響しない。
- 選択ダイアログを提供できないUIでは確認ダイアログ（`confirm`）に置き換え、承認は `Allow once` 相当として扱う。理由入力はテキスト入力ダイアログを提供できる場合のみ行う。
- UIを持たない環境では承認できず、ツールエラーとして失敗する（fail-closed）。
- ダイアログの表示中にturn承認が失効した場合、その回答は失効済みとして拒否する。

確認ダイアログには、問いかけ `Allow creating a new main-agent session?` に続けて、`initial request: <初期依頼>`（80文字で切り詰め）と、`cwd` が指定されていれば `cwd: <作業ディレクトリ>` の行を表示する。

## turn承認の失効

turnは、次のユーザーメッセージを受け付けるまでの期間である。

| イベント | turn承認の扱い |
| --- | --- |
| `input`（対話入力・RPC・拡張からの入力） | 失効する |
| ユーザーの `message_start` | 失効する |
| assistant・toolResultの `message_start`、turn・ツールの往復 | 維持する |
| セッションの置換（`/new`・`/resume` 等）・reload | 拡張ランタイムの再生成に伴って失効する |

session承認も同じ置換・reloadで失効する。履歴からはどちらの承認も復元しない。

## tmuxの構成

`create_detached_session` は、承認後に登録済みのbashツールを1回だけ呼び、tmuxコマンドを1つ実行する。bashツールの権限確認・sandbox・中断・出力上限をそのまま適用し、本拡張はbashの新規生成やプロセス直起動を行わない。

| 項目 | 値 |
| --- | --- |
| tmuxセッション名 | `pi`（固定・1セッション） |
| キープアライブ用セッション | `_keeper`（tmux-serverユニットが作る。本拡張は作らない） |
| `TMUX_TMPDIR` | `${XDG_RUNTIME_DIR:-/run/user/$(id -u)}`（全tmux呼び出しに前置する） |
| サーバー確認 | `tmux has-session -t _keeper`。失敗時は終了コード94で中断する |
| ウィンドウ追加 | `pi` セッションがあれば `tmux new-window -d -t pi: -n <name>` |
| セッション作成 | `pi` セッションがなければ `tmux new-session -d -s pi -n <name>`（既存サーバーに追加） |

`_keeper` セッションが存在しない場合、tmuxサーバーは常駐構成でないと判断し、作成せずに失敗する（fail-closed）。エラーメッセージには tmux-server systemdユーザーサービスの開始（`systemctl --user enable --now tmux-server.service`）を案内する。ユーザーが手動で起動したtmuxサーバー（`_keeper` を持たない）も同じ理由で対象外である。

成功時のツール結果には、作成したウィンドウ `pi:<name>` と、`tmux attach -t pi` による参加方法を返す。

## ウィンドウで実行するコマンド

ウィンドウでは `bash -lc` を使い、`cd -- <cwd> && pi --agent main -- <initialRequest>` を1つの引用付き引数として実行する。`--` は初期依頼が `-` で始まる場合に備える。

`bash -lc` を使う理由は、ユーザーのPATHを引き継ぐためである。`~/.profile` は `~/.bashrc` をsourceし、`~/.bashrc` のPATH設定（linuxbrew・bun・`~/.agents/cli` 等）は対話ガードより前にあるため、非対話のlogin shellでも適用される。新しい `pi` はこのPATH上で解決され、標準の設定探索（`~/.pi/agent/`・プロジェクト設定）で起動する。

新しいmainセッションは、呼び出し元の履歴・許可・承認を一切引き継がない。ウィンドウのプロセスはtmuxサーバーの子プロセスとして動き、呼び出し元のpiプロセスやsandboxの寿命と無関係に存続する。

## tmux-serverユニット

`dotfiles/.config/systemd/user/tmux-server.service`（展開先 `~/.config/systemd/user/tmux-server.service`、Linuxのみ展開）がtmuxサーバーを常駐させる。

| 項目 | 値 |
| --- | --- |
| サービスタイプ | `oneshot` + `RemainAfterExit=yes` |
| `TMUX_TMPDIR` | `%t`（`$XDG_RUNTIME_DIR`、既定 `/run/user/<uid>`） |
| `ExecStart` | `/home/linuxbrew/.linuxbrew/bin/tmux new-session -d -s _keeper "sleep infinity"` |
| `ExecStop` | `/home/linuxbrew/.linuxbrew/bin/tmux kill-server` |

`sleep infinity` を実行する `_keeper` セッションが、tmuxサーバーを存続させる。`ExecStop` の `kill-server` は `pi` セッションを含む全セッションを終了させるため、サービスの停止は実行中のmainセッションも終了させる。ソケットは `TMUX_TMPDIR` 配下（`/run/user/<uid>`）に置かれ、systemdのランタイムディレクトリとしてセッションの生存期間中は掃除されない。

本拡張はユニットの導入・起動を行わない。導入は保守者が `systemctl --user daemon-reload` と `systemctl --user enable --now tmux-server.service` で行う。

## ~/.bashrc の TMUX_TMPDIR

`dotfiles/.bashrc` は、tmuxのソケットディレクトリを次のexportで共有する。

```sh
export TMUX_TMPDIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
```

対話ガードより前に置き、login shell・非対話シェルの両方で適用する。これにより、ユーザーが `tmux attach -t pi` で参加するときも、`create_detached_session` とtmux-serverユニットと同じソケットを参照する。

## guardrail との二重確認

`create_detached_session` のbash実行は guardrail のコマンド判定も受ける。標準の `guardrail.yaml` ではtmuxコマンドはデフォルトルール（`.*` allow）で許可されるため、通常は本拡張の確認だけが表示される。ユーザーが `guardrail.yaml` のコマンドルールを変更し、tmuxコマンドが確認対象になった場合は、本拡張の承認に加えてguardrailの確認ダイアログが表示される。この二重確認は緩和・迂回せず、そのまま残す。
