<#
  start-gateway.ps1 - Launch the TDAI memory Gateway as an INDEPENDENT,
  permanent process that is NOT bound to any Claude Code session (Windows).

  WHY: the plugin's built-in spawn passes TDAI_CC_PID to the gateway, which
  arms a watchdog (gateway/cli.mjs) that self-exits ~15s after that pid dies.
  When a Claude Code hook spawns it from an ephemeral shell, the "parent" dies
  almost immediately and the gateway suicides. On Windows the spawn also goes
  through cmd.exe -> npx, so the tracked pid is a transient wrapper. This script
  runs the gateway directly with node, WITHOUT TDAI_CC_PID, so there is no
  watchdog and the process stays up until you stop it (stop-gateway.ps1) or
  reboot. The patched hooks (state.json ccPid=0) then just connect to it.

  SECRETS: provider API keys (e.g. OPENAI_API_KEY for embeddings) are loaded
  from a local, gitignored "gateway.secrets.env" next to this script and
  injected into the child process environment. This removes the dependency on
  fragile Windows User-env inheritance: a key set via `setx` AFTER a session or
  Task Scheduler context started does NOT reach an already-running process, so
  the gateway would otherwise initialise the embedding provider as disabled and
  semantic search would silently fall back to keyword. Copy
  gateway.secrets.env.example to gateway.secrets.env and fill in your keys.

  LIFECYCLE (2026-10-03):
  - One launcher at a time: a named mutex (Global\TdaiGatewayStart) wraps the
    check-and-launch, so the scheduled task, the SessionStart health hook and a
    manual run cannot start two gateways.
  - The gateway binds its port BEFORE its (slow) boot and answers 503
    {"status":"starting"} until ready, so 200 and 503 both mean "alive".
  - Cold start waits up to 180 s. If the process is still alive after that it is
    NOT a failure: state.json is written with its PID and the script exits 0
    with a warning.
  - state.json is written atomically (tmp + Move-Item) and repaired whenever the
    port owner is "node ... cli.mjs", whatever /health says.
  - Logs rotate per start (gateway.out.<yyyyMMdd-HHmmss>.log / gateway.err.*),
    newest 10 of each kept. Failures are appended to <DataDir>\watchdog.log.

  ASCII-ONLY: this file intentionally avoids non-ASCII characters (e.g. em
  dashes). Windows PowerShell 5.1 reads BOM-less scripts as the system ANSI
  codepage; a UTF-8 em dash misdecodes into a stray quote and breaks parsing.

  Idempotent: if a gateway already answers on the port, it exits 0.
#>
[CmdletBinding()]
param(
  [int]$Port    = 8421,
  [string]$DataDir = (Join-Path $env:USERPROFILE '.claude\plugins\data\tdai-memory-tdai-local'),
  # Gateway entry point. Default resolves to the built dist of this repo
  # (<repo>\dist\src\gateway\cli.mjs); override for a global/npm install.
  # Blank = resolved in the body: Windows PowerShell 5.1 leaves $PSScriptRoot
  # empty inside param() defaults, so Join-Path there throws before any code runs.
  [string]$GatewayCli = '',
  # node.exe; leave blank to resolve from PATH.
  [string]$NodeExe = ''
)

$ErrorActionPreference = 'Stop'

$ColdStartWaitSec = 180
$MutexName        = 'Global\TdaiGatewayStart'
$LogsToKeep       = 10

