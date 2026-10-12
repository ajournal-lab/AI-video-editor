<#
ReelSmith setup for Windows 10/11.

  setup.bat                       (double-click, or run from a terminal)
  powershell -ExecutionPolicy Bypass -File setup.ps1 [-DataDir D:\ReelSmith] [-CheckOnly] [-SkipUpscaler]

Checks and, where possible, installs (winget): Node 22+, Python 3.11+, ffmpeg (gyan.dev full build), Git.
Then: .env with this computer's paths, the worker venv + Python deps, npm packages, the Claude workspace
(rules.md, CLAUDE.md, tools, edit-reel skill, video-use skill), HyperFrames, the Whisper model, the background-matte
model, Real-ESRGAN, the database tables (prisma db push), and the Claude Code login. Ends with a pass/fail checklist.
Safe to re-run: it keeps your .env values and your rules.md.
#>
[CmdletBinding()]
param(
  [string]$DataDir = "",      # per-user data root; default %USERPROFILE%\ReelSmith (C:\ReelSmith if the profile path has spaces)
  [switch]$CheckOnly,         # report only, install nothing
  [switch]$SkipUpscaler       # don't download Real-ESRGAN (~45 MB)
)

$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"   # Invoke-WebRequest is very slow with the progress bar
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root
New-Item -ItemType Directory -Force (Join-Path $Root "logs") | Out-Null
try { Start-Transcript -Path (Join-Path $Root "logs\setup.log") -Force | Out-Null } catch {}

# Pinned third-party versions (bump deliberately)
$VideoUseRepo   = "https://github.com/browser-use/video-use.git"
$VideoUseCommit = "b877063835e6ea6e457124da7e28a0ae26691dc3"
$EsrganUrl      = "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip"
$RvmUrl         = "https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3_fp32.onnx"

# ------------------------------------------------------------------ helpers
$Results = New-Object System.Collections.ArrayList
function Result([string]$Check, [string]$Status, [string]$Detail = "") {
  [void]$Results.Add([pscustomobject]@{ Check = $Check; Status = $Status; Detail = $Detail })
  $color = @{ PASS = "Green"; WARN = "Yellow"; FAIL = "Red"; SKIP = "DarkGray" }[$Status]
  Write-Host ("  [{0}] {1}{2}" -f $Status, $Check, $(if ($Detail) { " - $Detail" } else { "" })) -ForegroundColor $color
}
function Step([string]$Title) { Write-Host "`n== $Title" -ForegroundColor Cyan }
function Have([string]$Cmd) { [bool](Get-Command $Cmd -ErrorAction SilentlyContinue) }
function Fwd([string]$P) { $P -replace '\\', '/' }
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}
function Winget-Install([string]$Id) {
  if ($CheckOnly) { return $false }
  if (-not (Have winget)) { Write-Host "  winget is not available; install $Id manually." -ForegroundColor Yellow; return $false }
  Write-Host "  installing $Id with winget..."
  winget install --id $Id -e --silent --accept-source-agreements --accept-package-agreements | Out-Host
  Refresh-Path
  return $true
}
function Add-UserPath([string]$Dir) {
  $user = [Environment]::GetEnvironmentVariable("Path", "User")
  if (($user -split ';') -notcontains $Dir) { [Environment]::SetEnvironmentVariable("Path", ($user.TrimEnd(';') + ";" + $Dir), "User") }
  if (($env:Path -split ';') -notcontains $Dir) { $env:Path = "$Dir;$env:Path" }
}
function Write-Utf8([string]$Path, [string]$Text) { [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding($false))) }

