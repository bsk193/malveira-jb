$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$runtime = Get-Command node -ErrorAction SilentlyContinue
if ($runtime) { & $runtime.Source server.mjs }
else {
    $bundled = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
    if (Test-Path -LiteralPath $bundled) { & $bundled server.mjs }
    else { throw 'Node.js 22 or newer is required. Install Node.js and run Start.ps1 again.' }
}
