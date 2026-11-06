# Joins this PC to the render pool: runs the worker against the team's shared database and storage.
# Usage: join-pool.bat            (asks for the join code the first time, then remembers it in .env.pool)
#        join-pool.bat -Reset     (forget the saved code and ask again)
param([switch]$Reset)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$saved = Join-Path $root ".env.pool"
$python = Join-Path $root "worker\.venv\Scripts\python.exe"

if (-not (Test-Path $python)) {
  Write-Host "This PC isn't set up yet. Run setup.bat once, then run join-pool.bat again." -ForegroundColor Yellow
  exit 1
}
if ($Reset -and (Test-Path $saved)) { Remove-Item $saved }

if (Test-Path $saved) {
  $cfg = Get-Content $saved -Raw | ConvertFrom-Json
} else {
  $code = (Read-Host "Paste the join code from the pool owner").Trim()
  if (-not $code.StartsWith("RSPOOL1:")) { Write-Host "That isn't a join code. It starts with RSPOOL1:" -ForegroundColor Red; exit 1 }
  $b64 = $code.Substring(8).Replace('-', '+').Replace('_', '/')
  while ($b64.Length % 4) { $b64 += "=" }
  try { $cfg = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64)) | ConvertFrom-Json }
  catch { Write-Host "The join code is incomplete. Copy the whole line and try again." -ForegroundColor Red; exit 1 }
  $name = (Read-Host "Name for this PC in the app [$env:COMPUTERNAME]").Trim()
  if (-not $name) { $name = $env:COMPUTERNAME }
  $cfg | Add-Member -NotePropertyName POOL_NODE_NAME -NotePropertyValue $name -Force
  $cfg | ConvertTo-Json | Set-Content -Path $saved -Encoding UTF8
  Write-Host "Saved. Next time this PC joins without asking." -ForegroundColor Green
}

# The worker reads .env with "keep what's already set", so these shared settings win over local ones.
foreach ($p in $cfg.PSObject.Properties) { Set-Item -Path "Env:$($p.Name)" -Value ([string]$p.Value) }
if (-not $env:POOL_NODE_ID) { $env:POOL_NODE_ID = $env:COMPUTERNAME }
$Host.UI.RawUI.WindowTitle = "AJOURNALLAB Studio render pool: $($env:POOL_NODE_NAME)"
Write-Host "Joined the render pool as '$($env:POOL_NODE_NAME)'. This PC now picks up exports, transcription and inserts." -ForegroundColor Green
Write-Host "Close this window to leave the pool."
& $python (Join-Path $root "worker\main.py")
