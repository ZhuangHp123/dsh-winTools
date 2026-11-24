'use strict';

/**
 * 生成便携版目录：把应用代码和 Electron 运行时拼在一起，产出可双击的 dsh-winTools.exe。
 *
 * 不走 electron-builder / electron-packager：这台机器访问 GitHub 受限，
 * 而运行时本来就以官方 zip 落在 electron 的下载缓存里，直接解压复用即可。
 *
 * 流程：
 *   1. 找到 electron 版本对应的官方 zip（优先 node_modules/electron/dist 同版本缓存）
 *   2. 解压到一个干净的目录 dist/dsh-winTools-win32-x64/
 *   3. 覆盖 resources/app/（源码 + package.json + assets）
 *   4. 用 resedit（纯 JS）把 electron.exe 改名后的 exe 打上图标与版本信息
 *
 * 用法：node scripts/pack.js
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const APP_NAME = 'dsh-winTools';
const OUT_DIR = path.join(ROOT, 'dist', `${APP_NAME}-win32-x64`);
const APP_DIR_NAME = 'dsh-winTools.exe';

const log = (...args) => console.log('[pack]', ...args);

/** 读取要打进包里的应用文件（相对 ROOT）。 */
const APP_ENTRIES = ['src', 'assets', 'package.json'];

/**
 * 清理输出目录。
 * 里头的文件可能被编辑器锁着（Qoder 会锁 resources/default_app.asar），
 * 删不掉时降级为"覆盖式构建"——旧文件留着不影响，新解压会逐字节覆盖同名文件。
 */
function cleanOutDir(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return;
  } catch (error) {
    log('输出目录有文件被占用，改为覆盖构建：', error.code || error.message);
  }
  // 逐项删，能删的都删掉，锁住的那几个留到下次。
  if (!fs.existsSync(target)) return;
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const p = path.join(target, entry.name);
    if (entry.isDirectory()) cleanOutDir(p);
    else {
      try {
        fs.rmSync(p, { force: true });
      } catch {
        /* 被锁；同名文件会被覆盖写 */
      }
    }
  }
}

/** 递归复制目录。 */
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest);
    else if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(src), dest);
    else fs.copyFileSync(src, dest);
  }
}

function electronVersion() {
  return require(path.join(ROOT, 'node_modules/electron/package.json')).version;
}

/**
 * 找 electron 官方 zip。
 * 优先 Electron 下载缓存（@electron/get 的结构：Cache/<sha>/electron-v<ver>-win32-x64.zip）。
 */
function findElectronZip(version) {
  const fileName = `electron-v${version}-win32-x64.zip`;
  const cacheRoots = [
    path.join(process.env.LOCALAPPDATA || '', 'electron', 'Cache'),
    path.join(os.homedir(), '.cache', 'electron'),
  ];
  const found = [];
  for (const root of cacheRoots) {
    if (!root || !fs.existsSync(root)) continue;
    for (const dir of fs.readdirSync(root)) {
      const candidate = path.join(root, dir, fileName);
      if (fs.existsSync(candidate)) found.push(candidate);
    }
  }
  if (found.length === 0) {
    throw new Error(
      `找不到 ${fileName}。请先运行一次 \`pnpm install\`（会下载 Electron 运行时），或手动把该 zip 放进 ${cacheRoots[0]}`,
    );
  }
  // 取最大的那个（同一版本偶有多份，完整的那份更大）。
  found.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
  return found[0];
}

/**
 * 解压运行时 zip。
 *
 * 必须跳过 resources/default_app.asar：解压出来的它和缓存里的原件是硬链接，
 * 而 Qoder CN 编辑器会长期锁住这个文件（AGENTS.md 记录过），
 * 一旦链接存在，dist 目录就再也删不掉、也改名不了。跳过它就能保持目录可清理。
 */
const SKIP_ENTRIES = new Set(['resources/default_app.asar']);

function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const py = [
    '-c',
    [
      'import sys, zipfile',
      'skip = set(sys.argv[3].split(","))',
      'with zipfile.ZipFile(sys.argv[1]) as z:',
      '    for info in z.infolist():',
      '        name = info.filename.replace("\\\\", "/").lstrip("/")',
      '        if name in skip:',
      '            continue',
      '        z.extract(info, sys.argv[2])',
    ].join('\n'),
    zipPath,
    destDir,
    [...SKIP_ENTRIES].join(','),
  ];
  try {
    execFileSync('python', py, { stdio: 'inherit' });
  } catch (error) {
    throw new Error(
      `解压失败（需要 python 在 PATH 上，可用绝对路径）。原始错误：${error.message}`,
    );
  }
}

/**
 * 生成多尺寸 ICO。
 * 用 Python + Pillow：把 256x256 的 icon.png 缩成 16/24/32/48/64/128/256 塞进一个 .ico。
 */
function buildIco(pngPath, icoPath) {
  const py = [
    '-c',
    [
      'import sys',
      'from PIL import Image',
      'im = Image.open(sys.argv[1]).convert("RGBA")',
      'sizes = [(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)]',
      'im.save(sys.argv[2], format="ICO", sizes=sizes)',
    ].join('\n'),
    pngPath,
    icoPath,
  ];
  try {
    execFileSync('python', py, { stdio: 'inherit' });
  } catch (error) {
    throw new Error(
      `生成 ICO 失败（需要 Python + Pillow）。原始错误：${error.message}`,
    );
  }
}

