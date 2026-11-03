# Temporary maintenance, 3 November 2026

The public Caddy entrance uses `maintenance-gate.mjs` through `forward_auth`.
Normal and anonymous requests receive a non-cached HTTP 503 notice promising
6 PM AEDT. Only a valid administrator session passes the existing application's
read-only administrator endpoint. OAuth sign-in and payment callbacks keep
their normal validation. No account schedules or application workers change.

Installed service: `owtomate-maintenance-gate.service`, user `myasis`, loopback
port **5197** via `MAINTENANCE_GATE_PORT`. Source is frozen at
`/opt/owtomate-maintenance-20261103/gate.mjs`. The original Caddy configuration
is `/etc/caddy/Caddyfile.before-maintenance-20261103`, SHA-256
`c401418e38f6240e56280d4bdfb6493a4c99bcae42252a6da22558daedc339dc`.
The activated configuration SHA-256 is
`19906a6b2ec7bad4855a80e5e9c79a5ec028808b3f7268daa131e6542aa6ffee`.

Verification is in production `output/site-maintenance-20261103-proof.json`:
anonymous, normal user, normal API, forged cookie, and uncached asset responses
are 503; valid admin page/API are 200; sign-in remains 302. Expired admin sessions
were separately checked against the gate and denied. Temporary test sessions
were deleted in `finally` blocks.

The notice does not automatically reopen the site. On an authorized reopening,
first compare the active Caddy configuration with the recorded activated hash.
If unchanged, validate and restore the original configuration and reload Caddy.
If another operator edited it, remove only the maintenance gate and restore
the two cache headers while preserving their changes. Verify public and admin
access before disabling the maintenance service. No dashboard restart is needed.

Approval comparison changes remain deferred.