# .env read/write (keeps comments and order; values you set are never overwritten unless -Force)
$EnvPath = Join-Path $Root ".env"
function Get-EnvValue([string]$Key) {
  if (-not (Test-Path $EnvPath)) { return "" }
  foreach ($line in [IO.File]::ReadAllLines($EnvPath)) {
    if ($line -match "^\s*$Key\s*=\s*(.*)$") { return ($Matches[1].Trim() -replace '\s+#.*$', '').Trim('"', "'") }
  }
  return ""
}
function Set-EnvValue([string]$Key, [string]$Value, [switch]$Force) {
  $current = Get-EnvValue $Key
  if ($current -and -not $Force) { return $current }
  $lines = [System.Collections.Generic.List[string]]([IO.File]::ReadAllLines($EnvPath))
  $entry = "$Key=`"$Value`""
  $i = $lines.FindIndex([Predicate[string]] { param($l) $l -match "^\s*$Key\s*=" })
  if ($i -lt 0) { $i = $lines.FindIndex([Predicate[string]] { param($l) $l -match "^\s*#\s*$Key\s*=" }) }
  if ($i -ge 0) { $lines[$i] = $entry } else { $lines.Add($entry) }
  Write-Utf8 $EnvPath (($lines -join "`r`n") + "`r`n")
  return $Value
}

Write-Host "ReelSmith setup  ($Root)" -ForegroundColor White
if ($CheckOnly) { Write-Host "Check-only mode: nothing will be installed or changed." -ForegroundColor Yellow }
if ($Root -match ' ') { Write-Host "Note: this folder's path contains spaces. Claude's permission rules work best without them (e.g. C:\ReelSmith\app)." -ForegroundColor Yellow }

# ------------------------------------------------------------------ 1. .env and folders
Step ".env and folders"
if (-not (Test-Path $EnvPath)) {
  if ($CheckOnly) { Result ".env" "FAIL" "missing (run setup without -CheckOnly)" }
  else { Copy-Item (Join-Path $Root ".env.example") $EnvPath; Write-Host "  created .env from .env.example" }
}
if (Test-Path $EnvPath) {
  if (-not $DataDir) {
    $DataDir = if ($env:USERPROFILE -match ' ') { "C:\ReelSmith" } else { Join-Path $env:USERPROFILE "ReelSmith" }
  }
  $studioDefault = Join-Path $DataDir "studio"
  $storageDefault = Join-Path $DataDir "storage"
  # an older checkout keeps its projects in .\storage: keep using it
  $legacy = Join-Path $Root "storage"
  if ((Test-Path $legacy) -and (Get-ChildItem $legacy -Force | Select-Object -First 1)) { $storageDefault = $legacy }

  if (-not $CheckOnly) {
    Set-EnvValue "REELSMITH_DIR" (Fwd $Root) -Force | Out-Null
    $secret = Get-EnvValue "AUTH_SECRET"
    if (-not $secret -or $secret -like "change-me*") {
      $bytes = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
      Set-EnvValue "AUTH_SECRET" ([Convert]::ToBase64String($bytes)) -Force | Out-Null
    }
    Set-EnvValue "REEL_STUDIO_DIR" (Fwd $studioDefault) | Out-Null
    Set-EnvValue "STYLE_DIR" (Fwd (Join-Path $DataDir "style")) | Out-Null
    Set-EnvValue "STORAGE_DIR" (Fwd $storageDefault) | Out-Null
  }
  $Studio = Get-EnvValue "REEL_STUDIO_DIR"; if (-not $Studio) { $Studio = Fwd $studioDefault }
  $StyleDir = Get-EnvValue "STYLE_DIR"; if (-not $StyleDir) { $StyleDir = Fwd (Join-Path $DataDir "style") }
  $Storage = Get-EnvValue "STORAGE_DIR"; if (-not $Storage) { $Storage = Fwd $storageDefault }
  foreach ($d in @($Studio, $StyleDir, $Storage)) {
    if (-not $CheckOnly) { New-Item -ItemType Directory -Force $d | Out-Null }
  }
  $missing = @($Studio, $StyleDir, $Storage) | Where-Object { -not (Test-Path $_) }
  if ($missing) { Result "Folders" "FAIL" ("missing: " + ($missing -join ", ")) }
  else { Result "Folders" "PASS" "workspace $Studio, style $StyleDir, storage $Storage" }
  $spaced = @($Studio, $Storage) | Where-Object { $_ -match ' ' }
  if ($spaced) { Result "Paths without spaces" "WARN" "Claude's Bash permission rules can't match quoted paths: $($spaced -join ', '). Re-run with -DataDir C:\ReelSmith" }
  if ((Get-EnvValue "AUTH_SECRET") -like "change-me*") { Result "AUTH_SECRET" "FAIL" "still the placeholder" }
}

# ------------------------------------------------------------------ 2. Node.js 22+
Step "Node.js 22+"
function Node-Major { if (Have node) { $v = (node --version) -replace '^v', ''; return [int]($v.Split('.')[0]) } return 0 }
if ((Node-Major) -lt 22) { Winget-Install "OpenJS.NodeJS.LTS" | Out-Null }
$nm = Node-Major
if ($nm -ge 22) { Result "Node.js" "PASS" (node --version) }
elseif ($nm -gt 0) { Result "Node.js" "FAIL" "$(node --version) found; 22+ needed (HyperFrames). winget install OpenJS.NodeJS.LTS" }
else { Result "Node.js" "FAIL" "not found. Install Node 22+ from https://nodejs.org (or: winget install OpenJS.NodeJS.LTS), then re-run" }

# ------------------------------------------------------------------ 3. Git
Step "Git"
if (-not (Have git)) { Winget-Install "Git.Git" | Out-Null }
if (Have git) { Result "Git" "PASS" ((git --version) -replace 'git version ', '') }
else { Result "Git" "FAIL" "not found. winget install Git.Git (needed to fetch the video-use skill)" }

# ------------------------------------------------------------------ 4. Python 3.11+
Step "Python 3.11+"
function Find-Python {
  # skip the Microsoft Store alias (WindowsApps\python.exe), which only opens the Store
  foreach ($c in @(Get-Command python, python3 -All -ErrorAction SilentlyContinue | Where-Object { $_.Source -notlike "*WindowsApps*" })) {
    $v = & $c.Source -c "import sys;print('%d.%d' % sys.version_info[:2])" 2>$null
    if ($v -and [version]$v -ge [version]"3.11") { return $c.Source }
  }
  if (Have py) {
    $exe = & py -3 -c "import sys;print(sys.executable)" 2>$null
    $v = & py -3 -c "import sys;print('%d.%d' % sys.version_info[:2])" 2>$null
    if ($exe -and $v -and [version]$v -ge [version]"3.11") { return $exe }
  }
  return $null
}
$SysPython = Find-Python
if (-not $SysPython) { Winget-Install "Python.Python.3.12" | Out-Null; $SysPython = Find-Python }
if ($SysPython) { Result "Python" "PASS" ((& $SysPython --version) + " ($SysPython)") }
else { Result "Python" "FAIL" "3.11+ not found. winget install Python.Python.3.12 (or python.org; tick 'Add to PATH'), then re-run" }

# ------------------------------------------------------------------ 5. ffmpeg (full build)
Step "ffmpeg"
function Find-FFmpegBin {
  $hit = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Gyan.FFmpeg*\*\bin\ffmpeg.exe" -ErrorAction SilentlyContinue | Sort-Object FullName | Select-Object -Last 1
  if ($hit) { return $hit.DirectoryName } return $null
}
if (-not (Have ffmpeg)) {
  $bin = Find-FFmpegBin
  if (-not $bin) { Winget-Install "Gyan.FFmpeg" | Out-Null; $bin = Find-FFmpegBin }
  # winget's Links shim isn't always created: put the package's bin folder on the user PATH
  if ($bin -and -not $CheckOnly) { Add-UserPath $bin }
}
if (Have ffmpeg) {
  $filters = (ffmpeg -hide_banner -filters 2>$null) -join "`n"
  $need = @("vidstabdetect", "libvmaf", "zscale", "subtitles", "loudnorm")
  $lack = $need | Where-Object { $filters -notmatch "\s$_\s" }
  $ver = ((ffmpeg -hide_banner -version 2>$null) | Select-Object -First 1) -replace 'ffmpeg version ', '' -replace ' Copyright.*$', ''
  if ($lack) { Result "ffmpeg" "FAIL" "$ver lacks $($lack -join ', '). Install the gyan.dev FULL build: winget install Gyan.FFmpeg" }
  else { Result "ffmpeg" "PASS" "$ver (vidstab, vmaf, zscale, libass)" }
} else { Result "ffmpeg" "FAIL" "not found. winget install Gyan.FFmpeg, open a new terminal, re-run" }

