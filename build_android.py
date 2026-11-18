#!/usr/bin/env python3
"""Build the Android WebView host using a local SDK and the existing web/dist."""

import argparse
import getpass
import os
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import xml.etree.ElementTree as ET
import zipfile


ROOT = Path(__file__).resolve().parent
BUILD_TOOLS = '35.0.0'
ANDROID = '{http://schemas.android.com/apk/res/android}'
DEBUG_STORE = ROOT / '.signing' / 'debug.p12'


def run(*args, env=None):
    subprocess.run([str(arg) for arg in args], check=True, env=env)


def java_tool(name):
    filename = name + ('.exe' if os.name == 'nt' else '')
    if os.environ.get('JAVA_HOME'):
        path = Path(os.environ['JAVA_HOME']) / 'bin' / filename
        if path.is_file():
            return path
    resolved = shutil.which(filename)
    if not resolved:
        raise ValueError(f'Cannot find {filename}. Install JDK 17 and set JAVA_HOME.')
    return Path(resolved)


def sdk_dir(explicit):
    home = Path.home()
    selected = explicit or os.environ.get('ANDROID_HOME') or os.environ.get('ANDROID_SDK_ROOT')
    if selected:
        return Path(selected).expanduser().resolve()
    local = Path(os.environ.get('LOCALAPPDATA', home / 'AppData' / 'Local'))
    for candidate in (local / 'Android' / 'Sdk', home / 'Library' / 'Android' / 'sdk', home / 'Android' / 'Sdk', home / 'Android'):
        if (candidate / 'build-tools').is_dir():
            return candidate
    raise ValueError('Set ANDROID_HOME or pass --sdk. Install Android SDK Platform 35 and Build-Tools 35.0.0.')


def align_apk(source, output):
    # Only ZIP32 and Java resources here, so stored entries need four-byte alignment.
    with zipfile.ZipFile(source) as src, zipfile.ZipFile(output, 'w', allowZip64=False) as dst:
        for entry in src.infolist():
            data = src.read(entry)
            if entry.compress_type == zipfile.ZIP_STORED:
                offset = dst.fp.tell() + 30 + len(entry.filename.encode('utf-8')) + len(entry.extra)
                pad = (-offset) % 4
                if pad:
                    entry.extra += struct.pack('<HH', 0xD935, pad) + bytes(pad)
            dst.writestr(entry, data)


def signing_options(args):
    env = os.environ.copy()
    if args.keystore:
        store = args.keystore.expanduser().resolve()
        if not store.is_file() or not args.key_alias:
            raise ValueError('--keystore needs an existing private file and --key-alias.')
        if not env.get('DSP_KEYSTORE_PASSWORD'):
            env['DSP_KEYSTORE_PASSWORD'] = getpass.getpass('Keystore password: ')
        if not env.get('DSP_KEY_PASSWORD'):
            env['DSP_KEY_PASSWORD'] = env['DSP_KEYSTORE_PASSWORD']
        return store, args.key_alias, env, 'release'
    if args.key_alias:
        raise ValueError('--key-alias is only used with --keystore.')
    if not DEBUG_STORE.exists():
        DEBUG_STORE.parent.mkdir(parents=True, exist_ok=True)
        run(java_tool('keytool'), '-genkeypair', '-keystore', DEBUG_STORE, '-storetype', 'PKCS12',
            '-alias', 'debug', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000',
            '-storepass', 'android', '-keypass', 'android', '-dname', 'CN=Local Android Debug')
    env.update(DSP_KEYSTORE_PASSWORD='android', DSP_KEY_PASSWORD='android')
    return DEBUG_STORE, 'debug', env, 'debug'


