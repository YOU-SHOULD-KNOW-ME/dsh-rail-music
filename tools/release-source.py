"""Produce a GitHub source ZIP from an allowlist, without runtime logs or local config."""
import json
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parents[1]
version = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version']
target = ROOT / 'dist' / f'dsh-rail-music-{version}-source.zip'
target.parent.mkdir(exist_ok=True)
top = ['package.json', 'README.md', 'LICENSE', 'icon.svg', 'cordis.patch.yml',
       '.gitignore', 'requirements.txt', 'CHANGELOG.md', 'GITHUB_RELEASE.md',
       'REVIEW_AND_OPTIMIZATION.md', 'COMPATIBILITY.md', 'docs/compatibility-source-audit.json',
       'docs/DEVELOPMENT.md', 'docs/README_DESIGN.md', 'docs/PLATFORMS.md']
files = [ROOT / name for name in top]
for folder, suffixes in [('lib', {'.js', '.py'}), ('test', {'.mjs', '.py'}),
                         ('tools', {'.mjs', '.py'}), ('.github', {'.yml'})]:
    files.extend(path for path in (ROOT / folder).rglob('*')
                 if path.is_file() and path.suffix in suffixes and '__pycache__' not in path.parts)
files.extend(ROOT / name for name in ['shots/rail-1.png', 'shots/rail-2.png',
             'shots/review/theme-strip.png', 'shots/review/aurora-settings.png', 'shots/review/light-settings.png'])
files.extend(path for path in (ROOT / 'docs/assets').iterdir() if path.suffix in {'.png', '.gif'})
missing = [str(path.relative_to(ROOT)) for path in files if not path.is_file()]
if missing:
    raise SystemExit(f'Missing release files: {missing}')
with ZipFile(target, 'w', ZIP_DEFLATED) as archive:
    for path in sorted(files):
        archive.write(path, Path('dsh-rail-music') / path.relative_to(ROOT))
print(target)
print(f'{len(files)} files; {target.stat().st_size} bytes')