# ------------------------------------------------------------------ 6. Python venv + deps
Step "Python packages (worker\.venv)"
$Venv = Join-Path $Root "worker\.venv"
$VenvPy = Join-Path $Venv "Scripts\python.exe"
if ($SysPython -and -not (Test-Path $VenvPy) -and -not $CheckOnly) { & $SysPython -m venv $Venv }
if (Test-Path $VenvPy) {
  if (-not $CheckOnly) {
    & $VenvPy -m pip install --disable-pip-version-check -q -U pip | Out-Host
    & $VenvPy -m pip install --disable-pip-version-check -q -r (Join-Path $Root "worker\requirements.txt") | Out-Host
    # video-use helpers (pyproject deps)
    & $VenvPy -m pip install --disable-pip-version-check -q requests librosa matplotlib pillow numpy | Out-Host
    Set-EnvValue "PYTHON_BIN" (Fwd $VenvPy) -Force | Out-Null
  }
  $probe = @(& $VenvPy -c "import faster_whisper, numpy, onnxruntime, yt_dlp, librosa, psycopg, matplotlib, PIL; print('ok')" 2>&1 | ForEach-Object { "$_" })
  if ($probe[-1] -eq "ok") { Result "Python packages" "PASS" "faster-whisper, numpy, onnxruntime, yt-dlp, librosa, psycopg" }
  else { Result "Python packages" "FAIL" ($probe[-1] + " (run setup without -CheckOnly, or: worker\.venv\Scripts\pip install -r worker\requirements.txt)") }
} else { Result "Python packages" "FAIL" "no venv (needs Python 3.11+)" }

