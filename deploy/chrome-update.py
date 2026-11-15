#!/usr/bin/env python3
"""Idle-only Chrome package updates. Profiles and their OS/keyring identity stay in place."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import signal
import subprocess
import tarfile
import time
import uuid


def command(args, *, cwd=None, timeout=180):
    return subprocess.check_output(args, cwd=cwd, timeout=timeout, text=True, stderr=subprocess.STDOUT).strip()


def busy(app, proc=Path('/proc')):
    snapshot = app / 'seek-bot/data/run-service/state.json'
    if snapshot.exists():
        try:
            state = json.loads(snapshot.read_text())
            if state.get('activeCount') or any(a.get('inUse') or a.get('state', {}).get('running') for a in state.get('accounts', {}).values()):
                return True
        except (OSError, ValueError, TypeError):
            return True  # Unknown state is not permission to interrupt a browser.
    for entry in proc.iterdir():
        if not entry.name.isdigit():
            continue
        try:
            args = (entry / 'cmdline').read_bytes().split(b'\0')
            executable = os.fsdecode(args[0])
            if re.search(r'/(?:google-chrome(?:-stable)?|chrome|chromium(?:-browser)?)$', executable):
                return True
            if any(re.search(rb'(?:dist/(?:main|queue|check-signin|browser-benchmark)\.js|form-lab/worker\.mjs|benchmark-browser\.(?:mjs|mts))$', arg) for arg in args):
                return True
        except (FileNotFoundError, ProcessLookupError):
            continue
        except PermissionError:
            return True
    return False


CACHES = {'Cache', 'Code Cache', 'GPUCache', 'ShaderCache', 'GrShaderCache', 'GraphiteDawnCache', 'Crashpad'}


def backup_profiles(app, destination, version):
    users = app / 'seek-bot/data/users'
    profiles = sorted(p for p in users.glob('*/chrome') if p.is_dir() and not p.is_symlink())
    for profile in profiles:
        # Chrome's lock is a symlink, commonly dangling. Never unlink it to force a backup.
        if os.path.lexists(profile / 'SingletonLock'):
            raise RuntimeError('A browser profile is locked; update deferred.')
    size = sum(path.stat().st_size for profile in profiles for path in profile.rglob('*') if path.is_file() and not path.is_symlink())
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(destination, 0o700)
    if shutil.disk_usage(destination).free < size * 1.2 + 1024 ** 3:
        raise RuntimeError('Insufficient space for a complete pre-update profile backup.')
    name = f'profiles-{time.strftime("%Y%m%dT%H%M%S")}-{version}-{uuid.uuid4().hex[:8]}.tar.gz'
    archive = destination / name
    temporary = destination / (name + '.part')

    def include(info):
        parts = Path(info.name).parts
        if any(part in CACHES or part.startswith('Singleton') or part == 'DevToolsActivePort' for part in parts):
            return None
        return info

    try:
        with tarfile.open(temporary, 'w:gz', dereference=False) as tar:
            for profile in profiles:
                tar.add(profile, arcname=str(profile.relative_to(users)), filter=include)
        os.chmod(temporary, 0o600)
        with tarfile.open(temporary, 'r:gz') as tar:
            members = {member.name for member in tar.getmembers()}
            for profile in profiles:
                for required in ['Local State', 'Default/Cookies', 'Default/Network/Cookies', 'Default/Login Data']:
                    if (profile / required).is_file() and str((profile / required).relative_to(users)) not in members:
                        raise RuntimeError('Incomplete profile backup; Chrome was not updated.')
            # Read every byte so truncated archives are detected before installation.
            for member in tar.getmembers():
                if member.isfile():
                    stream = tar.extractfile(member)
                    while stream.read(1024 * 1024):
                        pass
        temporary.replace(archive)
        return archive
    finally:
        temporary.unlink(missing_ok=True)


def smoke(app, binary):
    owner = pwd.getpwuid(app.stat().st_uid).pw_name
    command(['sudo', '-u', owner, '-H', 'node', str(app / 'deploy/chrome-session-smoke.mjs'), str(app), str(binary)], cwd=app, timeout=100)


def update(app, *, refresh=True, run=command, is_busy=busy, backup=backup_profiles, test_browser=smoke,
           cache=Path('/var/cache/owtomate-chrome-update'), backups=Path('/var/backups/myasis/chrome'), settle=lambda: time.sleep(2)):
    gate = app / '.deploying'
    if gate.exists() or is_busy(app):
        return 'deferred: a run, browser or deployment is active'
    if refresh:
        run(['apt-get', '-o', 'Dir::Etc::sourcelist=/etc/apt/sources.list.d/google-chrome.sources',
             '-o', 'Dir::Etc::sourceparts=-', '-o', 'APT::Get::List-Cleanup=0', 'update', '--error-on=any'])
    installed = run(['dpkg-query', '-W', '-f=${Version}', 'google-chrome-stable'])
    policy = run(['apt-cache', 'policy', 'google-chrome-stable'])
    match = re.search(r'^\s*Candidate:\s*(\S+)', policy, re.M)
    if not match or not re.fullmatch(r'[0-9][A-Za-z0-9.+:~_-]*', match[1]):
        raise RuntimeError('No valid Chrome package candidate.')
    candidate = match[1]
    if candidate == installed:
        return 'current: Chrome is already up to date'
    # Never automatically downgrade profiles to an older Chrome.
    run(['dpkg', '--compare-versions', candidate, 'gt', installed])
    token = 'chrome-update:' + uuid.uuid4().hex
    try:
        with gate.open('x') as stream:
            stream.write(token)
    except FileExistsError:
        return 'deferred: another maintenance operation started'
    hold = False
    try:
        settle()
        if is_busy(app):
            return 'deferred: a browser started before maintenance acquired the account'
        cache.mkdir(parents=True, exist_ok=True, mode=0o755)
        os.chmod(cache, 0o755)
        stage = cache / ('candidate-' + uuid.uuid4().hex)
        stage.mkdir(mode=0o755)
        os.chmod(stage, 0o755)
        try:
            run(['apt-get', 'download', f'google-chrome-stable={candidate}'], cwd=stage)
            packages = list(stage.glob('*.deb'))
            if len(packages) != 1 or run(['dpkg-deb', '-f', str(packages[0]), 'Package']) != 'google-chrome-stable' or run(['dpkg-deb', '-f', str(packages[0]), 'Version']) != candidate:
                raise RuntimeError('Downloaded Chrome package identity did not match.')
            extracted = stage / 'extracted'
            run(['dpkg-deb', '-x', str(packages[0]), str(extracted)])
            os.chmod(extracted, 0o755)
            sandbox = extracted / 'opt/google/chrome/chrome-sandbox'
            os.chmod(sandbox, 0o4755)
            test_browser(app, extracted / 'opt/google/chrome/chrome')
            if is_busy(app):
                return 'deferred: a browser opened during the pre-update checks'
            archive = backup(app, backups, installed)
            # Last check after backup: never install over a live customer's browser.
            if is_busy(app):
                return 'deferred: a browser opened during backup'
            hold = True
            run(['apt-get', '-y', '--no-remove', 'install', str(packages[0])], timeout=300)
            if run(['dpkg-query', '-W', '-f=${Version}', 'google-chrome-stable']) != candidate:
                raise RuntimeError('Installed Chrome version did not match the verified package.')
            test_browser(app, Path('/usr/bin/google-chrome-stable'))
            hold = False
            # Keep two verified pre-update snapshots, never deleting current user profiles.
            for old in sorted(backups.glob('profiles-*.tar.gz'), key=lambda p: p.stat().st_mtime, reverse=True)[2:]:
                old.unlink()
            return f'updated: {installed} -> {candidate}; verified profile backup: {archive.name}'
        finally:
            shutil.rmtree(stage)
    finally:
        if gate.exists() and gate.read_text() == token:
            if hold:
                gate.write_text('chrome-update-needs-inspection: browser installation/check did not complete')
            else:
                gate.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, default=Path('/home/myasis/myasis'))
    parser.add_argument('--check', action='store_true', help='Report busy/update state without modifying packages or profiles.')
    args = parser.parse_args()
    app = args.app.resolve(strict=True)
    if args.check:
        print(json.dumps({'busy': busy(app), 'maintenance': (app / '.deploying').exists(),
                          'installed': command(['dpkg-query', '-W', '-f=${Version}', 'google-chrome-stable']),
                          'policy': command(['apt-cache', 'policy', 'google-chrome-stable'])}))
        return
    if os.geteuid() != 0:
        raise RuntimeError('Chrome package maintenance must run as root.')
    os.umask(0o077)
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(RuntimeError('Chrome update interrupted')))
    with open('/run/lock/myasis-deploy.lock', 'a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('deferred: deployment lock is held')
            return
        print(update(app), flush=True)


if __name__ == '__main__':
    main()
