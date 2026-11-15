# winconfig SPEC

`undotfiles/winconfig/` は、Windowsの構成(レジストリ・スケジュールタスク・PowerShellスクリプト)を宣言的定義から適用(apply)・解除(revert)する構成を管理する。定義正本 `definitions.yaml` と `actions.yaml`、実行器 `engine.ts` からなり、実行ランタイムはbunである。適用は、定義から生成したPowerShellスクリプトを1プロセスで逐次実行する。

## 用語

- タスク: 定義の1単位。グループ名とタスク名で識別し、`apply`と`revert`の2方向の操作を持つ
- ActionMode: タスクごとの実行指定。`apply` / `revert` / `skip`
- 存在指定: 目標状態を表す文字列。`<Exist>` / `<NotExist>` / `<NotChange>`。実行結果の分類とは別である
- raw本文: スクリプト定義の`apply`または`revert`に書かれたPowerShell本文
- タスク結果: `success`(成功) / `failed`(失敗) / `skipped`(スキップ)の3分類

## コマンド

```
bun undotfiles/winconfig/engine.ts [revert] [--print]
```

| 条件 | 動作 |
| --- | --- |
| 引数なし | Actionsのモードどおりに全タスクを実行する |
| `revert` | Actionsの`apply`を`revert`へ、`revert`を`apply`へ反転して実行する |
| `--print` | Actions選択・`skip`・`revert`反転に従って生成したPowerShellスクリプトを、実行せずBOMなしで標準出力へ出力する。gsudo・PowerShellの検索・起動は行わない |

未知の引数は、外部コマンドを検索・起動する前に終了コード1になる。

- CLIは引数を検証した後、`--print` なしの実行をWindowsでのみ受け付ける。Windows以外では実行前に終了コード1で止める
- 実行は生成スクリプトをUTF-8 BOM付きの一時ファイルへ書き出し、gsudo経由で `pwsh`(無ければ`powershell`)の`-NoProfile` `-ExecutionPolicy Bypass` `-File`へ渡す。一時ファイルは子プロセス終了・起動失敗の後に削除する。gsudo・PowerShellが見つからない場合は終了コード1で止める
- 終了コードはPowerShellの終了コードを引き継ぐ(失敗1件以上で1)。定義・Actionsの検証エラーも終了コード1

## 定義 definitions.yaml

以下の YAML は記法説明で、`<...>` は値そのものではなく項目のヘルプを表す（存在指定の `<Exist>` などは実際の値）。省略値の記載がない項目は必須。

```yaml
Definitions:
  <グループ名>:
    <タスク名>:
      description: <説明（文字列）。人向けで、生成スクリプトには出ない>
      registries: <レジストリ操作のリスト。省略時 []。形式は下記>
      scheduled_tasks: <スケジュールタスク操作のリスト。省略時 []。形式は下記>
      script: <apply・revert の PowerShell本文。省略時は両方向とも空本文。形式は下記>
```

すべての層で、ここに挙げないキーは検証エラーになる。サービス定義(`services`)には対応しない。

### registries

```yaml
registries:
  - path: <レジストリキーパス。HKCR / HKCU / HKLM / HKU / HKCC で始める>
    old_existence: <revert時のキー目標。下記の存在指定。省略時 <Exist>>
    new_existence: <apply時のキー目標。下記の存在指定。省略時 <Exist>>
    entries:
      - name: <値の名前。(default) はキーの既定値>
        type: <String / ExpandString / Binary / DWord / MultiString / QWord>
        old_value: <revert時の値目標（文字列）。<NotExist> は削除、それ以外は設定>
        new_value: <apply時の値目標（文字列）。<NotExist> は削除、それ以外は設定>
```

`entries` はキー配下の値の操作リストで、省略時は `[]`。`path` は `HKEY_CURRENT_USER\` や `HKCU:\`、`Registry::` 付きも正規化して受け付ける。

存在指定と扱い:

| 値 | 意味 |
| --- | --- |
| `<Exist>` | キーが存在する状態。無ければ作成し、あれば維持する |
| `<NotExist>` | キーが削除済みの状態。存在すれば削除する |
| `<NotChange>` | キー自体を操作しない。エントリの操作は指定に従う |

- エントリの `<NotChange>` は文字列として設定され、キーの存在指定とは意味が異なる
- エントリの値は YAML上で文字列として書く（`"0"` など）。`Binary` は `"80 75 5 6"` のようにバイト列をスペース区切りで書く
- エントリの値にはレジストリへ設定される最終値をそのまま書く。PowerShell文字列への埋め込み時に必要なエスケープ(`"`・`$`・バックネット)はエンジンが行う

