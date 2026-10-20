#!/usr/bin/env node
/**
 * Download + unpack the on-device Android build toolchain (no apt, no root).
 *
 * Termux .deb packages are plain `ar` archives; Node parses the ar container and
 * pipes data.tar.* through `tar` into a private sysroot, so javac / d8 / aapt /
 * apksigner all run from a normal app-private directory.
 */
import { spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = process.env.APK_TOOLCHAIN_DIR || path.join(HERE, '.toolchain');
const SYSROOT = path.join(ROOT, 'sysroot');
const DEBS = path.join(ROOT, 'debs');
const MIRRORS = [
  'https://mirrors.pku.edu.cn/termux/apt/termux-main',
  'https://mirror.iscas.ac.cn/termux/apt/termux-main',
  'https://mirrors.tuna.tsinghua.edu.cn/termux/apt/termux-main',
  'https://mirror.nju.edu.cn/termux/apt/termux-main',
  'https://mirrors.ustc.edu.cn/termux/apt/termux-main',
  'https://packages.termux.dev/apt/termux-main',
];

for (const dir of [ROOT, SYSROOT, DEBS]) mkdirSync(dir, { recursive: true });

const wanted = new Set([
  'openjdk-17',
  'libandroid-shmem',
  'libandroid-spawn',
  'libiconv',
  'libjpeg-turbo',
  'zlib',
  'littlecms',
  'alsa-plugins',
  'aapt',
  'fmt',
  'libc++',
  'libexpat',
  'libpng',
  'libzopfli',
  'apksigner',
  'd8',
]);

/* ── package index ── */
async function fetchBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function loadIndex() {
  const cached = path.join(ROOT, 'Packages.gz');
  if (!existsSync(cached)) {
    let lastError;
    for (const mirror of MIRRORS) {
      try {
        const buf = await fetchBuffer(`${mirror}/dists/stable/main/binary-aarch64/Packages.gz`);
        writeFileSync(cached, buf);
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (!existsSync(cached)) throw lastError;
  }
  const text = zlib.gunzipSync(readFileSync(cached)).toString('utf8');
  const map = new Map();
  for (const stanza of text.split(/\n\n/)) {
    const fields = {};
    for (const line of stanza.split('\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) fields[line.slice(0, idx)] = line.slice(idx + 1).trim();
    }
    if (fields.Package && fields.Filename) map.set(fields.Package, fields);
  }
  return map;
}

/* ── deb download ── */
async function downloadDeb(name, filename) {
  const dest = path.join(DEBS, `${name}.deb`);
  if (existsSync(dest) && statSync(dest).size > 1024) return dest;
  let lastError;
  for (const mirror of MIRRORS) {
    try {
      const url = `${mirror}/${filename}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buf = Buffer.from(await response.arrayBuffer());
      writeFileSync(dest, buf);
      console.log(`  ↓ ${name} (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
      return dest;
    } catch (err) {
      lastError = err;
      console.warn(`  ! ${name} from ${mirror}: ${err.message}`);
    }
  }
  throw lastError;
}

/* ── ar parsing + tar extraction ── */
function readArEntries(buffer) {
  if (buffer.subarray(0, 8).toString() !== '!<arch>\n') throw new Error('not an ar archive');
  const entries = [];
  let offset = 8;
  while (offset + 60 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 60);
    const name = header.subarray(0, 16).toString().trim().replace(/\/$/, '');
    const size = Number.parseInt(header.subarray(48, 58).toString().trim(), 10);
    if (!Number.isFinite(size)) break;
    const data = buffer.subarray(offset + 60, offset + 60 + size);
    entries.push({ name, data });
    offset += 60 + size + (size % 2);
  }
  return entries;
}

function extractDeb(debPath) {
  const entries = readArEntries(readFileSync(debPath));
  const dataEntry = entries.find((entry) => entry.name.startsWith('data.tar'));
  if (!dataEntry) throw new Error(`${debPath}: no data.tar entry`);
  const magic = dataEntry.data.subarray(0, 4);
  const isXz = magic[0] === 0xfd && magic[1] === 0x37 && magic[2] === 0x7a;
  const isZstd = magic[0] === 0x28 && magic[1] === 0xb5;
  const isGz = magic[0] === 0x1f && magic[1] === 0x8b;
  const tarArgs = ['-C', SYSROOT, '-xf', '-'];
  if (isXz) tarArgs.unshift('-J');
  else if (isZstd) tarArgs.unshift('--zstd');
  else if (isGz) tarArgs.unshift('-z');
  else throw new Error(`unknown data.tar compression for ${debPath}`);
  const result = spawnSync('tar', tarArgs, { input: dataEntry.data, stdio: ['pipe', 'inherit', 'inherit'] });
  if (result.status !== 0) throw new Error(`tar failed for ${debPath}`);
}

const index = await loadIndex();
console.log(`[toolchain] ${wanted.size} packages → ${SYSROOT}`);
for (const name of wanted) {
  const meta = index.get(name);
  if (!meta) {
    console.warn(`  ? ${name} not in index (skipped)`);
    continue;
  }
  const dest = await downloadDeb(name, meta.Filename);
  console.log(`  ⇣ ${name}`);
  extractDeb(dest);
}

/* ── android.jar (Robolectric android-all) ── */
const androidJar = path.join(ROOT, 'android-all.jar');
if (!existsSync(androidJar)) {
  const candidates = [
    'https://maven.aliyun.com/repository/central/org/robolectric/android-all/14-robolectric-10818077/android-all-14-robolectric-10818077.jar',
    'https://repo1.maven.org/maven2/org/robolectric/android-all/14-robolectric-10818077/android-all-14-robolectric-10818077.jar',
  ];
  for (const url of candidates) {
    try {
      console.log('[toolchain] downloading android.jar (137 MB)');
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      writeFileSync(androidJar, Buffer.from(await response.arrayBuffer()));
      console.log(`[toolchain] android.jar → ${androidJar}`);
      break;
    } catch (err) {
      console.warn(`  ! android.jar from ${url}: ${err.message}`);
    }
  }
}

console.log('[toolchain] done');
