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

  app.quit();
}

module.exports = { run };
