<#
    Runs a ADO Hygiene Sweep sweep.

    Enforces the working-days rule that Task Scheduler cannot express, then
    invokes the Node CLI and records the outcome to a rolling log.
#>

[CmdletBinding()]
param(
    [switch]$Send,
    [switch]$IgnoreWorkingDays,
    [string]$Fixture
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$log  = Join-Path $root 'out\run.log'

function Write-Log([string]$msg) {
    $line = "[{0:yyyy-MM-dd HH:mm:ss}] {1}" -f (Get-Date), $msg
    Write-Host $line
    New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
    Add-Content -Path $log -Value $line -Encoding UTF8
}

# Task Scheduler can do "every N days" but it cannot skip weekends, so the
# working-days rule is enforced here instead.
$today = (Get-Date).DayOfWeek
if (-not $IgnoreWorkingDays -and ($today -eq 'Saturday' -or $today -eq 'Sunday')) {
    Write-Log "Skipped - $today is not a working day."
    exit 0
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
    Write-Log 'FAILED - node is not on PATH.'
    exit 1
}

$argv = @('"' + (Join-Path $root 'src\index.js') + '"')
if ($Fixture) { $argv += @('--fixture', ('"' + $Fixture + '"')) }
if ($Send)    { $argv += '--send' }

Write-Log "Starting sweep$(if ($Send) { ' (SEND)' } else { ' (dry run)' })"

Push-Location $root
try {
    # Node writes progress to stderr. Merging streams in PowerShell turns those
    # into ErrorRecords that look like failures, so capture them to files and
    # judge success on the exit code alone.
    $outFile = Join-Path $env:TEMP "ado-hygiene-skill-out-$PID.txt"
    $errFile = Join-Path $env:TEMP "ado-hygiene-skill-err-$PID.txt"

    $proc = Start-Process -FilePath $node -ArgumentList $argv `
        -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput $outFile `
        -RedirectStandardError  $errFile
    $code = $proc.ExitCode

    foreach ($f in @($errFile, $outFile)) {
        if (Test-Path $f) {
            Get-Content $f -Encoding UTF8 | Where-Object { $_.Trim() } | ForEach-Object { Write-Log $_ }
            Remove-Item $f -Force -ErrorAction SilentlyContinue
        }
    }
} catch {
    Write-Log "ERROR: $($_.Exception.Message)"
    $code = 1
} finally {
    Pop-Location
}

if ($code -eq 0) {
    Write-Log 'Sweep completed.'
} else {
    Write-Log "Sweep FAILED with exit code $code - no messages were sent."
}

exit $code
