# Creates the ReelSmith database on a native PostgreSQL install without needing the postgres password.
# Run once in an *Administrator* PowerShell:
#   powershell -ExecutionPolicy Bypass -File .\scripts\setup-local-db.ps1      (from the ReelSmith folder)
#
# It temporarily allows passwordless logins from this machine only (127.0.0.1 / ::1), creates the
# role "reelsmith" (password "reelsmith") and the database "reelsmith", then restores pg_hba.conf.
# The postgres superuser's password is not changed.
param(
  [string]$PgDir = "",    # default: the newest version under "C:\Program Files\PostgreSQL"
  [string]$Service = ""   # default: postgresql-x64-<that version>
)
$ErrorActionPreference = "Stop"
if (-not $PgDir) {
  $PgDir = Get-ChildItem "$env:ProgramFiles\PostgreSQL" -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^\d+$' } | Sort-Object { [int]$_.Name } | Select-Object -Last 1 -ExpandProperty FullName
  if (-not $PgDir) { Write-Host "PostgreSQL not found under $env:ProgramFiles\PostgreSQL. Pass -PgDir." -ForegroundColor Yellow; exit 1 }
}
if (-not $Service) { $Service = "postgresql-x64-" + (Split-Path $PgDir -Leaf) }
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host "Please run this from PowerShell opened with 'Run as administrator' (it has to restart the PostgreSQL service)." -ForegroundColor Yellow
  exit 1
}
$hba = Join-Path $PgDir "data\pg_hba.conf"
$psql = Join-Path $PgDir "bin\psql.exe"
$backup = "$hba.reelsmith-backup"

Copy-Item $hba $backup -Force
try {
  $trust = "host all postgres 127.0.0.1/32 trust`r`nhost all postgres ::1/128 trust`r`n"
  Set-Content -Path $hba -Value ($trust + (Get-Content $hba -Raw)) -NoNewline -Encoding ascii
  Restart-Service $Service
  Start-Sleep -Seconds 3

  $exists = & $psql -U postgres -h 127.0.0.1 -tAc "SELECT 1 FROM pg_roles WHERE rolname='reelsmith'"
  if ($exists -ne "1") { & $psql -U postgres -h 127.0.0.1 -c "CREATE ROLE reelsmith LOGIN PASSWORD 'reelsmith' CREATEDB;" }
  else { & $psql -U postgres -h 127.0.0.1 -c "ALTER ROLE reelsmith LOGIN PASSWORD 'reelsmith' CREATEDB;" }
  $db = & $psql -U postgres -h 127.0.0.1 -tAc "SELECT 1 FROM pg_database WHERE datname='reelsmith'"
  if ($db -ne "1") { & $psql -U postgres -h 127.0.0.1 -c "CREATE DATABASE reelsmith OWNER reelsmith;" }
  Write-Host "OK: role and database 'reelsmith' are ready." -ForegroundColor Green
}
finally {
  Copy-Item $backup $hba -Force
  Restart-Service $Service
  Remove-Item $backup -Force
  Write-Host "pg_hba.conf restored."
}
