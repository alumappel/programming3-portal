$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
Write-Host 'Open http://127.0.0.1:4173/admin.html. Choose your password in the editor on first use.'
& node server/local.mjs