def build(args):
    dist = ROOT / 'web' / 'dist'
    for name in ('index.html', 'LICENSE', 'THIRD_PARTY_NOTICES.md'):
        if not (dist / name).is_file():
            raise ValueError('Build the Web app first: pnpm --dir web build')
    sdk = sdk_dir(args.sdk)
    tools = sdk / 'build-tools' / BUILD_TOOLS
    aapt2 = tools / ('aapt2.exe' if os.name == 'nt' else 'aapt2')
    android_jar = sdk / 'platforms' / 'android-35' / 'android.jar'
    d8, apksigner = (tools / 'lib' / jar for jar in ('d8.jar', 'apksigner.jar'))
    missing = [str(item) for item in (aapt2, android_jar, d8, apksigner) if not item.is_file()]
    if missing:
        raise ValueError('Missing Android SDK tools:\n  ' + '\n  '.join(missing))
    java, javac = java_tool('java'), java_tool('javac')
    manifest = ROOT / 'android' / 'AndroidManifest.xml'
    uses_sdk = ET.parse(manifest).getroot().find('uses-sdk')
    min_api, target_api = (uses_sdk.attrib[ANDROID + key] for key in ('minSdkVersion', 'targetSdkVersion'))
    output = ROOT / 'build' / 'android'
    output.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix='work-', dir=output) as temp:
        work = Path(temp)
        classes, dex = work / 'classes', work / 'dex'
        classes.mkdir()
        dex.mkdir()
        res, unsigned, aligned = (work / name for name in ('res.zip', 'unsigned.apk', 'aligned.apk'))
        run(aapt2, 'compile', '--dir', ROOT / 'android' / 'res', '-o', res)
        run(aapt2, 'link', '-I', android_jar, '--manifest', manifest, '--min-sdk-version', min_api,
            '--target-sdk-version', target_api, '-o', unsigned, res)
        sources = sorted((ROOT / 'android' / 'src').rglob('*.java'))
        run(javac, '-encoding', 'UTF-8', '-source', '8', '-target', '8', '-cp', android_jar, '-d', classes, *sources)
        jar = work / 'host.jar'
        with zipfile.ZipFile(jar, 'w') as z:
            for item in sorted(classes.rglob('*.class')):
                z.write(item, item.relative_to(classes).as_posix())
        run(java, '-cp', d8, 'com.android.tools.r8.D8', '--min-api', min_api, '--lib', android_jar, '--output', dex, jar)
        with zipfile.ZipFile(unsigned, 'a', compression=zipfile.ZIP_DEFLATED) as z:
            # WebView asset URLs need forward slashes on every build host.
            for asset in sorted(dist.rglob('*')):
                if asset.is_file():
                    z.write(asset, 'assets/www/' + asset.relative_to(dist).as_posix())
            for item in sorted(dex.glob('classes*.dex')):
                z.write(item, item.name)
        align_apk(unsigned, aligned)
        store, alias, env, variant = signing_options(args)
        candidate = work / f'deepseek-plus-{variant}.apk'
        run(java, '-jar', apksigner, 'sign', '--ks', store, '--ks-key-alias', alias,
            '--ks-pass', 'env:DSP_KEYSTORE_PASSWORD', '--key-pass', 'env:DSP_KEY_PASSWORD',
            '--v4-signing-enabled', 'false', '--out', candidate, aligned, env=env)
        run(java, '-jar', apksigner, 'verify', '--verbose', candidate)
        with zipfile.ZipFile(candidate) as z:
            if z.testzip() is not None or not {'classes.dex', 'assets/www/index.html'} <= set(z.namelist()):
                raise ValueError('APK contents did not pass validation.')
        apk = output / candidate.name
        candidate.replace(apk)
    print(f'APK: {apk}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sdk', help='Path to Android SDK (defaults to ANDROID_HOME)')
    parser.add_argument('--keystore', type=Path, help='Use an existing private release keystore')
    parser.add_argument('--key-alias', help='Alias inside the supplied keystore')
    args = parser.parse_args()
    try:
        build(args)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'Android build failed: {error}\n')


if __name__ == '__main__':
    main()