# Append one line to <DataDir>\watchdog.log. Never throws.
function Write-WatchdogLog {
  param([string]$DataDir, [string]$Message)
  try {
    New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
    $line = '{0} start-gateway.ps1 {1}' -f (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ'), $Message
    Add-Content -Path (Join-Path $DataDir 'watchdog.log') -Value $line -Encoding ascii
  } catch { }
}

# 200 (ok) and 503 (degraded OR "starting") both prove a gateway is answering.
function Test-GatewayHealth {
  param([int]$Port, [string]$Token)
  try {
    $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" `
      -Headers @{ Authorization = "Bearer $Token" } -TimeoutSec 3 -UseBasicParsing
    return ($resp.StatusCode -eq 200 -or $resp.StatusCode -eq 503)
  } catch {
    $r = $_.Exception.Response
    if ($r -and ([int]$r.StatusCode -eq 503)) { return $true }
    return $false
  }
}

# The process listening on the port, and whether it is "node ... cli.mjs".
function Get-PortOwner {
  param([int]$Port)
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
          Select-Object -First 1
  if (-not $conn) { return $null }
  $ownerPid = [int]$conn.OwningProcess
  $cmdline = (Get-CimInstance Win32_Process -Filter "ProcessId=$ownerPid" -ErrorAction SilentlyContinue).CommandLine
  return [pscustomobject]@{
    Pid       = $ownerPid
    IsGateway = [bool]($cmdline -and ($cmdline -match 'node' ) -and ($cmdline -match 'cli\.mjs'))
  }
}

# state.json is written atomically: a reader (hook, installer) never sees a
# truncated file. NB (2026-10-03): a plain Set-Content could leave 0 bytes.
function Write-StateFile {
  param([string]$StatePath, [int]$GatewayPid, [int]$Port, [string]$TokenPath)
  $state = [ordered]@{
    pid       = $GatewayPid
    port      = $Port
    ccPid     = 0
    startedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    tokenPath = $TokenPath
  }
  $tmp = "$StatePath.tmp"
  ($state | ConvertTo-Json) | Set-Content -Path $tmp -Encoding ascii
  Move-Item -Path $tmp -Destination $StatePath -Force
}

# Rebuild state.json when it is missing/invalid or names a pid that is not the
# actual listener. NB (2026-08-23): this path once skipped state.json entirely;
# a missing/0-byte file made the plugin find no daemon and elect a *.BACKUP-*
# data dir. NB (2026-10-03): a pid that is merely > 0 is not enough - after a
# restart state.json kept a DEAD pid while another listened, and a reused pid in
# a BACKUP state.json would win the plugin's election. The recorded pid must be
# the actual listener. Returns $true when it rewrote the file.
function Repair-StateFile {
  param([string]$StatePath, [int]$OwnerPid, [int]$Port, [string]$TokenPath)
  $ok = $false
  if (Test-Path $StatePath) {
    try {
      $existing = (Get-Content -Raw -Path $StatePath) | ConvertFrom-Json
      if ($existing -and $existing.pid -gt 0 -and $existing.port -eq $Port -and $existing.pid -eq $OwnerPid) { $ok = $true }
    } catch { $ok = $false }
  }
  if ($ok) { return $false }
  Write-StateFile -StatePath $StatePath -GatewayPid $OwnerPid -Port $Port -TokenPath $TokenPath
  Write-Host "state.json was missing/invalid - rebuilt for PID $OwnerPid." -ForegroundColor Yellow
  return $true
}

# Keep the newest $Keep files of one rotated-log family (gateway.out.* / gateway.err.*).
function Remove-OldLogs {
  param([string]$DataDir, [string]$Stream, [int]$Keep)
  $pattern = '^gateway\.' + $Stream + '\.\d{8}-\d{6}\.log$'
  Get-ChildItem -Path $DataDir -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match $pattern } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -Skip $Keep |
    ForEach-Object { Remove-Item -Path $_.FullName -Force -ErrorAction SilentlyContinue }
}

# Inject KEY=VALUE pairs from gateway.secrets.env into THIS process's env so the
# spawned gateway inherits them deterministically (see header). NEVER committed.
function Import-GatewaySecrets {
  $secretsPath = Join-Path $PSScriptRoot 'gateway.secrets.env'
  if (-not (Test-Path $secretsPath)) {
    Write-Host "WARN: no gateway.secrets.env at $secretsPath - relying on inherited env. OPENAI_API_KEY may be unset, which disables embeddings (semantic search falls back to keyword)." -ForegroundColor Yellow
    return
  }
  foreach ($line in (Get-Content -Path $secretsPath)) {
    $t = $line.Trim()
    if ($t -eq '' -or $t.StartsWith('#')) { continue }
    $eq = $t.IndexOf('=')
    if ($eq -lt 1) { continue }
    $name = $t.Substring(0, $eq).Trim()
    $val  = $t.Substring($eq + 1).Trim()
    if ($val.Length -ge 2 -and
        (($val[0] -eq '"' -and $val[$val.Length - 1] -eq '"') -or
         ($val[0] -eq "'" -and $val[$val.Length - 1] -eq "'"))) {
      $val = $val.Substring(1, $val.Length - 2)
    }
    Set-Item -Path ("Env:" + $name) -Value $val
  }
  Write-Host "Loaded gateway secrets from $secretsPath into the child environment."
}

