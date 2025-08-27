using module ".\WindowController.psm1"

function RunAsync {
    param (
        [Parameter(Mandatory)]
        [string]$FilePath,
        [string]$Arguments,
        [string]$Options,
        [string]$WinTitle,
        [switch]$HideWin,
        [switch]$CloseWin
    )

    $command = "Start-Process -FilePath ""$FilePath"""
    $folderPath = $(Split-Path -Path $FilePath -Parent)
    if ($folderPath) {$command += " -WorkingDirectory ""$folderPath"""}
    if ($Arguments) {$command += " -ArgumentList ""$Arguments"""}
    if ($Options) {$command += " $Options"}

    echo $command
    Invoke-Expression $command

    $process = $null
    $shouldWait = !!$WinTitle
    if ($shouldWait) {
        While (!($process = (Get-Process | ? {$_.MainWindowTitle -like $WinTitle}))) {
            SLEEP 0.5
        }
        [WindowController]::FocusWindow($process.MainWindowHandle);

        if ($HideWin) {
            [WindowController]::ShowWindowAsync($process.MainWindowHandle, [WindowShowStyle]::Minimize)
        }

        if ($CloseWin) {
            While ($process = (Get-Process | ? {$_.MainWindowTitle -like $WinTitle})) {
                $process.CloseMainWindow() | Out-Null
                SLEEP 2.0
            }
        }
    }
}

# メモ
# Get-Process | ? {$_.MainWindowTitle} | Format-Table MainWindowTitle
