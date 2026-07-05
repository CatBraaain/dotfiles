$ime = [IME]::New()

$ime.createRomaDict()
$ime.createRomaTxt()
$ime.createRomaBinHex()
# $ime.createRegFile()
$ime.registerReg()
$ime.showTables()

class IME {
    $REG_KEY_PATH = "HKCU\SOFTWARE\Microsoft\IME\15.0\IMEJP\RomaDef\CustomRoma"
    $REG_FILE_PATH = "${PSScriptRoot}\CustomRomaDef.reg"

    $firstChrDict = [ordered]@{
        "l"  = @("", "ぁ", "ぃ", "ぅ", "ぇ", "ぉ")
        ""   = @("", "あ", "い", "う", "え", "お")
        "k"  = @("", "か", "き", "く", "け", "こ")
        "c"  = @("", "か", "き", "く", "け", "こ")
        "g"  = @("", "が", "ぎ", "ぐ", "げ", "ご")
        "s"  = @("", "さ", "し", "す", "せ", "そ")
        "z"  = @("", "ざ", "じ", "ず", "ぜ", "ぞ")
        "t"  = @("", "た", "ち", "つ", "て", "と")
        "d"  = @("", "だ", "ぢ", "づ", "で", "ど")
        "n"  = @("", "な", "に", "ぬ", "ね", "の")
        "h"  = @("", "は", "ひ", "ふ", "へ", "ほ")
        "b"  = @("", "ば", "び", "ぶ", "べ", "ぼ")
        "p"  = @("", "ぱ", "ぴ", "ぷ", "ぺ", "ぽ")
        "m"  = @("", "ま", "み", "む", "め", "も")
        "y"  = @("", "や", "", "ゆ", "いぇ", "よ")
        "ly" = @("", "ゃ", "", "ゅ", "", "ょ")
        "r"  = @("", "ら", "り", "る", "れ", "ろ")
        "w"  = @("", "わ", "うぃ", "", "うぇ", "を")
        "q"  = @("", "くぁ", "くぃ", "", "くぇ", "くぉ")
        "j"  = @("", "じゃ", "じ", "じゅ", "じぇ", "じょ")
        "f"  = @("", "ふぁ", "ふぃ", "ふ", "ふぇ", "ふぉ")
        "v"  = @("", "ヴぁ", "ヴぃ", "ヴ", "ヴぇ", "ヴぉ")
    }
    $secondChrDict = [ordered]@{
        "a"  = @{"jpFirstChrIndex" = 1; "jpSecondStr" = "" }
        "i"  = @{"jpFirstChrIndex" = 2; "jpSecondStr" = "" }
        "u"  = @{"jpFirstChrIndex" = 3; "jpSecondStr" = "" }
        "e"  = @{"jpFirstChrIndex" = 4; "jpSecondStr" = "" }
        "o"  = @{"jpFirstChrIndex" = 5; "jpSecondStr" = "" }

        "ya" = @{"jpFirstChrIndex" = 2; "jpSecondStr" = "ゃ" }
        # "yi" = @{"jpFirstChrIndex" = 2; "jpSecondStr" = "ぃ"}
        "yu" = @{"jpFirstChrIndex" = 2; "jpSecondStr" = "ゅ" }
        # "ye" = @{"jpFirstChrIndex" = 2; "jpSecondStr" = "ぇ"}
        "yo" = @{"jpFirstChrIndex" = 2; "jpSecondStr" = "ょ" }

        "ha" = @{"jpFirstChrIndex" = 2; "jpSecondStr" = "ゃ" }
        "hi" = @{"jpFirstChrIndex" = 4; "jpSecondStr" = "ぃ" }
        "hu" = @{"jpFirstChrIndex" = 2; "jpSecondStr" = "ゅ" }
        "he" = @{"jpFirstChrIndex" = 2; "jpSecondStr" = "ぇ" }
        "ho" = @{"jpFirstChrIndex" = 2; "jpSecondStr" = "ょ" }

        "wa" = @{"jpFirstChrIndex" = 3; "jpSecondStr" = "ぁ" }
        "wi" = @{"jpFirstChrIndex" = 3; "jpSecondStr" = "ぃ" }
        "wu" = @{"jpFirstChrIndex" = 5; "jpSecondStr" = "ぅ" }
        "we" = @{"jpFirstChrIndex" = 3; "jpSecondStr" = "ぇ" }
        "wo" = @{"jpFirstChrIndex" = 3; "jpSecondStr" = "ぉ" }

        #region

        # "s"  = @{"jpFirstChrIndex" = 1; "jpSecondStr" = "い"}
        # "ys" = @{"jpFirstChrIndex" = 2; "jpSecondStr" = "ゃい"}
        # "hs" = @{"jpFirstChrIndex" = 2; "jpSecondStr" = "ゃい"}

        # "d"  = @{"jpFirstChrIndex" = 4; "jpSecondStr" = "い"}
        # "yd" = @{"jpFirstChrIndex" = 2; "jpSecondStr" = "ぇい"}
        # "hd" = @{"jpFirstChrIndex" = 2; "jpSecondStr" = "ぇい"}

        # "r"  = @{"jpFirstChrIndex" = 4; "jpSecondStr" = "ん"}
        # "yr" = @{"jpFirstChrIndex" = 2; "jpSecondStr" = "ぇん"}
        # "hr" = @{"jpFirstChrIndex" = 2; "jpSecondStr" = "ぇん"}

        # "j"  = @{"jpFirstChrIndex" = 3; "jpSecondStr" = "ん"}
        # "yj" = @{"jpFirstChrIndex" = 2; "jpSecondStr" = "ゅん"}
        # "hj" = @{"jpFirstChrIndex" = 2; "jpSecondStr" = "ゅん"}

        # "k"  = @{"jpFirstChrIndex" = 2; "jpSecondStr" = "ん"}
        # "yk" = @{"jpFirstChrIndex" = 4; "jpSecondStr" = "ぃん"}
        # "hk" = @{"jpFirstChrIndex" = 4; "jpSecondStr" = "ぃん"}

        # "l"  = @{"jpFirstChrIndex" = 5; "jpSecondStr" = "う"}
        # "yl" = @{"jpFirstChrIndex" = 2; "jpSecondStr" = "ょう"}
        # "hl" = @{"jpFirstChrIndex" = 2; "jpSecondStr" = "ょう"}

        # "p"  = @{"jpFirstChrIndex" = 5; "jpSecondStr" = "ん"}
        # "yp" = @{"jpFirstChrIndex" = 2; "jpSecondStr" = "ょん"}
        # "hp" = @{"jpFirstChrIndex" = 2; "jpSecondStr" = "ょん"}

        # "n"  = @{"jpFirstChrIndex" = 1; "jpSecondStr" = "ん"}
        # "yn" = @{"jpFirstChrIndex" = 2; "jpSecondStr" = "ゃん"}
        # "hn" = @{"jpFirstChrIndex" = 2; "jpSecondStr" = "ゃん"}

        #endregion
    }
    $uniqueDict = [ordered]@{
        "dhu" = "でゅ"
        "who" = "うぉ"
        "nn"  = "ん"
        "wyi" = "ゐ"
        "wye" = "ゑ"
        "ltu" = "っ"
        "lwa" = "ゎ"
        "lka" = "ヵ"
        "lke" = "ヶ"
    }
    $romaTable
    $romaTxtArr
    $romaTxt
    $romaBin
    $romaHex
    $regFileContent