# The check-and-launch body. Runs under the named mutex. Returns the exit code.
function Invoke-GatewayLaunch {
  # --- Resolve binaries ---
  if ([string]::IsNullOrWhiteSpace($NodeExe) -or -not (Test-Path $NodeExe)) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { $script:NodeExe = $cmd.Source } else { throw "node.exe not found (set -NodeExe)" }
  }
  # An installed copy (e.g. %USERPROFILE%\tdai-gateway) sits outside the repo, so the
  # repo-relative default does not exist there: fall back to $env:TDAI_GATEWAY_CLI,
  # then to a one-line gateway.cli.txt next to this script holding the cli.mjs path.
  if ([string]::IsNullOrWhiteSpace($GatewayCli)) {
    $script:GatewayCli = Join-Path $PSScriptRoot '..\..\dist\src\gateway\cli.mjs'
  }
  if (-not (Test-Path $GatewayCli)) {
    $pathFile = Join-Path $PSScriptRoot 'gateway.cli.txt'
    if (-not [string]::IsNullOrWhiteSpace($env:TDAI_GATEWAY_CLI)) {
      $script:GatewayCli = $env:TDAI_GATEWAY_CLI
    } elseif (Test-Path $pathFile) {
      $script:GatewayCli = (Get-Content -Path $pathFile -TotalCount 1).Trim()
    }
  }
  if (-not (Test-Path $GatewayCli)) { throw "Gateway entry not found: $GatewayCli (build the repo, set -GatewayCli, TDAI_GATEWAY_CLI or gateway.cli.txt)" }
  $cli = (Resolve-Path $GatewayCli).Path

  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  $tokenPath = Join-Path $DataDir 'token'
  $statePath = Join-Path $DataDir 'state.json'

  # --- Token: reuse the existing one (hooks read the same file), else mint a
  #     32-byte base64url token to match daemon.ts generateToken(). ---
  $token = $null
  if (Test-Path $tokenPath) { $token = (Get-Content -Raw -Path $tokenPath).Trim() }
  if ([string]::IsNullOrWhiteSpace($token)) {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $token = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
    Set-Content -Path $tokenPath -Value $token -NoNewline -Encoding ascii
  }

  # --- Is a gateway already there? Repair state.json whenever the port owner is
  #     "node ... cli.mjs", whatever /health says (a booting or degraded gateway
  #     still owns the port and must still be registered). ---
  $owner = Get-PortOwner -Port $Port
  if ($owner -and $owner.IsGateway) {
    Repair-StateFile -StatePath $statePath -OwnerPid $owner.Pid -Port $Port -TokenPath $tokenPath | Out-Null
    if (Test-GatewayHealth -Port $Port -Token $token) {
      Write-Host "Gateway already running on http://127.0.0.1:$Port (PID $($owner.Pid))." -ForegroundColor Green
    } else {
      Write-Host "WARN: gateway PID $($owner.Pid) owns port $Port but /health did not answer; leaving it alone." -ForegroundColor Yellow
      Write-WatchdogLog -DataDir $DataDir -Message "gateway PID $($owner.Pid) owns port $Port but /health did not answer; not restarted"
    }
    return 0
  }

  # --- Port held by something that is NOT our gateway? Do not fight it. ---
  if ($owner) {
    throw "Port $Port is in use (PID $($owner.Pid)) by something that is not the gateway. Investigate before starting."
  }

  # --- Child environment ---
  # CRITICAL: do NOT set TDAI_CC_PID - leaving it unset disables the parent
  # watchdog so the gateway is permanent.
  $env:TDAI_GATEWAY_PORT = "$Port"
  $env:TDAI_TOKEN_PATH   = $tokenPath
  $env:TDAI_DATA_DIR     = $DataDir
  Remove-Item Env:\TDAI_CC_PID -ErrorAction SilentlyContinue
  Import-GatewaySecrets

  # --- Rotated logs: one pair per start, newest $LogsToKeep of each kept. ---
  $stamp  = (Get-Date).ToString('yyyyMMdd-HHmmss')
  $outLog = Join-Path $DataDir "gateway.out.$stamp.log"
  $errLog = Join-Path $DataDir "gateway.err.$stamp.log"
  Remove-OldLogs -DataDir $DataDir -Stream 'out' -Keep ($LogsToKeep - 1)
  Remove-OldLogs -DataDir $DataDir -Stream 'err' -Keep ($LogsToKeep - 1)

  # Start-Process launches a process that is independent of this shell: it keeps
  # running after PowerShell / the terminal exits.
  $proc = Start-Process -FilePath $NodeExe -ArgumentList @($cli) `
    -WorkingDirectory $DataDir -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $outLog -RedirectStandardError $errLog

  Write-Host "Launched gateway: PID $($proc.Id). Waiting for /health ..."

  # --- Health poll (cold start loads the store + vectors; the gateway answers
  #     503 "starting" meanwhile, which Test-GatewayHealth accepts). ---
  $deadline = (Get-Date).AddSeconds($ColdStartWaitSec)
  $healthy = $false
  while ((Get-Date) -lt $deadline) {
    if ($proc.HasExited) { break }
    if (Test-GatewayHealth -Port $Port -Token $token) { $healthy = $true; break }
    Start-Sleep -Milliseconds 400
  }

  if ($proc.HasExited) {
    # Exit code 0 = the new process found another live gateway owning the data
    # dir (gateway.lock) and stepped aside. That gateway is the real one.
    if ($proc.ExitCode -eq 0) {
      $live = Get-PortOwner -Port $Port
      if ($live -and $live.IsGateway) {
        Repair-StateFile -StatePath $statePath -OwnerPid $live.Pid -Port $Port -TokenPath $tokenPath | Out-Null
        Write-Host "Another gateway (PID $($live.Pid)) already owns the data dir; the new process exited cleanly." -ForegroundColor Yellow
        return 0
      }
    }
    throw "Gateway exited early (code $($proc.ExitCode)). See $errLog"
  }

  # Register state.json with ccPid=0 (externally-managed sentinel) so the
  # patched hooks reuse this gateway for every session and never spawn.
  Write-StateFile -StatePath $statePath -GatewayPid $proc.Id -Port $Port -TokenPath $tokenPath

  if ($healthy) {
    Write-Host "Gateway answering on http://127.0.0.1:$Port (PID $($proc.Id))." -ForegroundColor Green
  } else {
    # Alive but not answering after the cold-start wait: NOT a failure. It keeps
    # booting; state.json already points at it. A false FALLITO here made the
    # health hook and the watchdog believe the gateway was dead.
    $msg = "gateway PID $($proc.Id) alive but /health silent after ${ColdStartWaitSec}s; registered in state.json, still booting. See $errLog"
    Write-Host "WARN: $msg" -ForegroundColor Yellow
    Write-WatchdogLog -DataDir $DataDir -Message $msg
  }
  Write-Host "state.json written with ccPid=0 (independent). Stays up until stop-gateway.ps1 or reboot."
  return 0
}

# --- One launcher at a time ---
$mutex = New-Object System.Threading.Mutex($false, $MutexName)
$haveMutex = $false
$exitCode = 1
try {
  try {
    $haveMutex = $mutex.WaitOne([TimeSpan]::FromSeconds($ColdStartWaitSec + 20))
  } catch [System.Threading.AbandonedMutexException] {
    # A previous launcher died holding it; we own it now.
    $haveMutex = $true
  }
  if (-not $haveMutex) { throw "Another start-gateway.ps1 held the launch mutex for more than $($ColdStartWaitSec + 20)s." }
  $exitCode = Invoke-GatewayLaunch
} catch {
  $msg = $_.Exception.Message
  Write-Host "FAILED: $msg" -ForegroundColor Red
  Write-WatchdogLog -DataDir $DataDir -Message "FAILED: $msg"
  $exitCode = 1
} finally {
  if ($haveMutex) { try { $mutex.ReleaseMutex() } catch { } }
  $mutex.Dispose()
}
exit $exitCode
