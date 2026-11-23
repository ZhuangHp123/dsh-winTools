'use strict';

/**
 * 冒烟测试：用真实 Electron 跑一遍"唤起 → 输入 → 结果 → 执行"，
 * 把窗口截图存到 tmp/，然后退出。
 *
 * 只在 DSH_SMOKE=1 时由 main.js 加载。图形界面无法用 node --test 覆盖，
 * 这个脚本是它对"界面真的能画出来"的唯一证据。
 */

const fs = require('node:fs');
const path = require('node:path');

async function run({ app, win, query }) {
  const outDir = path.join(__dirname, '../../tmp');
  fs.mkdirSync(outDir, { recursive: true });

  const shot = async (name) => {
    // 窗口被 Esc 隐藏后 capturePage 会抛 UnknownVizError，截不到画面。
    if (!win.isVisible()) win.show();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, name), image.toPNG());
    console.log(`[smoke] 截图 ${name}`);
  };

  const type = async (value) => {
    await win.webContents.executeJavaScript(`
      (() => {
        const input = document.getElementById('query');
        input.value = ${JSON.stringify(value)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()
    `);
    await new Promise((resolve) => setTimeout(resolve, 1200));
  };

  const readRows = () =>
    win.webContents.executeJavaScript(`
      (() => {
        const rows = [...document.querySelectorAll('.row')];
        return {
          count: rows.length,
          rows: rows.map((row) => ({
            kind: row.querySelector('.kind-tag')?.textContent,
            avatar: row.querySelector('.row-avatar')?.textContent,
            // 真人头像是 <img src="data:...">，首字色块是纯文本
            avatarImage: Boolean(row.querySelector('.row-avatar img')?.src),
            // 应用/项目/文件的真实图标
            icon: Boolean(row.querySelector('.row-icon img')?.src),
            // 网页的收藏夹/标签页形状
            glyph: row.querySelector('.row-glyph')?.className ?? null,
            title: row.querySelector('.row-title')?.textContent,
            sub: row.querySelector('.row-sub')?.textContent,
            active: row.classList.contains('active'),
          })),
          status: document.getElementById('status-left')?.textContent,
          empty: document.getElementById('empty')?.hidden === false
            ? document.getElementById('empty').textContent
            : null,
          visible: document.visibilityState,
        };
      })()
    `);

  win.show();
  win.focus();
  await new Promise((resolve) => setTimeout(resolve, 800));
  await shot('smoke-empty.png');
  console.log('[smoke] 空查询', JSON.stringify(await readRows()));

  await type(query);
  await shot('smoke-query.png');
  console.log('[smoke] 查询', JSON.stringify(await readRows()));

  // 键盘导航：下移一格应换 active。
  await win.webContents.executeJavaScript(`
    (() => {
      const input = document.getElementById('query');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      return true;
    })()
  `);
  await new Promise((resolve) => setTimeout(resolve, 200));
  console.log('[smoke] 下移后', JSON.stringify(await readRows()));

  // 透明边不吃鼠标：指针在卡片外要切到穿透，回到卡片上要恢复。
  const probeMouse = async (label, x, y) => {
    await win.webContents.executeJavaScript(`
      (() => {
        const el = document.elementFromPoint(${x}, ${y}) || document.body;
        el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: ${x}, clientY: ${y} }));
        return true;
      })()
    `);
    await new Promise((r) => setTimeout(r, 300));
    const ignored = await win.webContents.executeJavaScript('document.body.dataset.mouseIgnored');
    console.log(`[smoke] 指针 ${label} → 穿透=${ignored}`);
  };
  await probeMouse('卡片上', 300, 60);
  await probeMouse('透明边', 4, 4);
  await probeMouse('回卡片', 300, 60);

  // Esc 清空后应收回紧凑态（只有输入框）。
  await win.webContents.executeJavaScript(`
    (() => {
      const input = document.getElementById('query');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return true;
    })()
  `);
  await new Promise((resolve) => setTimeout(resolve, 600));
  const compacted = await win.webContents.executeJavaScript(`
    ({
      compactClass: document.getElementById('launcher').classList.contains('compact'),
      height: window.outerHeight,
    })
  `);
  await shot('smoke-compact-again.png');
  console.log('[smoke] Esc 清空', JSON.stringify(compacted));

  // 锁定 provider 的语法。
  await type('文件 ' + query);
  await shot('smoke-scoped.png');
  console.log('[smoke] 锁定文件', JSON.stringify(await readRows()));

  // 项目 provider：只搜不执行（打开 IDE 会弹窗，不适合放进自动冒烟）。
  await type('项目 ' + (process.env.DSH_SMOKE_PROJECT || 'cfmoto'));
  await shot('smoke-project.png');
  console.log('[smoke] 锁定项目', JSON.stringify(await readRows()));

  // 网页 provider：同样只搜不执行（切换标签页会抢焦点）。
  await type('网页 ' + (process.env.DSH_SMOKE_WEB || 'cfmoto'));
  await shot('smoke-web.png');
  console.log('[smoke] 锁定网页', JSON.stringify(await readRows()));

  // 英文前缀：b 只出收藏夹，w 只出已打开标签页。
  await type('b ' + (process.env.DSH_SMOKE_WEB || 'cfmoto'));
  await shot('smoke-bookmarks.png');
  console.log('[smoke] 前缀 b(收藏夹)', JSON.stringify(await readRows()));

  await type('w ' + (process.env.DSH_SMOKE_WEB || 'cfmoto'));
  await shot('smoke-tabs.png');
  console.log('[smoke] 前缀 w(标签页)', JSON.stringify(await readRows()));

  // 钉钉：锁定搜索会走 MCP（可能触发 OAuth），冒烟里只验证界面能画出结果/状态。
  // 没登录时状态栏会给出原因，这本身也是要验证的一部分。
  await type('联系人 ' + (process.env.DSH_SMOKE_CONTACT || '张'));
  await shot('smoke-contact.png');
  console.log('[smoke] 锁定联系人', JSON.stringify(await readRows()));

  await type('文档 ' + (process.env.DSH_SMOKE_DOC || '需求'));
  await shot('smoke-doc.png');
  console.log('[smoke] 锁定文档', JSON.stringify(await readRows()));

  // 剪贴板：写入一段带唯一标记的文字，等轮询记录后再搜、再执行。
  const marker = `smoke-clip-${Date.now().toString(36)}`;
  const { clipboard } = require('electron');
  clipboard.writeText(marker);
  await new Promise((resolve) => setTimeout(resolve, 900));
  await type(marker);
  await shot('smoke-clipboard.png');
  const clipboardRows = await readRows();
  console.log('[smoke] 剪贴板', JSON.stringify(clipboardRows));

  const activateResult = await win.webContents.executeJavaScript(`
    (async () => {
      const row = document.querySelector('.row.active');
      if (!row) return { skipped: true };
      return await window.launcher.activate(row.dataset.id);
    })()
  `);
  console.log('[smoke] 执行剪贴板项', JSON.stringify(activateResult));

  // 状态：热键与索引状态要能从渲染进程读到。
  const statusResult = await win.webContents.executeJavaScript('window.launcher.status()');
  console.log('[smoke] 状态', JSON.stringify(statusResult));

  // 设置页：能打开、能列出全部范围、默认值提示非空。
  await win.webContents.executeJavaScript(`
    (() => { document.getElementById('open-settings').click(); return true; })()
  `);
  await new Promise((resolve) => setTimeout(resolve, 700));
  const settingsState = await win.webContents.executeJavaScript(`
    (() => {
      const panel = document.getElementById('settings');
      const rows = [...document.querySelectorAll('.settings-item')];
      return {
        open: !panel.hidden,
        classOn: document.getElementById('launcher').classList.contains('settings-open'),
        rows: rows.map((row) => ({
          scope: row.dataset.scope,
          value: row.querySelector('.settings-input')?.value ?? '',
          placeholder: row.querySelector('.settings-input')?.placeholder ?? '',
        })),
      };
    })()
  `);
  await shot('smoke-settings.png');
  console.log('[smoke] 设置页', JSON.stringify(settingsState));

  // 改一个前缀并保存：只动冒烟专用的 config.json，不碰真实配置。
  const saveResult = await win.webContents.executeJavaScript(
    `window.launcher.savePrefixes({ app: ['app', '软件'], bookmark: ['收藏', 'bm'] })`,
  );
  console.log('[smoke] 保存前缀', JSON.stringify({ ok: saveResult?.ok, saved: saveResult?.saved }));
  const afterSave = await win.webContents.executeJavaScript(
    `document.getElementById('empty').textContent`,
  );
  console.log('[smoke] 保存后提示', JSON.stringify(afterSave));

  app.quit();
}

module.exports = { run };
