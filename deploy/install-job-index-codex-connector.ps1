$ErrorActionPreference = 'Stop'
$connectorRoot = Join-Path $env:LOCALAPPDATA 'Owtomate\JobDiscovery'
New-Item -ItemType Directory -Path $connectorRoot -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'job-index-codex-connector.mjs') -Destination (Join-Path $connectorRoot 'connector.mjs') -Force
$nodePath = (Get-Command node -ErrorAction Stop).Source
$codexPath = (Get-Command codex -ErrorAction Stop).Source
$launcher = @'
$ErrorActionPreference = 'Stop'
$cmd = Get-Command codex -ErrorAction SilentlyContinue
$env:JOB_INDEX_CODEX_BIN = if ($cmd) { $cmd.Source } else { '__CODEX__' }
& '__NODE__' '__CONNECTOR__' 1>> '__OUT__' 2>> '__ERR__'
'@
$launcher = $launcher.Replace('__CODEX__', $codexPath.Replace("'", "''")).Replace('__NODE__', $nodePath.Replace("'", "''")).Replace('__CONNECTOR__', (Join-Path $connectorRoot 'connector.mjs').Replace("'", "''")).Replace('__OUT__', (Join-Path $connectorRoot 'connector.log').Replace("'", "''")).Replace('__ERR__', (Join-Path $connectorRoot 'connector-errors.log').Replace("'", "''"))
$launcherPath = Join-Path $connectorRoot 'start.ps1'
Set-Content -LiteralPath $launcherPath -Value $launcher -Encoding UTF8
$taskName = 'OwtomateJobDiscoveryConnector'
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) { Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue }
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File `"$launcherPath`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description 'Connects manual admin job-search requests to signed-in Codex; never schedules searches.' -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Output 'Codex job-discovery connector installed and started. Searches require an admin click.'
