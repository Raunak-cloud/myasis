# Keeps the tunnel running whenever this computer is on and you are signed in. Run once, as yourself.
# To remove: Unregister-ScheduledTask -TaskName 'Owtomate home route' -Confirm:$false
#
# Builds home-route.exe from HomeRoute.cs with the C# compiler that ships with
# Windows (see that file for why this is a program and not a script), then asks
# Task Scheduler to start it at sign-in and to re-ask every minute for good.
# Re-asking is free while the tunnel is up — the program allows one copy of
# itself — and is a restart within a minute when it is not, whatever stopped it.
param([string]$Server = '195.114.15.103', [int]$Port = 1080)

$exe = Join-Path $PSScriptRoot 'home-route.exe'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $compiler /nologo /target:winexe "/out:$exe" (Join-Path $PSScriptRoot 'HomeRoute.cs')
if (-not (Test-Path $exe)) { throw 'home-route.exe could not be built.' }

$user = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute $exe -Argument "$Server $Port"
$atSignIn = New-ScheduledTaskTrigger -AtLogOn -User $user
$everyMinute = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'Owtomate home route' -Action $action -Trigger @($atSignIn, $everyMinute) -Settings $settings `
  -Description 'Keeps the Owtomate home-route tunnel open while this computer is on.' -Force | Out-Null
Start-ScheduledTask -TaskName 'Owtomate home route'
Write-Output 'Installed and started.'
