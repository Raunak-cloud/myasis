Chrome maintenance
==================

`bash deploy/install-chrome-update.sh /home/myasis/myasis` installs a root-owned
systemd service and hourly timer. Normal application deployments refresh it.

The updater shares the application deployment lock. It skips active application
workers, sign-in checks and Chrome processes, including private VPS browsers.
It then holds new starts through the existing `.deploying` maintenance flag,
rechecks for races and downloads the exact newer Google stable package.

Before installation it extracts the package and runs the production Patchright
library against a disposable profile. The check covers persistent cookies across
restart, filling, clicking, uploads and screenshots, with page networking limited
to an intercepted synthetic fixture. It never uses customer credentials.

All existing per-user Chrome profiles are backed up under
`/var/backups/myasis/chrome` (directory 0700, archives 0600). Archives include
Local State, cookies, passwords, local storage and other profile data, excluding
rebuildable caches and process locks. The updater reads every archive entry and
checks essential session files before installing anything. It checks available
disk space and retains two completed pre-update backups after success. These
are local backups; they are not uploaded by the ordinary nightly backup job.
Lock files left by a crashed browser on this same machine are excluded from
archives and left untouched. A live owner, foreign hostname or unknown lock
format defers maintenance.

The normal OS account, keyring and profile paths stay unchanged. A browser is
never killed to make the update happen. Websites may independently expire logins;
the updater cannot extend their sessions. Chrome applies the new binary on the
next launch, after the old browsers have finished naturally.

Inspect:

    systemctl status owtomate-chrome-update.timer
    journalctl -u owtomate-chrome-update.service
    python3 /usr/local/lib/owtomate/chrome-update.py --check

If candidate tests or backup fail, no package is installed and new starts resume.
If installation starts but installed-browser validation fails or is interrupted,
the maintenance flag stays `chrome-update-needs-inspection`. Do not delete it
until an operator has checked `dpkg --audit`, the Chrome version, the journal and
the isolated smoke test. No profile rollback or Chrome downgrade happens
automatically. Backups must be restored only with the account's browsers closed;
restore to the same OS user and keep the original OS keyring intact.

Tests (Linux):

    python3 -m unittest discover -s deploy -p test_chrome_update.py -v
    sudo -u myasis -H node deploy/chrome-session-smoke.mjs "$PWD" /usr/bin/google-chrome-stable
