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
# Use the current user's Windows startup entry; it needs no stored password or
# elevated service account. Starting the connector does not start a job search.
$taskName = 'OwtomateJobDiscoveryConnector'
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) { Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
$powerShellPath = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
$startupArgs = "-NoProfile -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File `"$launcherPath`""
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
New-ItemProperty -Path $runKey -Name $taskName -PropertyType String -Value "`"$powerShellPath`" $startupArgs" -Force | Out-Null
$running = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like "*$(Join-Path $connectorRoot 'connector.mjs')*" }
if (-not $running) { Start-Process -FilePath $powerShellPath -ArgumentList $startupArgs -WorkingDirectory $connectorRoot -WindowStyle Hidden }
Write-Output 'Codex job-discovery connector installed and started. Searches require an admin click.'
