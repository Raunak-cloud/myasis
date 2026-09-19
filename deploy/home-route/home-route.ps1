# Holds this computer's tunnel to the server open, and reopens it whenever it drops.
# While it is up, the account's applications go out from this computer's internet
# connection; when this computer is off or asleep they go out from the server.
param(
  [string]$Server = '195.114.15.103',
  [int]$Port = 1080,
  [string]$Key = "$env:USERPROFILE\.ssh\owtomate_home_route"
)
while ($true) {
  # -R with a port and no destination makes this end the SOCKS exit. The keep-alives
  # notice a dead link within a minute and a half, so the loop can redial.
  & ssh.exe -N -T -i $Key `
    -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new `
    -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 `
    -R "127.0.0.1:$Port" "homeroute@$Server"
  Start-Sleep -Seconds 10
}
