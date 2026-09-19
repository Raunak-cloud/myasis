# Starts the tunnel at sign-in and keeps it running, hidden. Run once, as yourself.
# To remove: Unregister-ScheduledTask -TaskName 'Owtomate home route' -Confirm:$false
$script = Join-Path $PSScriptRoot 'home-route.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'Owtomate home route' -Action $action -Trigger $trigger -Settings $settings -Description 'Keeps the Owtomate home-route tunnel open while this computer is on.' -Force | Out-Null
Start-ScheduledTask -TaskName 'Owtomate home route'
Write-Output 'Installed and started.'
