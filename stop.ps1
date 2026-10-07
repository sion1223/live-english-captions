$ErrorActionPreference = 'Stop'
$captionPidFile = Join-Path $PSScriptRoot '.run\server.pid'
if (Test-Path -LiteralPath $captionPidFile) {
    $captionPid = [int](Get-Content -LiteralPath $captionPidFile)
    $captionProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $captionPid"
    $captionServer = Join-Path $PSScriptRoot 'server.py'
    if ($captionProcess -and $captionProcess.CommandLine -match [regex]::Escape($captionServer)) {
        Stop-Process -Id $captionPid
        Write-Host 'Caption server stopped.'
    }
    Remove-Item -LiteralPath $captionPidFile
}
