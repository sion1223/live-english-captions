$ErrorActionPreference = 'Stop'
$captionPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $captionPython)) { & (Join-Path $PSScriptRoot 'setup.ps1') }
try {
    $captionHealth = Invoke-RestMethod 'http://127.0.0.1:8765/health' -TimeoutSec 2
    if ($captionHealth.app -eq 'live-english-captions') {
        Write-Host 'Caption server is already running.'
        exit 0
    }
    throw 'Port 8765 is occupied by another application.'
} catch {
    if ($_.Exception.Message -like 'Port 8765*') { throw }
}
$captionRun = Join-Path $PSScriptRoot '.run'
New-Item -ItemType Directory -Path $captionRun -Force | Out-Null
$captionServer = Join-Path $PSScriptRoot 'server.py'
$captionProcess = Start-Process -FilePath $captionPython -ArgumentList @('-u', ('"' + $captionServer + '"')) -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $captionRun 'server.log') -RedirectStandardError (Join-Path $captionRun 'server-error.log') -PassThru
$captionProcess.Id | Set-Content -LiteralPath (Join-Path $captionRun 'server.pid')
for ($captionAttempt = 0; $captionAttempt -lt 30; $captionAttempt++) {
    Start-Sleep -Milliseconds 400
    if ($captionProcess.HasExited) { throw ('Server failed. See ' + (Join-Path $captionRun 'server-error.log')) }
    try {
        $captionHealth = Invoke-RestMethod 'http://127.0.0.1:8765/health' -TimeoutSec 1
        if ($captionHealth.app -eq 'live-english-captions') {
            Write-Host 'Caption server ready. Open YouTube and click CC on the video.'
            exit 0
        }
    } catch { }
}
throw 'Server did not become ready. See .run/server-error.log.'
