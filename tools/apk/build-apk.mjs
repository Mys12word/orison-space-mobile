#!/usr/bin/env node
/**
 * Build an installable APK for Orison Space 手机版 — entirely on-device.
 *
 *   javac → d8 → aapt → zipalign → apksigner
 *
 * The APK bundles:
 *   • the esbuild host bundle (desktop main-process services),
 *   • the Vite renderer (same React UI),
 *   • a Node runtime + its shared libraries (arm64-v8a),
 * and starts the host as a child process inside the app sandbox.
 *
 * Requires: tools/apk/fetch-toolchain.mjs to have been run, and a Node binary
 * at $PREFIX/bin/node (Termux build) with its libs in $PREFIX/lib.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const APP_DIR = existsSync(path.join(ROOT, 'apps/mobile/dist'))
  ? path.join(ROOT, 'apps/mobile/dist')
  : path.join(ROOT, 'app/dist');
const APK_SRC = path.join(ROOT, 'apk');
const WORK = process.env.APK_BUILD_DIR || path.join(ROOT, '.apkbuild');
const TOOLCHAIN = process.env.APK_TOOLCHAIN_DIR || path.join(ROOT, '.toolchain');
const PREFIX = path.join(TOOLCHAIN, 'sysroot/data/data/com.termux/files/usr');
const JDK = path.join(PREFIX, 'lib/jvm/java-17-openjdk');
const JAVA = path.join(JDK, 'bin/java');
const JAVAC = path.join(JDK, 'bin/javac');
const KEYTOOL = path.join(JDK, 'bin/keytool');
const D8_JAR = path.join(PREFIX, 'share/java/d8.jar');
const APKSIGNER_JAR = path.join(PREFIX, 'share/java/apksigner.jar');
const AAPT = path.join(PREFIX, 'bin/aapt');
const ZIPALIGN = path.join(PREFIX, 'bin/zipalign');
const ANDROID_JAR = process.env.ANDROID_API_JAR || path.join(TOOLCHAIN, 'android-all.jar');
const FRAMEWORK_RES = '/system/framework/framework-res.apk';
const TERMUX_PREFIX = process.env.ORISON_TERMUX_PREFIX || process.env.PREFIX || '/data/data/com.termux/files/usr';
const NODE_BIN = process.env.ORISON_NODE_BIN || path.join(TERMUX_PREFIX, 'bin/node');
const NODE_LIB_DIR = process.env.ORISON_NODE_LIB_DIR || path.join(TERMUX_PREFIX, 'lib');
const OPENSSL_ETC = ['openssl.cnf', 'cert.pem'];
const OPENSSL_MODULES_DIR = ['legacy.so'];
const NODE_LIBS = [
  'libz.so.1',
  'libcares.so',
  'libsqlite3.so',
  'libffi.so',
  'libcrypto.so.3',
  'libssl.so.3',
  'libicui18n.so.78',
  'libicuuc.so.78',
  'libicudata.so.78',
  'libc++_shared.so',
  'libandroid-support.so',
];

const KEYSTORE = path.join(APK_SRC, 'keystore.jks');
const KS_PASS = 'orisonmobile';
const KS_ALIAS = 'orison';

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: { ...process.env, LD_LIBRARY_PATH: `${PREFIX}/lib` },
    ...options,
  });
  if (result.error) fail(`${path.basename(command)}: ${result.error.message}`);
  if (result.status !== 0) fail(`${path.basename(command)} exited with ${result.status}`);
}

function javaArgs(extra) {
  return ['-XX:-UsePerfData', `-Djava.io.tmpdir=${path.join(WORK, 'tmp')}`, ...extra];
}

/** javac / keytool are launchers: JVM flags must go through -J. */
function jvmToolArgs(extra) {
  return ['-J-XX:-UsePerfData', `-J-Djava.io.tmpdir=${path.join(WORK, 'tmp')}`, ...extra];
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

function rmrf(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/* ── 0. sanity ── */
for (const [label, target] of [
  ['toolchain prefix', PREFIX],
  ['d8.jar', D8_JAR],
  ['apksigner.jar', APKSIGNER_JAR],
  ['aapt', AAPT],
  ['android.jar', ANDROID_JAR],
  ['framework-res.apk', FRAMEWORK_RES],
  ['node binary', NODE_BIN],
  ['host bundle', path.join(APP_DIR, 'host/server.js')],
  ['renderer build', path.join(APP_DIR, 'renderer/index.html')],
]) {
  if (!existsSync(target)) fail(`missing ${label}: ${target}`);
}

console.log(`[apk] work dir: ${WORK}`);
rmrf(WORK);
const assets = ensureDir(path.join(WORK, 'assets'));
const runtime = ensureDir(path.join(WORK, 'assets/runtime'));
const libDir = ensureDir(path.join(runtime, 'lib'));
ensureDir(path.join(WORK, 'tmp'));

/* ── 1. runtime assets ── */
console.log('[apk] staging node runtime');
copyFileSync(NODE_BIN, path.join(runtime, 'node'));

for (const name of NODE_LIBS) {
  const source = path.join(NODE_LIB_DIR, name);
  if (!existsSync(source)) {
    console.warn(`  ! missing lib ${name} (skipped)`);
    continue;
  }
  copyFileSync(realpathSync(source), path.join(libDir, name));
}

// OpenSSL assets: the Termux node/libcrypto bake in OPENSSLDIR=/data/data/com.termux...;
// inside the APK sandbox that path is unreadable and OpenSSL aborts at startup.
console.log('[apk] staging openssl config + provider modules');
const etcDir = ensureDir(path.join(runtime, 'etc'));
for (const name of OPENSSL_ETC) {
  const source = path.join(NODE_LIB_DIR, '../etc/tls', name);
  if (existsSync(source)) copyFileSync(realpathSync(source), path.join(etcDir, name));
  else console.warn(`  ! missing openssl asset ${name} (empty config will be used)`);
}
if (!existsSync(path.join(etcDir, 'openssl.cnf'))) writeFileSync(path.join(etcDir, 'openssl.cnf'), '');

const modulesDir = ensureDir(path.join(libDir, 'ossl-modules'));
for (const name of OPENSSL_MODULES_DIR) {
  const source = path.join(NODE_LIB_DIR, 'ossl-modules', name);
  if (existsSync(source)) copyFileSync(realpathSync(source), path.join(modulesDir, name));
  else console.warn(`  ! missing openssl module ${name}`);
}

console.log('[apk] staging host + renderer');
cpSync(path.join(APP_DIR, 'host'), path.join(runtime, 'host'), { recursive: true });
cpSync(path.join(APP_DIR, 'renderer'), path.join(runtime, 'web'), { recursive: true });

// Version stamp: host bundle hash so a rebuilt host triggers re-extraction on
// the next launch of an updated APK (same versionCode is fine for sideload).
const pkgPath = existsSync(path.join(ROOT, 'apps/mobile/package.json'))
  ? path.join(ROOT, 'apps/mobile/package.json')
  : path.join(ROOT, 'app/package.json');
if (existsSync(pkgPath)) copyFileSync(pkgPath, path.join(runtime, 'package.json'));

const hash = createHash('sha256');
hash.update(readFileSync(path.join(APP_DIR, 'host/server.js')));
hash.update(readFileSync(path.join(APP_DIR, 'renderer/index.html')));
const runtimeVersion = hash.digest('hex').slice(0, 12);
writeFileSync(path.join(runtime, 'VERSION'), `${runtimeVersion}\n`);
console.log(`[apk] runtime version ${runtimeVersion}`);

/* ── 2. compile ── */
console.log('[apk] javac');
const srcFiles = [];
(function collect(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full);
    else if (entry.name.endsWith('.java')) srcFiles.push(full);
  }
})(path.join(APK_SRC, 'src'));