パス中の`*`はPowerShellのワイルドカードとして展開される(`HKCR\*\shell\...`など、複数キーへの一括指定)。レジストリ操作は、操作時点でのキー・値の状態に応じて結果判定される。

### scheduled_tasks

```yaml
scheduled_tasks:
  - full_path: <タスクのフルパス（ルートフォルダは \）>
    old_state: <revert時の状態。Enabled / Disabled>
    new_state: <apply時の状態。Enabled / Disabled>
```

既存タスクの有効・無効だけを切り替える。存在しないタスクは失敗(対象未存在)になり、新規作成はしない。

### script

```yaml
script:
  apply: |-
    <apply時の PowerShell本文（文字列）。省略時は空本文で操作なし>
  revert: |-
    <revert時の PowerShell本文（文字列）。省略時は空本文で操作なし>
```

- 本文の終了通知は`return`または`throw`である。`return`はタスク内の実行を終え、そこまでの操作結果で判定する。`throw`は失敗を通知する
- 本文の通常出力はタスク結果行の前に出力される。出力に`<PermissionDenied>`などの文字列が含まれても、それだけでは失敗と判定しない

## actions.yaml

```yaml
Actions:
  <グループ名>:
    <タスク名>: <実行モード。apply / revert / skip>
```

| 条件 | 動作 |
| --- | --- |
| モードが`apply` / `revert` | その方向でタスクを実行する(`revert`実行時は反転) |
| モードが`skip` | 実行しない。`Skipped: <group> > <task>[skip]`を標準エラーへ出力する |
| 定義に存在するタスクがActionsに無い | 実行しない。`NoAction: <group> > <task>`を標準エラーへ出力する |
| Actionsが定義に無いタスクを参照している | 検証エラーとし、実行前に終了コード1で止める(定義とActionsの乖離を防止する) |

## 生成されるPowerShell

- スクリプトは先頭に`$ErrorActionPreference = 'Stop'`とヘルパー関数定義を置き、タスク定義順に各タスクを逐次実行し、最後に集計行と終了コードを出力する
- 各タスクは3行のコメントバナー(タイトル行`# <group> > <task> - [<mode>]`を同文字幅のハイフン行で挟む)と空行1行の後に、`Invoke-WinconfigTask`呼び出しが続く
- タスク内の操作順は、各レジストリのキー → エントリ、次に`scheduled_tasks`、最後にraw本文である
- `apply`は`new_*`側、`revert`は`old_*`側の宣言から操作を生成する
- 1タスクの失敗で他のタスクを止めず、実行対象を全件実行する

### 操作結果の判定

| 条件 | 結果 |
| --- | --- |
| 削除対象が既に存在しない | success(削除済み) |
| 変更・作成対象のキーやタスクが存在しない | failed(対象未存在) |
| 権限を拒否される | failed(権限不足。管理者権限が必要) |
| 通常のPowerShellエラー | failed(エラーの理由) |
| 同じ値・状態が既に設定されている | success(実際の変更の有無を成功条件にしない) |
| 実行する操作が無い、または`<NotChange>`のみ | skipped |
| 上記のいずれにも該当せず操作が完了する | success |

失敗条件は成功条件より優先し、タスク内で最初の失敗が起きた時点で残りの操作を止める。実行済みの変更は戻さない。

### 結果の集約と表示

| 条件 | タスク結果 | 表示 |
| --- | --- | --- |
| 1つ以上の操作が失敗 | `failed` | `Failed: <group> > <task>[<mode>] - <最初の失敗理由>` |
| 失敗がなく成功した操作が1つ以上ある | `success` | `Success: <group> > <task>[<mode>]`(理由は出さない) |
| 失敗も成功もなく、空または`<NotChange>`のみ | `skipped` | `Skipped: <group> > <task>[<mode>] - <理由>` |

最終行に`Summary: success=<n> failed=<n> skipped=<n>`を出力する。`<n>`は各分類のタスク件数で、3件数の合計は実行タスク数に等しい。失敗1件以上で終了コード1、それ以外は0である。

## 検証

- `engine.test.ts`がロード・検証・モード解決・スクリプト生成を自動テストする(Windows外で実行可)。実行は `cd undotfiles/winconfig && bun test`
- 型検証はリポジトリルートの`bunx tsc --noEmit`で行う
