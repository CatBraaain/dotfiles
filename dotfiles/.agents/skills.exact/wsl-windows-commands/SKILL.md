---
name: wsl-windows-commands
description: >-
  WSL から Windows コマンドを実行する方法を選ぶ。Windows 側のプロセス、実行ファイル、ネットワーク設定、レジストリを確認するときや、cmd.exe、PowerShell、Windows の .exe を WSL から実行・動作確認するときに使う。
---

# WSL からの Windows コマンド実行

1. 確認したい対象を特定する。`cmd.exe` や PowerShell が確認対象ではなく単なる起動手段なら、同じ結果を得られる許可済みの Windows `.exe` を、WSL の Bash から絶対パスで直接実行する。
2. `.exe` を直接実行できることと、実行が許可されていることは別。以下は既定のマウント先での例であり、実際のパスと引数には現在のコマンド承認ルールが適用される。
3. シェル自体の動作、組み込みコマンド、PowerShell 固有の結果が必要なら、そのシェルを通常の承認手順で実行する。承認が必要と判定されたコマンドを、別経路で同じ操作を行って回避しない。

| 確認したいこと | Bash から直接実行する例 |
| --- | --- |
| `chrome.exe` のプロセスがあるか | `/mnt/c/Windows/System32/tasklist.exe /fi 'IMAGENAME eq chrome.exe'` |
| Windows の `PATH` から `cmd.exe` が見つかるか | `/mnt/c/Windows/System32/where.exe '$PATH:cmd.exe'` |
| Windows のネットワーク設定を表示する | `/mnt/c/Windows/System32/ipconfig.exe /all` |
| レジストリから Windows のビルド番号を読む | `/mnt/c/Windows/System32/reg.exe query 'HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion' /v CurrentBuildNumber` |

`where.exe` の `'$PATH:cmd.exe'` は、Bash で展開せず Windows 側の `PATH` を検索する指定。PowerShell の関数・エイリアス・コマンドレットは確認できない。`cmd.exe` 自体の起動が確認対象なら `/mnt/c/Windows/System32/cmd.exe /c ver` を実行する。ファイルが見つかっただけでは起動確認にならない。

## 出力を絞り込む

テキストや CSV で足りるなら、Windows `.exe` の標準出力を WSL 側の `grep` などに Bash の `|` で渡す。絞り込みまで1回の Bash 呼び出しで済ませ、中間出力は読まない。実行の承認ルールはパイプの各コマンドに適用される。

たとえば Chrome のプロセス行だけを取得する。

```bash
/mnt/c/Windows/System32/tasklist.exe /fo csv /nh | grep -i '^"chrome\.exe",'
```

一致の有無を判定する場合は、パイプ直後に `status=("${PIPESTATUS[@]}")` で両方の終了コードを保存する。Windows コマンドが `0` で、`grep` が `1` の場合だけ一致なしと判断する。

PowerShell のオブジェクトや型付きプロパティが必要で、テキスト出力では足りないときは、PowerShell のパイプラインを通常の承認手順で実行する。
