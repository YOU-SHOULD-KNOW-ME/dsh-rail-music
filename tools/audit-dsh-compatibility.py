"""Inspect released DSH Git tags for the interfaces used by this plugin.

This is a static source audit, not a whole-application runtime certification.
Usage: python tools/audit-dsh-compatibility.py --repo D:/path/to/deepseek-harness
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--repo', required=True)
parser.add_argument('--output', default='docs/compatibility-source-audit.json')
args = parser.parse_args()

def git(*argv):
    result = subprocess.run(['git', '-C', args.repo, *argv], capture_output=True,
                            encoding='utf-8', errors='replace')
    return result.stdout if result.returncode == 0 else ''

paths = {
    'rpc': 'packages/client/connection/src/rpc.ts',
    'rpc_host': 'packages/client/connection/src/rpc-host.ts',
    'web': 'packages/host/webserver/src/index.ts',
    'modules': 'packages/client/modules/src/index.ts',
    'factory': 'packages/client/modules/src/client/manifest.ts',
    'lifecycle': 'packages/client/modules/src/client/entries.ts',
    'css': 'packages/client/ui-chat/src/client/chat/TurnNavigator.module.css',
    'nav': 'packages/client/ui-chat/src/client/chat/TurnNavigator.tsx',
    'boot': 'packages/boot/app-boot/src/index.ts',
    'profile': 'packages/boot/app-boot/src/profile.ts',
}
rows = []
for tag in git('tag', '--sort=version:refname', '--list', 'dsh-v*').splitlines():
    sources = {key: git('show', f'{tag}:{path}') for key, path in paths.items()}
    root = json.loads(git('show', f'{tag}:package.json'))
    checks = {
        'exact_fetch_registry': 'readonly fetch: HostConnectionFetch' in sources['rpc']
            and 'requestBody' in sources['rpc'] and 'route.methods' in sources['rpc_host'],
        'index_injection': 'webserver/index-inject' in sources['web'],
        'native_client_declaration': 'dsh.client' in sources['modules'],
        'lazy_factory_registration': 'factory:' in sources['factory']
            and '__ModuleLoader__' in sources['factory'],
        'live_client_reconciliation': bool(sources['lifecycle'])
            and 'loader.remove(' in sources['lifecycle'],
        'direct_rail_buttons': bool(re.search(r'^\.marks\s*\{', sources['css'], re.M))
            and 'css.marks' in sources['nav'] and 'css.markPosition' not in sources['nav']
            and 'useVirtualizer' in sources['nav'],
        'rail_state_classes': all(re.search(r'^\.' + name + r'(?=[\s:{.])', sources['css'], re.M)
            for name in ['slot', 'frame', 'mark', 'markActive', 'markUnloaded', 'markPreview']),
        'bundle_patch_composition': 'bundlePatchPaths' in sources['boot']
            or '"bundle": { "patch"' in sources['profile'],
    }
    row = {
        'tag': tag, 'version': tag.removeprefix('dsh-v'),
        'commit': git('rev-parse', tag).strip(),
        'date': git('show', '-s', '--format=%cs', tag).strip(),
        'source_node_engines': root.get('engines', {}).get('node'),
        'checks': checks, 'all_interfaces_present': all(checks.values()),
        'missing': [name for name, value in checks.items() if not value],
    }
    rows.append(row)
    print(f"{row['version']}: {'INTERFACES PRESENT' if row['all_interfaces_present'] else ', '.join(row['missing'])}", flush=True)
target = Path(args.output)
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(json.dumps({
    'generated_at_utc': datetime.now(timezone.utc).isoformat(),
    'kind': 'static-source-audit', 'source_paths': paths, 'versions': rows,
}, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
print(target.resolve(), flush=True)
