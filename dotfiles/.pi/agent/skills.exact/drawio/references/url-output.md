# URL・詳細出力

URL出力、透明背景・倍率・サイズ・ページ指定、またはOS別に成果物を開く場合だけ使う。

## 詳細出力

| フラグ | 用途 |
|---|---|
| `-t` | PNG背景を透明にする |
| `-s` | 出力倍率を指定する |
| `--width` / `--height` | アスペクト比を保って指定寸法へ収める |
| `-a` | PDFの全ページを出力する |
| `-p` | 1始まりのページ番号を選ぶ |
| `--mermaid-image 1` | Mermaidを静的SVG画像セルにする。ユーザーが非編集の画像セルを明示した場合だけ使う |

PNG、SVG、PDFには`-e`でdiagram XMLを埋め込める。JPGは埋め込みに対応しない。

| 環境 | 成果物を開くコマンド |
|---|---|
| macOS | `open <file>` |
| Linux | `xdg-open <file>` |
| WSL2 | `cmd.exe /c start "" "$(wslpath -w <file>)"` |
| Windows | `start <file>` |

WSL2の`start`では、空の`""`を先に渡す。ファイル名をウィンドウタイトルとして解釈させないためである。

## URL出力

一時`NAME.drawio`から、Node.js組み込みの`zlib`でdiagram XMLを圧縮してURLを作る。

```bash
URL=$(node -e '
const fs = require("fs");
const zlib = require("zlib");
const xml = fs.readFileSync(process.argv[1], "utf8");
const compressed = zlib.deflateRawSync(encodeURIComponent(xml)).toString("base64");
const payload = encodeURIComponent(JSON.stringify({ type: "xml", compressed: true, data: compressed }));
console.log("https://app.diagrams.net/?grid=0&pv=0&border=10&edit=_blank#create=" + payload);
' "NAME.drawio")
```

macOSでは`open "$URL"`、Linuxでは`xdg-open "$URL"`で開く。WindowsとWSL2ではURLを直接`cmd.exe /c start`へ渡さない。`&`と`#`でURLフラグメントが失われるため、`.url`ファイルを経由する。

```bash
TMPFILE=$(mktemp --suffix=.url)
printf '[InternetShortcut]\r\nURL=%s\r\n' "$URL" > "$TMPFILE"
cmd.exe /c start "" "$(wslpath -w "$TMPFILE")"
```

Windowsネイティブでは`echo URL=%URL%`を使わず、Node.jsで`.url`ファイルを書く。

```bash
TMPFILE=$(node -e '
const fs = require("fs");
const os = require("os");
const path = require("path");
const p = path.join(os.tmpdir(), "drawio.url");
fs.writeFileSync(p, "[InternetShortcut]\r\nURL=" + process.argv[1] + "\r\n");
process.stdout.write(p);
' "$URL")
cmd.exe /c start "" "$TMPFILE"
```

URLがブラウザーの長さ上限を超える場合は、URL出力を中止し、正本`.drawio.svg`の絶対パスを表示する。
