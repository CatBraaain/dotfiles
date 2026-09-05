# Git worktree 運用

main worktree ではファイルを編集しない。編集を伴う作業は、1ファイルの軽微な修正も含め、常にサブワークツリーとブランチを作成して着手する。

- 着手時: 「作成」の手順で worktree を作成する。セッションの cwd は main worktree に置いたまま、worktree を指定して作業する。
- まとまった作業単位の完了時: 「finish・discard・close」の finish を、owner の承認を得てから実行する。
- 適用しない: 読み取りのみの調査・検索・検証、コミット・マージなど worktree を必要としない操作。

## 作成

1. branch 名は取り組む機能を表す kebab-case 英語（例: `add-export-command`）。リポジトリ規約があれば優先する。
2. `git worktree add ~/projects/<リポジトリ名>-worktrees/<branch> -b <branch>` で HEAD から worktree を作成する。worktree はリポジトリごとに `<リポジトリ名>-worktrees` ディレクトリへ集約する。書き込みが sandbox にブロックされたら、作成先の worktree パス（またはその親ディレクトリ）を ask_permission で承認させる。
3. worktree 内のファイルは絶対パスで read/write/edit する。相対パスはセッション cwd（main worktree）に解決されるため、worktree のファイル指定に使わない。git 操作は `git -C <worktree のパス>` で実行する。

main の未コミット変更はその場に残す。worktree への持ち運びは行わない。

## 統合

ローカルの使い捨て worktree ブランチを統合先（main 等）へマージするときは、履歴を線形に保つ。

1. 統合先で `git merge --ff-only <branch>` を実行する。`git -C <main worktree のパス> merge --ff-only <branch>` でも実行できる。
2. 統合先が diverge して失敗するときは、対象ブランチを `git rebase <統合先>` してから再度 ff-only マージする。
3. `--no-ff` による merge commit と `--squash` による squash 統合は行わない。

- 適用する: ローカルの使い捨て worktree ブランチの統合。この統合のための rebase は、git skill「コミットの作成と分割」の rebase 禁止の対象外とする。
- 適用しない: remote へ push 済みで共有しているブランチ。トポロジーとして作業のまとまりを記録したいタスクは、worktree ではなく PR で統合する。

検証: 統合後に `git log --graph --oneline -n <統合した commit 数 + 2>` を確認し、merge commit がなく線形であること。

## finish・discard・close

worktree は自動掃除されないため、エージェントが作業完了時に自分で閉じる。原則として finish で閉じ、成果を捨てるときは discard で閉じる。閉じ方は次の3語で区別する。

| 言葉 | 意味 |
| --- | --- |
| finish | 成果を統合先へ取り込んで閉じる。owner の承認を得てから実行する |
| discard | 変更と branch を捨てて閉じる。owner の承認を得てから実行する |
| close | worktree と branch を削除する。finish・discard の最終段として実行する |

finish — 統合の判断が入るため、マージ前に owner の承認を得る。承認後:

1. worktree 内の変更を確認し、あれば git skill「コミットの作成と分割」に従って commit する。手順3の backup branch は、close で worktree ごと削除するため作らない。
2. 「統合」に従って統合先へマージする。
3. close を実行する。

discard — 成果を捨てる判断が入るため、実行前に owner の承認を得る。承認後:

1. worktree の branch 名と未コミット変更を確認し、捨てる対象を特定する。
2. close を `--force` と `-D` で実行する。

close — bash のカレントディレクトリが対象 worktree 内にあると削除に失敗するため、対象外のディレクトリから実行する。エディタのワークスペースから worktree を外す操作は本手順に含まず、owner が手動で行う。

1. `git worktree remove <worktree のパス>` で worktree を削除する。
2. `git branch -d <branch>` で、worktree が checkout していた branch を削除する。
3. `git worktree list` に prunable な参照が残っていれば、`git worktree prune` を実行する。

手順1・2は、未コミット変更・未マージの branch があると失敗する。失敗したときは close 単独で先へ進らず、成果を取り込むなら finish、捨てるときは owner の承認を得て discard として扱う。

検証: `git worktree list` に対象 worktree がなく、`git branch --list <branch>` が空であること。中途終了で残った worktree は `git worktree list` で点検する。