    IME() {
    }

    createRomaDict() {
        $this.romaTable = [ordered]@{}
        forEach ($enFirstChr in $this.firstChrDict.keys) {
            $romaTableRow = [ordered]@{}
            $romaTableRow["\"] = $enFirstChr
            forEach ($enSecondChr in $this.secondChrDict.keys) {
                $romaTableRow[$enSecondChr] = $this.convertRoma($enFirstChr, $enSecondChr)
            }
            $this.romaTable[$enFirstChr] = $romaTableRow
        }
        $this.romaTable["*"] = $this.uniqueDict
    }

    [string]convertRoma($enFirstChr, $enSecondChr) {
        #TODO
        $VOWEL = "[aiueo]"
        $CONTRACTED_VOWEL = "[yh][auo]"
        $CONTRACTED_CONSONANT = "[kcgsztdnhbpmr]"
        # $CONTRACTED_CONSONANT = "[kcgstdnhbpmr]"

        $jpFirstChrArr = $this.firstChrDict[$enFirstChr]
        $jpFirstChr = $jpFirstChrArr[$this.secondChrDict[$enSecondChr]["jpFirstChrIndex"]]
        $jpSecondChr = $this.secondChrDict[$enSecondChr]["jpSecondStr"]
        $hasJpFirstChr = !!$jpFirstChr

        $isUnique = "${enFirstChr}${enSecondChr}" -in $this.uniqueDict.keys

        $isNormal = # 清音のみ,,連投撥音上書き回避
        ($enSecondChr -like $VOWEL) `
            -and $hasJpFirstChr `
            -and !($enSecondChr -eq $enFirstChr)

        $isConstracted = # 拗音のみ,,連投撥音上書き回避,単キー撥音上書き回避
        (($enSecondChr -like "${CONTRACTED_VOWEL}") -and ($enFirstChr -like $CONTRACTED_CONSONANT)) `
            -and $hasJpFirstChr `
            -and !($enSecondChr -like "${enFirstChr}*") `
            -and !(($enSecondChr -like "h*") -and ($enFirstChr -like "[n]")) `

        # -and !(($enSecondChr -like "h*") -and ($enFirstChr -like "[dnhb]")) `
        # -and !(($enSecondChr -like "y*") -and ($enFirstChr -like "[cgtdr]")) `
        # -and !(($enSecondChr -like "[y][as]") -and ($enFirstChr -like "[sk]"))

        $isCustomConstracted = # 特殊拗音
        (($enSecondChr -like "hi") -and ($enFirstChr -like "[td]")) `
            -or (($enSecondChr -like "he") -and ($enFirstChr -like "[kcgst]")) `
            -or (($enSecondChr -like "w*") -and ($enFirstChr -like "[kcgsztdnhbpmr]")) `

        # -or ($enSecondChr -like "w*") -and ($enFirstChr -like "[gtd]") `
        # -or ($enSecondChr -like "wu") -and ($enFirstChr -like "[td]")
        # -or ($enSecondChr -like "he") -and ($enFirstChr -like "[st]") `

        if (!$isUnique -and ($isNormal -or $isConstracted -or $isCustomConstracted)) {
            return "${jpFirstChr}${jpSecondChr}"
        }
        else {
            return ""
        }
    }

    createRomaTxt() {
        $this.romaTxtArr = @()
        forEach ($en1 in $this.romaTable.keys) {
            forEach ($en2 in $this.romaTable[$en1].keys) {
                if (($en1 -ne "\") -and ($this.romaTable[$en1][$en2] -ne "")) {
                    $this.romaTxtArr += "${en1}${en2}=$($this.romaTable[$en1][$en2])".replace("*", "")
                }
            }
        }

        $this.romaTxtArr = $this.romaTxtArr | Sort-Object
        $this.romaTxt = $this.romaTxtArr -join "`r`n"
    }

    createRomaBinHex() {
        $bin2dArr = ($this.romaTxtArr | % { , ([System.Text.Encoding]::GetEncoding(932).GetBytes($_) + 0) }) + 0
        $this.romaBin = $bin2dArr | % { $_ }

        $hex2dArr = $bin2dArr | % { , ($_ | % { $_.ToString("X2") }) }
        $hexArr = $hex2dArr | % { , (($_ -join ",") + ",\") }
        $this.romaHex = ($hexArr -join "`r`n")
    }

    createRegFile() {
        $this.regFileContent = @(
            "Windows Registry Editor Version 5.00"
            ""
            "[$($this.REG_KEY_PATH)]"
            """table""=hex:\"
            $this.romaHex
        ) -join "`r`n"
        Set-Content -Path $this.REG_FILE_PATH -Value $this.regFileContent
    }

    registerReg() {
        New-Item -Path "Registry::$($this.REG_KEY_PATH)" -Force
        New-ItemProperty -Path "Registry::$($this.REG_KEY_PATH)" -Name "table" -PropertyType "Binary" -Value $this.romaBin -Force
    }

    [Object]showTables() {
        return @(
            $this.firstChrDict.keys | % { [PSCustomObject]$ime.romaTable[$_] } | Format-Table * -AutoSize
            [PSCustomObject]$this.uniqueDict | Format-Table * -AutoSize
            "$(($this.romaTxt -split "`r`n").count)/320"
        )
    }
}

# https://www.detblog.com/windows-10-%E3%81%AE-ms-ime-%E3%81%A7%E3%83%AD%E3%83%BC%E3%83%9E%E5%AD%97%E5%A4%89%E6%8F%9B%E8%A1%A8%E3%82%92%E3%82%AB%E3%82%B9%E3%82%BF%E3%83%9E%E3%82%A4%E3%82%BA%E3%81%99%E3%82%8B-azik/
# http://jgrammar.life.coocan.jp/ja/tools/imekeys.htm
# コンピューター\HKEY_CURRENT_USER\SOFTWARE\Microsoft\IME\15.0\IMEJP\RomaDef\CustomRoma
# データ数320が限界

# TODO:
#   HKCU\Software\Microsoft\IME\15.0\IMEJP\MSIME
#     入力モード切替通知
#     予測入力オフ
#   HKCU\Software\Microsoft\IME\15.0\IMEJP\StyleList\Custom
#     無変換削除
#     F7 => 無変換
#     全角半角 => 入力中など全モードで有効化