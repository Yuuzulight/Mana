import base64
import contextlib
import io
import json
import os
from pathlib import Path
import sys
import traceback


class BoundedLog(io.StringIO):
    def write(self, text):
        remaining = max(0, 20000 - self.tell())
        super().write(text[:remaining])
        return len(text)


workspace = Path(sys.argv[1])
scratch_root = os.path.normcase(os.path.realpath(workspace))
native_mkdir = os.mkdir


def scratch_mkdir(path, mode=0o777, *, dir_fd=None):
    # Windows' 0700 ACL omits the AppContainer SID. Inside private scratch,
    # inherit the helper's user/SID ACL rather than replacing it.
    if mode == 0o700 and dir_fd is None:
        target = os.path.normcase(os.path.realpath(os.fsdecode(path)))
        try:
            if os.path.commonpath((scratch_root, target)) == scratch_root:
                mode = 0o777
        except ValueError:
            pass
    return native_mkdir(path, mode, dir_fd=dir_fd)


os.mkdir = scratch_mkdir
payload = json.loads((workspace / 'request.json').read_text(encoding='utf-8'))
os.chdir(workspace)
output_dir = workspace / 'output'
output_dir.mkdir()
for file in payload.get('files', []):
    name = file['name']
    if Path(name).name != name or name in ('.', '..'):
        raise ValueError('invalid input filename')
    (workspace / name).write_bytes(base64.b64decode(file['data'], validate=True))

logs = BoundedLog()
error = None
try:
    with contextlib.redirect_stdout(logs), contextlib.redirect_stderr(logs):
        exec(compile(payload['code'], '<mana-analysis>', 'exec'),
             {'__name__': '__main__', 'output_dir': str(output_dir)})
except BaseException:
    error = traceback.format_exc()[-4000:]

charts = []
for file in sorted(output_dir.glob('*.png'))[:4]:
    if file.is_symlink() or not file.is_file() or file.stat().st_size > 256000:
        continue
    data = file.read_bytes()
    if data.startswith(b'\x89PNG\r\n\x1a\n'):
        charts.append({'name': file.name, 'data': base64.b64encode(data).decode('ascii')})
(workspace / 'result.json').write_text(
    json.dumps({'logs': logs.getvalue(), 'error': error, 'charts': charts}), encoding='utf-8')
