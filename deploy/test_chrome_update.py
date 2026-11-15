import importlib.util
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('chrome_update', Path(__file__).with_name('chrome-update.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ChromeUpdateTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.app = Path(self.directory.name)
        self.installed = '153.1-1'
        self.calls = []
        self.backed_up = False
        self.checks = 0

    def run_command(self, args, **kwargs):
        self.calls.append(args)
        if args[0] == 'dpkg-query': return self.installed
        if args[0] == 'apt-cache': return '  Candidate: 157.2-1'
        if args[:2] == ['apt-get', 'download']:
            (kwargs['cwd'] / 'chrome.deb').write_bytes(b'fixture')
        if args[:2] == ['dpkg-deb', '-f']: return 'google-chrome-stable' if args[-1] == 'Package' else '157.2-1'
        if args[:2] == ['dpkg-deb', '-x']:
            sandbox = Path(args[-1]) / 'opt/google/chrome/chrome-sandbox'
            sandbox.parent.mkdir(parents=True)
            sandbox.touch()
        if 'install' in args:
            self.assertTrue(self.backed_up, 'installation must follow the complete profile backup')
            self.assertTrue((self.app / '.deploying').exists(), 'new starts must be held during the update')
            self.installed = '157.2-1'
        return ''

    def backup(self, *args):
        self.backed_up = True
        return self.app / 'backup.tar.gz'

    def smoke(self, *args): self.checks += 1

    def update(self, **overrides):
        options = dict(refresh=False, run=self.run_command, backup=self.backup, test_browser=self.smoke,
                       is_busy=lambda _: False, cache=self.app / 'cache', backups=self.app / 'backups', settle=lambda: None)
        options.update(overrides)
        return module.update(self.app, **options)

    def test_active_browser_defers_without_touching_packages(self):
        self.assertIn('deferred', self.update(is_busy=lambda _: True))
        self.assertEqual(self.calls, [])

    def test_browser_starting_after_gate_defers(self):
        calls = iter([False, True])
        self.assertIn('deferred', self.update(is_busy=lambda _: next(calls)))
        self.assertFalse((self.app / '.deploying').exists())
        self.assertFalse(self.backed_up)

    def test_browser_starting_during_backup_defers_install(self):
        calls = iter([False, False, False, True])
        self.assertIn('deferred', self.update(is_busy=lambda _: next(calls)))
        self.assertTrue(self.backed_up)
        self.assertEqual(self.installed, '153.1-1')

    def test_success_checks_candidate_and_installed_browser(self):
        self.assertIn('updated', self.update())
        self.assertEqual(self.checks, 2)
        self.assertFalse((self.app / '.deploying').exists())

    def test_failed_candidate_never_installs(self):
        def fail(*_): raise RuntimeError('candidate incompatible')
        with self.assertRaisesRegex(RuntimeError, 'candidate incompatible'): self.update(test_browser=fail)
        self.assertEqual(self.installed, '153.1-1')
        self.assertFalse(self.backed_up)
        self.assertFalse((self.app / '.deploying').exists())

    def test_failed_installed_browser_keeps_maintenance_hold_and_backup(self):
        def fail(*_):
            if self.installed == '157.2-1': raise RuntimeError('installed browser failed')
        with self.assertRaisesRegex(RuntimeError, 'installed browser failed'): self.update(test_browser=fail)
        self.assertTrue(self.backed_up)
        self.assertIn('needs-inspection', (self.app / '.deploying').read_text())

    def test_existing_maintenance_gate_is_preserved(self):
        (self.app / '.deploying').write_text('another release')
        self.assertIn('deferred', self.update())
        self.assertEqual((self.app / '.deploying').read_text(), 'another release')

    def test_locked_profile_is_not_backed_up_or_modified(self):
        profile = self.app / 'seek-bot/data/users/1/chrome'
        profile.mkdir(parents=True)
        (profile / 'SingletonLock').symlink_to('host-123')
        with self.assertRaisesRegex(RuntimeError, 'locked'):
            module.backup_profiles(self.app, self.app / 'backups', '153')
        self.assertTrue(os.path.lexists(profile / 'SingletonLock'))

    def test_backup_restores_all_users_sessions_but_excludes_cache(self):
        for user in ['1', '183']:
            profile = self.app / f'seek-bot/data/users/{user}/chrome'
            for name in ['Local State', 'Default/Network/Cookies', 'Default/Login Data', 'Default/Local Storage/leveldb/test', 'Default/Cache/test']:
                path = profile / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(f'fictional-private-{user}-{name}'.encode())
        archive = module.backup_profiles(self.app, self.app / 'backups', '153')
        with tarfile.open(archive) as tar:
            self.assertEqual(tar.extractfile('183/chrome/Default/Network/Cookies').read(), b'fictional-private-183-Default/Network/Cookies')
            self.assertIn('1/chrome/Local State', tar.getnames())
            self.assertIn('1/chrome/Default/Login Data', tar.getnames())
            self.assertIn('183/chrome/Default/Local Storage/leveldb/test', tar.getnames())
            self.assertNotIn('1/chrome/Default/Cache/test', tar.getnames())
        self.assertEqual(archive.stat().st_mode & 0o777, 0o600)
        self.assertEqual(archive.parent.stat().st_mode & 0o777, 0o700)

    def test_busy_detects_browser_and_starting_run(self):
        proc = self.app / 'proc'
        process = proc / '123'
        process.mkdir(parents=True)
        (process / 'cmdline').write_bytes(b'/opt/google/chrome/chrome\0--user-data-dir=/private\0')
        self.assertTrue(module.busy(self.app, proc))
        (process / 'cmdline').write_bytes(b'/opt/google/chrome/chrome --user-data-dir=/private --test-type\0')
        self.assertTrue(module.busy(self.app, proc), 'Chrome can rewrite argv into a single space-separated process title')
        (process / 'exe').symlink_to('/opt/google/chrome/chrome (deleted)')
        (process / 'cmdline').write_bytes(b'rewritten browser title\0')
        self.assertTrue(module.busy(self.app, proc), 'the executable identifies even a replaced binary with a rewritten title')
        (process / 'exe').unlink()
        (process / 'cmdline').write_bytes(b'node\0dist/main.js\0')
        self.assertTrue(module.busy(self.app, proc))
        (process / 'cmdline').write_bytes(b'node\0idle-service.js\0')
        self.assertFalse(module.busy(self.app, proc))
        snapshot = self.app / 'seek-bot/data/run-service/state.json'
        snapshot.parent.mkdir(parents=True)
        snapshot.write_text(json.dumps({'accounts': {'183': {'inUse': True}}}))
        self.assertTrue(module.busy(self.app, proc))


if __name__ == '__main__': unittest.main()
