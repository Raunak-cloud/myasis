# Home route

Lets one account's browsers go out from the person's own home internet
connection instead of this server's data-centre address — while their computer
is on. When it is off, the account applies from the server as before.

```
home computer ── ssh -R (outbound, reconnecting) ──▶ server 127.0.0.1:<port>   SOCKS tunnel
account's Chrome ──▶ 127.0.0.1:<switch>  (dashboard/server/route.ts)
                         ├─ tunnel up   ──▶ out through the home connection
                         └─ tunnel down ──▶ out from the server
```

Chrome is never pointed at the tunnel itself, because Chrome cannot change
proxy once started and a run must not die when a laptop lid closes. It talks to
the dashboard's route switch, which moves to the server the moment the tunnel
stops answering and moves back to the home address only once that account's
browsers have closed — so a run finishes on the address it started on.

Runs, sign-in checks and the sign-in window all use the same route. The
dashboard shows the route in use under **Connection** in the menu, and a run's
console says `Applying from: …` when it starts.

## Set up

1. On the home computer (Windows 10/11, OpenSSH is built in), make a key that
   can do nothing but hold this tunnel:

       ssh-keygen -t ed25519 -N "" -f $env:USERPROFILE\.ssh\owtomate_home_route

2. On the server, as root, allow that key to listen on one loopback port:

       bash deploy/home-route/setup-server.sh 1080 "<contents of owtomate_home_route.pub>"

   The key gets no shell, no commands and no other forwarding — see the script.
   A second home machine takes its own port (1081, …) and its own key.

3. On the home computer, start the tunnel at sign-in and keep it up:

       powershell -ExecutionPolicy Bypass -File deploy\home-route\install-windows.ps1

   It builds `home-route.exe` from `HomeRoute.cs` with the compiler that ships
   with Windows, and registers a task that starts it at sign-in and re-asks
   every minute. It is a windowless program on purpose: a console script doing
   this job was closed along with other console windows within seconds on a
   developer's desktop. Its log is `%LOCALAPPDATA%owtomate-home-route.log`.

4. In the dashboard: Admin → Users → the account → Limits → **Home route port**
   = the port from step 2.

The port is always on 127.0.0.1 and is set by an operator, never by the
account: a setting that took a host name would let whoever sets it aim this
server's Chrome at any machine the server can reach.

## Check

    curl --socks5-hostname 127.0.0.1:1080 https://api.ipify.org   # on the server: prints the home address

`npx tsx server/route.test.ts` in `dashboard/` drives the switch through a
tunnel dropping under an open browser and coming back.
