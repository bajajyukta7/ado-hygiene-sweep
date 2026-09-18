<#
    Registers ADO Hygiene Sweep as a scheduled task.

    Default cadence: every 3 days at 09:00, working days only.
    The working-days filter is enforced by run.ps1 rather than the trigger,
    because Task Scheduler cannot express "every N days, but skip weekends".
#>

[CmdletBinding()]
param(
    [string]$TaskName   = 'ADO Hygiene Sweep',
    [string]$Time       = '09:00',
    [int]   $EveryNDays = 3,
    [switch]$Send
)

$ErrorActionPreference = 'Stop'

$root   = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $PSScriptRoot 'run.ps1'

if (-not (Test-Path $runner)) { throw "Runner not found at $runner" }

$argList = "-NoProfile -ExecutionPolicy Bypass -File `"$runner`""
if ($Send) { $argList += ' -Send' }

$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument $argList `
    -WorkingDirectory $root

$trigger = New-ScheduledTaskTrigger -Daily -DaysInterval $EveryNDays -At $Time

$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -DontStopOnIdleEnd `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

Register-ScheduledTask `
    -TaskName    $TaskName `
    -Action      $action `
    -Trigger     $trigger `
    -Settings    $settings `
    -Description 'Scans Azure DevOps for work-item hygiene gaps and routes them to owners on Teams.' `
    -Force | Out-Null

Write-Host "Registered '$TaskName'"
Write-Host "  cadence : every $EveryNDays day(s) at $Time"
Write-Host "  mode    : $(if ($Send) { 'SEND - messages will be delivered' } else { 'DRY RUN - drafts only' })"
Write-Host ""
Write-Host "Run now    :  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "Remove     :  Unregister-ScheduledTask -TaskName '$TaskName'"