/** 用 resedit 给 exe 打图标 + 版本信息。 */
function brandExecutable(exePath, icoPath, version) {
  const ResEdit = require('resedit');
  const { NtExecutable, NtExecutableResource } = ResEdit;
  const { IconFile } = ResEdit.Data;
  const { IconGroupEntry, VersionInfo } = ResEdit.Resource;

  const data = fs.readFileSync(exePath);
  const exe = NtExecutable.from(data, { ignoreCert: true });
  const res = NtExecutableResource.from(exe);

  // 图标：读取 ico 里的所有图，替换第一组图标资源。
  const iconFile = IconFile.from(fs.readFileSync(icoPath));
  const iconEntries = IconGroupEntry.fromEntries(res.entries);
  const groupId = iconEntries.length > 0 ? iconEntries[0].id : 1;
  const lang = iconEntries.length > 0 ? iconEntries[0].lang : 1033;
  IconGroupEntry.replaceIconsForResource(
    res.entries,
    groupId,
    lang,
    iconFile.icons.map((item) => item.data),
  );

  // 版本信息：写 ProductName / FileDescription / FileVersion 等。
  const [major, minor, patch] = String(version).split('.').map((n) => Number(n) || 0);
  const versionStrings = {
    CompanyName: 'dsh-winTools',
    FileDescription: 'Windows 启动器：热键唤起，搜索应用 / 文件 / 网页 / 剪贴板',
    FileVersion: version,
    InternalName: APP_NAME,
    OriginalFilename: APP_DIR_NAME,
    ProductName: APP_NAME,
    ProductVersion: version,
  };
  const viList = VersionInfo.fromEntries(res.entries);
  const vi = viList.length > 0 ? viList[0] : VersionInfo.createEmpty();
  vi.setStringValues({ lang, codepage: 1200 }, versionStrings);
  vi.fixedInfo.fileVersionMS = (major << 16) | minor;
  vi.fixedInfo.fileVersionLS = (patch << 16) | 0;
  vi.fixedInfo.productVersionMS = (major << 16) | minor;
  vi.fixedInfo.productVersionLS = (patch << 16) | 0;
  vi.fixedInfo.fileFlagsMask = 0x3f;
  vi.fixedInfo.fileFlags = 0;
  vi.fixedInfo.fileOS = 0x40004; // VOS_NT_WINDOWS32
  vi.fixedInfo.fileType = 1; // VFT_APP
  vi.outputToResourceEntries(res.entries);

  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
}

async function main() {
  const version = electronVersion();
  log('Electron 版本', version);
  const zipPath = findElectronZip(version);
  log('运行时 zip', zipPath, `${(fs.statSync(zipPath).size / 1048576).toFixed(1)} MB`);

  log('清理输出目录', path.relative(ROOT, OUT_DIR));
  cleanOutDir(OUT_DIR);
  log('解压运行时…');
  extractZip(zipPath, OUT_DIR);

  // 应用代码放到 resources/app/；Electron 会自动加载这里的 package.json main。
  const appDest = path.join(OUT_DIR, 'resources', 'app');
  cleanOutDir(appDest);
  fs.mkdirSync(appDest, { recursive: true });
  for (const entry of APP_ENTRIES) {
    const src = path.join(ROOT, entry);
    if (!fs.existsSync(src)) throw new Error(`缺少应用文件：${entry}`);
    const dest = path.join(appDest, entry);
    if (fs.statSync(src).isDirectory()) copyDir(src, dest);
    else fs.copyFileSync(src, dest);
  }

  // 运行时里带的默认应用占位不要：它和缓存原件是硬链接、常被编辑器锁住，
  // 上面解压时已跳过；若目录里残着旧的一份，尽量删，删不掉也无所谓——resources/app 优先。
  const defaultApp = path.join(OUT_DIR, 'resources', 'default_app.asar');
  if (fs.existsSync(defaultApp)) {
    try {
      fs.rmSync(defaultApp, { force: true });
    } catch {
      /* 留着不影响加载 */
    }
  }

  // 把 electron.exe 改名成 dsh-winTools.exe，并打图标 / 版本信息。
  const srcExe = path.join(OUT_DIR, 'electron.exe');
  const outExe = path.join(OUT_DIR, APP_DIR_NAME);
  if (!fs.existsSync(srcExe)) throw new Error('解压结果里没有 electron.exe');
  fs.renameSync(srcExe, outExe);

  const pkg = require(path.join(ROOT, 'package.json'));
  const icoPath = path.join(ROOT, 'tmp', 'app.ico');
  fs.mkdirSync(path.dirname(icoPath), { recursive: true });
  buildIco(path.join(ROOT, 'assets', 'icon.png'), icoPath);
  log('打包图标完成');
  brandExecutable(outExe, icoPath, pkg.version || '0.1.0');
  log('已写入图标与版本信息');

  log('完成：', path.join(OUT_DIR, APP_DIR_NAME));
  log('双击该 exe 即可启动；整个 dist 目录可拷贝到别处使用。');
}

main().catch((error) => {
  console.error('[pack] 失败：', error?.message ?? error);
  process.exitCode = 1;
});