# ------------------------------------------------------------------ 7. npm packages
Step "npm packages"
if (Have npm) {
  if (-not $CheckOnly) {
    if (Test-Path (Join-Path $Root "package-lock.json")) { npm ci --no-audit --no-fund | Out-Host } else { npm install --no-audit --no-fund | Out-Host }
  }
  if (Test-Path (Join-Path $Root "node_modules\.prisma\client")) { Result "npm packages" "PASS" "installed, Prisma client generated" }
  else { Result "npm packages" "FAIL" "run: npm ci" }
} else { Result "npm packages" "FAIL" "npm not found (install Node first)" }

# ------------------------------------------------------------------ 8. Claude workspace
Step "Claude workspace (rules.md, CLAUDE.md, tools, skills)"
if ($Studio) {
  $tpl = Join-Path $Root "workspace"
  if (-not $CheckOnly) {
    Get-ChildItem $tpl -Recurse -File -Force | ForEach-Object {
      $rel = $_.FullName.Substring($tpl.Length + 1)
      $dst = Join-Path $Studio $rel
      if ($rel -eq "rules.md" -and (Test-Path $dst)) { return }   # your rules and feedback stay
      New-Item -ItemType Directory -Force (Split-Path $dst) | Out-Null
      $text = [IO.File]::ReadAllText($_.FullName)
      $text = $text.Replace("{{REELSMITH_DIR}}", (Fwd $Root)).Replace("{{REEL_STUDIO_DIR}}", (Fwd $Studio))
      Write-Utf8 $dst $text
    }
    New-Item -ItemType Directory -Force (Join-Path $Studio "tools") | Out-Null
  }
  $req = @("rules.md", "CLAUDE.md", "tools\enhance.py", "tools\transcribe_local.py", ".claude\skills\edit-reel\SKILL.md")
  $gone = $req | Where-Object { -not (Test-Path (Join-Path $Studio $_)) }
  if ($gone) { Result "Workspace files" "FAIL" ("missing in ${Studio}: " + ($gone -join ", ")) }
  else { Result "Workspace files" "PASS" "rules.md, CLAUDE.md, tools, edit-reel skill" }

  # video-use skill (MIT, browser-use): cloned, not vendored; its LICENSE comes with the clone
  $vu = Join-Path $Studio ".claude\skills\video-use"
  if (-not (Test-Path (Join-Path $vu "SKILL.md")) -and (Have git) -and -not $CheckOnly) {
    git clone --quiet $VideoUseRepo $vu
    if (Test-Path $vu) { git -C $vu checkout --quiet $VideoUseCommit 2>$null; if ($LASTEXITCODE -ne 0) { Write-Host "  pinned commit not found; using the latest video-use" -ForegroundColor Yellow } }
  }
  if ((Test-Path (Join-Path $vu "SKILL.md")) -and (Test-Path (Join-Path $vu "LICENSE"))) { Result "video-use skill" "PASS" ("commit " + (git -C $vu rev-parse --short HEAD 2>$null)) }
  else { Result "video-use skill" "FAIL" "git clone $VideoUseRepo `"$vu`"" }
}

# ------------------------------------------------------------------ 9. HyperFrames (video-use animation engine)
Step "HyperFrames"
if ((Node-Major) -ge 22) {
  $hf = (npx --yes hyperframes --version 2>$null | Select-Object -Last 1)
  if ($hf -match '^\d+\.\d+') { Result "HyperFrames" "PASS" "v$hf (cached for npx)" }
  else { Result "HyperFrames" "WARN" "npx hyperframes didn't run; video-use installs it on first use" }
} else { Result "HyperFrames" "FAIL" "needs Node 22+" }

# ------------------------------------------------------------------ 10. Whisper model
Step "Whisper model"
$wm = Get-EnvValue "WHISPER_MODEL"; if (-not $wm) { $wm = "base" }
if (Test-Path $VenvPy) {
  $env:HF_HUB_DISABLE_IMPLICIT_TOKEN = "1"
  $code = "from faster_whisper import WhisperModel; WhisperModel('$wm', device='cpu', compute_type='int8'); print('ok')"
  if ($CheckOnly) { $code = "from faster_whisper.utils import download_model; download_model('$wm', local_files_only=True); print('ok')" }
  $out = @(& $VenvPy -c $code 2>&1 | ForEach-Object { "$_" })
  if ($out[-1] -eq "ok") { Result "Whisper model" "PASS" "'$wm' in the Hugging Face cache" }
  else { Result "Whisper model" "FAIL" ("'$wm' not available (network?): " + $out[-1]) }
} else { Result "Whisper model" "FAIL" "needs the worker venv" }

# ------------------------------------------------------------------ 11. Background-matte model (RobustVideoMatting, GPL-3.0 weights)
Step "Background-matte model"
$rvm = Join-Path $Root "worker\models\rvm_mobilenetv3_fp32.onnx"
if (-not (Test-Path $rvm) -and -not $CheckOnly) {
  New-Item -ItemType Directory -Force (Split-Path $rvm) | Out-Null
  try { Invoke-WebRequest $RvmUrl -OutFile $rvm -UseBasicParsing } catch { Remove-Item $rvm -ErrorAction SilentlyContinue }
}
if ((Test-Path $rvm) -and (Get-Item $rvm).Length -gt 10MB) { Result "Matte model" "PASS" "rvm_mobilenetv3_fp32.onnx" }
else { Result "Matte model" "WARN" "not downloaded; Background > remove won't work. Get $RvmUrl into worker\models\" }

# ------------------------------------------------------------------ 12. Real-ESRGAN (optional AI upscale)
Step "Real-ESRGAN"
if ($Studio) {
  $esDir = Join-Path $Studio "tools\realesrgan"
  $esExe = Join-Path $esDir "realesrgan-ncnn-vulkan.exe"
  if ($SkipUpscaler) { Result "Real-ESRGAN" "SKIP" "-SkipUpscaler" }
  else {
    if (-not (Test-Path $esExe) -and -not $CheckOnly) {
      $zip = Join-Path $env:TEMP "realesrgan-ncnn-vulkan.zip"
      try {
        Invoke-WebRequest $EsrganUrl -OutFile $zip -UseBasicParsing
        $tmp = Join-Path $env:TEMP "realesrgan-unzip"; Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
        Expand-Archive $zip $tmp -Force
        $found = Get-ChildItem $tmp -Recurse -Filter "realesrgan-ncnn-vulkan.exe" | Select-Object -First 1
        New-Item -ItemType Directory -Force $esDir | Out-Null
        Copy-Item (Join-Path $found.DirectoryName "*") $esDir -Recurse -Force
        Remove-Item $zip, $tmp -Recurse -Force -ErrorAction SilentlyContinue
      } catch { Write-Host "  download failed: $_" -ForegroundColor Yellow }
    }
    if ((Test-Path $esExe) -and (Test-Path (Join-Path $esDir "models\realesrgan-x4plus.bin"))) { Result "Real-ESRGAN" "PASS" "binary + x4plus weights in $esDir" }
    else { Result "Real-ESRGAN" "WARN" "not installed; AI upscale is unavailable (everything else works)" }
  }
}

# ------------------------------------------------------------------ 13. PostgreSQL + tables
Step "PostgreSQL"
function Test-Db([string]$Url) {
  if (-not $Url -or -not (Test-Path (Join-Path $Root "node_modules\.bin\prisma.cmd"))) { return $false }
  "SELECT 1;" | npx --no-install prisma db execute --stdin --url $Url 2>&1 | Out-Null
  return ($LASTEXITCODE -eq 0)
}
$dbUrl = Get-EnvValue "DATABASE_URL"
$dbOk = Test-Db $dbUrl
if (-not $dbOk -and -not $CheckOnly -and (Have docker)) {
  docker info 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) {
    Write-Host "  no database at DATABASE_URL; starting the Docker one (docker compose up -d db, port 5433)..."
    docker compose up -d db | Out-Host
    $dockerUrl = "postgresql://reelsmith:reelsmith@localhost:5433/reelsmith"
    for ($i = 0; $i -lt 15 -and -not $dbOk; $i++) { Start-Sleep -Seconds 2; $dbOk = Test-Db $dockerUrl }
    if ($dbOk) { Set-EnvValue "DATABASE_URL" $dockerUrl -Force | Out-Null; $dbUrl = $dockerUrl }
  }
}
if ($dbOk) {
  Result "PostgreSQL connection" "PASS" ($dbUrl -replace '://([^:]+):[^@]*@', '://$1:***@')
  if (-not $CheckOnly) { npx --no-install prisma db push --skip-generate | Out-Host }
  if ($LASTEXITCODE -eq 0 -or $CheckOnly) { Result "Database tables" "PASS" "prisma db push" }
  else { Result "Database tables" "FAIL" "prisma db push failed (see above). If it warns about data loss, back up and run: npx prisma db push" }
} else {
  Result "PostgreSQL connection" "FAIL" "can't connect with DATABASE_URL in .env. Install PostgreSQL (winget install PostgreSQL.PostgreSQL.17), then run scripts\setup-local-db.ps1 as Administrator, or use Docker Desktop, then re-run setup"
  Result "Database tables" "SKIP" "needs the database"
}

# ------------------------------------------------------------------ 14. Claude Code (subscription login)
Step "Claude Code"
$claude = $null
if (Have claude) { $claude = (Get-Command claude).Source }
elseif (Test-Path "$env:USERPROFILE\.local\bin\claude.exe") { $claude = "$env:USERPROFILE\.local\bin\claude.exe" }
if (-not $claude) {
  Result "Claude Code installed" "FAIL" "not found. Install: open PowerShell and run  irm https://claude.ai/install.ps1 | iex  (or: npm install -g @anthropic-ai/claude-code), then re-run setup"
  Result "Claude Code login" "SKIP" "install Claude Code first"
} else {
  Result "Claude Code installed" "PASS" ((& $claude --version 2>$null) + " ($claude)")
  # check the login the way the runner does: without API-key variables, which it strips
  $saved = @{}; foreach ($k in "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN") { $saved[$k] = [Environment]::GetEnvironmentVariable($k); Remove-Item "env:$k" -ErrorAction SilentlyContinue }
  $raw = (& $claude auth status 2>$null) -join "`n"
  foreach ($k in $saved.Keys) { if ($saved[$k]) { Set-Item "env:$k" $saved[$k] } }
  $auth = $null; try { $auth = $raw | ConvertFrom-Json } catch {}
  $how = "Open a terminal, run  claude , type  /login  and choose 'Claude account with subscription' (Pro or Max). Then re-run setup."
  if (-not $auth -or -not $auth.loggedIn) { Result "Claude Code login" "FAIL" "not logged in. $how" }
  elseif ($auth.authMethod -ne "claude.ai") { Result "Claude Code login" "FAIL" "logged in with '$($auth.authMethod)', not a Claude subscription (API billing). Run  claude auth logout , then: $how" }
  else { Result "Claude Code login" "PASS" "Claude subscription ($($auth.subscriptionType))" }
  $keySet = @("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN") | Where-Object {
    [Environment]::GetEnvironmentVariable($_, "User") -or [Environment]::GetEnvironmentVariable($_, "Machine") -or (Get-EnvValue $_)
  }
  if ($keySet) { Result "No API key set" "WARN" "$($keySet -join ', ') is set (Windows env or .env). ReelSmith strips it for its runs, but remove it so nothing bills the API" }
  else { Result "No API key set" "PASS" "runs use the subscription" }
}

# ------------------------------------------------------------------ checklist
Write-Host "`n================ ReelSmith setup checklist ================" -ForegroundColor White
foreach ($r in $Results) {
  $color = @{ PASS = "Green"; WARN = "Yellow"; FAIL = "Red"; SKIP = "DarkGray" }[$r.Status]
  Write-Host ("[{0}] {1}" -f $r.Status, $r.Check.PadRight(24)) -ForegroundColor $color -NoNewline
  Write-Host (" " + $r.Detail)
}
$fail = @($Results | Where-Object Status -eq "FAIL").Count
$warn = @($Results | Where-Object Status -eq "WARN").Count
$pass = @($Results | Where-Object Status -eq "PASS").Count
Write-Host ("`n{0} passed, {1} warnings, {2} failed" -f $pass, $warn, $fail)
if ($fail -eq 0) {
  Write-Host "Ready. Start ReelSmith with start.bat (or see README > First run)." -ForegroundColor Green
} else {
  Write-Host "Fix the FAIL items above, then run setup.bat again. Full log: logs\setup.log" -ForegroundColor Red
}
try { Stop-Transcript | Out-Null } catch {}
exit ([int]($fail -gt 0))