const classesDir = ensureDir(path.join(WORK, 'classes'));
run(JAVAC, jvmToolArgs([
  '-encoding', 'UTF-8',
  '-source', '11', '-target', '11',
  '-classpath', ANDROID_JAR,
  '-d', classesDir,
  ...srcFiles,
]));

/* ── 3. dex ── */
console.log('[apk] d8');
const dexDir = ensureDir(path.join(WORK, 'dex'));
const classFiles = [];
(function collect(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full);
    else if (entry.name.endsWith('.class')) classFiles.push(full);
  }
})(classesDir);

run(JAVA, javaArgs([
  '-cp', D8_JAR,
  'com.android.tools.r8.D8',
  '--release',
  '--min-api', '26',
  '--lib', ANDROID_JAR,
  '--output', dexDir,
  ...classFiles,
]));

/* ── 4. package ── */
console.log('[apk] aapt package');
const unsigned = path.join(WORK, 'unsigned.apk');
run(AAPT, [
  'package', '-f',
  '-M', path.join(APK_SRC, 'AndroidManifest.xml'),
  '-S', path.join(APK_SRC, 'res'),
  '-A', assets,
  '-I', FRAMEWORK_RES,
  '-F', unsigned,
]);

console.log('[apk] adding classes.dex');
copyFileSync(path.join(dexDir, 'classes.dex'), path.join(WORK, 'classes.dex'));
run(AAPT, ['add', unsigned, 'classes.dex'], { cwd: WORK });

/* ── 5. align + sign ── */
console.log('[apk] zipalign');
const aligned = path.join(WORK, 'aligned.apk');
run(ZIPALIGN, ['-f', '4', unsigned, aligned]);

if (!existsSync(KEYSTORE)) {
  console.log('[apk] generating signing key');
  run(KEYTOOL, jvmToolArgs([
    '-genkeypair',
    '-keystore', KEYSTORE,
    '-alias', KS_ALIAS,
    '-keyalg', 'RSA',
    '-keysize', '2048',
    '-validity', '10000',
    '-storepass', KS_PASS,
    '-keypass', KS_PASS,
    '-dname', 'CN=Orison Space Mobile, O=LumenStorm Port, C=CN',
  ]));
}

const versionName = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
const outDir = ensureDir(path.join(ROOT, 'dist'));
const finalApk = path.join(outDir, `OrisonSpace-${versionName}.apk`);

console.log('[apk] signing');
run(JAVA, javaArgs([
  '-jar', APKSIGNER_JAR,
  'sign',
  '--ks', KEYSTORE,
  '--ks-key-alias', KS_ALIAS,
  '--ks-pass', `pass:${KS_PASS}`,
  '--key-pass', `pass:${KS_PASS}`,
  '--out', finalApk,
  aligned,
]));

console.log('[apk] verifying');
run(JAVA, javaArgs(['-jar', APKSIGNER_JAR, 'verify', '--print-certs', finalApk]));

const size = statSync(finalApk).size;
console.log(`\n✓ ${finalApk} (${(size / 1024 / 1024).toFixed(1)} MB)`);
