"""Extract only bounded regular compiler outputs; never trust tar links/paths."""
import os
import pathlib
import sys
import tarfile

archive, destination = map(pathlib.Path, sys.argv[1:])
os.umask(0o022)
if destination.exists():
    raise SystemExit('Artifact destination already exists')
with tarfile.open(archive, 'r:') as source:
    members = source.getmembers()
    files = [m for m in members if m.isfile()]
    if not files or len(members) > 1600 or sum(m.size for m in files) > 30_000_000:
        raise SystemExit('Artifact is empty or too large')
    for member in members:
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or '..' in path.parts or not path.parts or path.parts[0] != 'dist' or not (member.isdir() or member.isfile()):
            raise SystemExit('Artifact has an unsafe member')
        if member.isfile() and path.suffix not in ('.js', '.map', '.json'):
            raise SystemExit('Unexpected compiler output')
    destination.mkdir(parents=True, mode=0o755)
    for member in members:
        target = destination.joinpath(*pathlib.PurePosixPath(member.name).parts)
        if member.isdir():
            target.mkdir(parents=True, exist_ok=True, mode=0o755)
        else:
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
            data = source.extractfile(member)
            if data is None:
                raise SystemExit('Artifact member missing')
            with target.open('xb') as output:
                while chunk := data.read(1024 * 1024):
                    output.write(chunk)
            os.chmod(target, 0o644)
