$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$captionPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $captionPython)) {
    python -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw 'Python 3.13 or newer is required.' }
}
& $captionPython -m pip install --disable-pip-version-check -r requirements.txt
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
& $captionPython (Join-Path $PSScriptRoot 'native_host.py') --install
if ($LASTEXITCODE -ne 0) { throw 'Automatic launcher installation failed.' }
Write-Host 'Setup complete. Load or reload the extension, then click CC on YouTube.'
