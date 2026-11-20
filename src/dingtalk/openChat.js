'use strict';

/**
 * 用钉钉客户端自己的全局搜索打开单聊。
 *
 * 为什么不用 deep link：`page/singleconversation?uid=` 要的是钉钉全局数字 uid
 * （客户端二进制里的样例是 `uid=5639198466`），而官方 MCP 网关只给组织内 userId
 * （`CFDL32315`）和 openDingTalkId，两种都不是它要的格式——实测发下去只会把右侧
 * 会话区刷成空白。网关上也没有"打开会话"类工具（group 服务只有一个建群接口）。
 *
 * 剩下的唯一入口就是客户端自己的搜索面板：点顶部搜索框 → 粘贴姓名 → 回车。
 * 面板底部提示 `⏎ 确认结果`，实测综合页输入完直接回车就会落到第一行的会话，
 * 不需要按坐标去点结果行（点行也验证过，但坐标随窗口尺寸/DPI 变，太脆）。
 *
 * 姓名用 base64 传进 PowerShell 再解码，避免把用户输入拼进脚本导致注入。
 */

const { execFile } = require('node:child_process');

/** 钉钉主窗口类名（多开时取第一个可见的）。 */
const WINDOW_CLASS = 'StandardFrame_DingTalk';

/** 顶部搜索框在客户区的位置：横向居中、纵向固定 20px。 */
const SEARCH_BOX = { xRatio: 0.5, y: 20 };

/** 等搜索结果出来的时间；回车后再等会话渲染。 */
const RESULT_WAIT_MS = 1800;
const SETTLE_WAIT_MS = 1000;

const NATIVE_CODE = `
using System;
using System.Text;
using System.Runtime.InteropServices;
public class DshDingWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int x, int y, uint d, UIntPtr e);
  public struct POINT { public int X, Y; }
  public struct RECT { public int Left, Top, Right, Bottom; }
}
`;

/**
 * 生成打开单聊的脚本。
 * @param {string} name 联系人姓名（会 base64 后在脚本内解码）
 * @param {object} [options]
 */
function buildOpenChatScript(name, options = {}) {
  const payload = Buffer.from(String(name), 'utf8').toString('base64');
  const resultWait = options.resultWaitMs ?? RESULT_WAIT_MS;
  const settleWait = options.settleWaitMs ?? SETTLE_WAIT_MS;
  return `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type '${NATIVE_CODE.replace(/'/g, "''")}'
$name = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))
$pids = @(Get-Process DingTalk -ErrorAction SilentlyContinue | ForEach-Object { [int]$_.Id })
if ($pids.Count -eq 0) { Write-Output '{"ok":false,"reason":"not-running"}'; exit 0 }
$found = [IntPtr]::Zero
$cb = [DshDingWin+EnumProc]{ param($h,$l)
  $p = 0
  [void][DshDingWin]::GetWindowThreadProcessId($h,[ref]$p)
  if ($pids -contains [int]$p) {
    $cn = New-Object System.Text.StringBuilder 256
    [void][DshDingWin]::GetClassNameW($h,$cn,256)
    if ($cn.ToString() -eq '${WINDOW_CLASS}') { $script:found = $h; return $false }
  }
  return $true
}
[void][DshDingWin]::EnumWindows($cb,[IntPtr]::Zero)
if ($found -eq [IntPtr]::Zero) { Write-Output '{"ok":false,"reason":"no-window"}'; exit 0 }

# 跨进程抢前台会被 Windows 的焦点窃取保护挡掉，临时共享输入队列才能成功。
[void][DshDingWin]::ShowWindow($found, 9)
$fg = [DshDingWin]::GetForegroundWindow()
$fgT = [DshDingWin]::GetWindowThreadProcessId($fg,[IntPtr]::Zero)
$tgT = [DshDingWin]::GetWindowThreadProcessId($found,[IntPtr]::Zero)
$myT = [DshDingWin]::GetCurrentThreadId()
[void][DshDingWin]::AttachThreadInput($myT,$tgT,$true)
[void][DshDingWin]::AttachThreadInput($myT,$fgT,$true)
[void][DshDingWin]::SetForegroundWindow($found)
[void][DshDingWin]::AttachThreadInput($myT,$fgT,$false)
[void][DshDingWin]::AttachThreadInput($myT,$tgT,$false)
Start-Sleep -Milliseconds 350
if ([DshDingWin]::GetForegroundWindow() -ne $found) {
  Write-Output '{"ok":false,"reason":"focus-denied"}'
  exit 0
}

$rect = New-Object DshDingWin+RECT
[void][DshDingWin]::GetWindowRect($found,[ref]$rect)
$pt = New-Object DshDingWin+POINT
$pt.X = [int](($rect.Right - $rect.Left) * ${SEARCH_BOX.xRatio})
$pt.Y = ${SEARCH_BOX.y}
[void][DshDingWin]::ClientToScreen($found,[ref]$pt)
[void][DshDingWin]::SetCursorPos($pt.X,$pt.Y)
Start-Sleep -Milliseconds 120
[DshDingWin]::mouse_event(0x0002,0,0,0,[UIntPtr]::Zero)
Start-Sleep -Milliseconds 50
[DshDingWin]::mouse_event(0x0004,0,0,0,[UIntPtr]::Zero)
Start-Sleep -Milliseconds 500

$prev = $null
try { $prev = Get-Clipboard } catch {}
Set-Clipboard -Value $name
[System.Windows.Forms.SendKeys]::SendWait('^a')
Start-Sleep -Milliseconds 60
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds ${resultWait}
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Start-Sleep -Milliseconds ${settleWait}
if ($null -ne $prev) { try { Set-Clipboard -Value $prev } catch {} }
Write-Output '{"ok":true}'
`;
}

/** 默认 PowerShell 执行器：优先 pwsh（7.x），没有就退到 Windows PowerShell。 */
function defaultRunPowerShell(script, timeout) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const attempt = (exe) =>
    new Promise((resolve, reject) => {
      execFile(
        exe,
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout);
        },
      );
    });
  return attempt('pwsh').catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
    return attempt('powershell.exe');
  });
}

const REASONS = {
  'not-running': '钉钉没有在运行',
  'no-window': '找不到钉钉主窗口（可能未登录或缩到了托盘）',
  'focus-denied': '钉钉窗口抢不到前台焦点，请手动点一下钉钉再试',
};

/**
 * 用单聊 cid 一步跳到会话：`page/conversation?cid=<小uid>:<大uid>`。
 * 客户端自己处理"拉起窗口 + 切会话"，实测 150ms 落地，不经过搜索面板。
 * cid 从本地库取（localIndex.js），拿不到时才退回上面的搜索面板流程。
 *
 * @param {object} [options]
 * @param {(uri:string)=>Promise<void>} [options.openUri] 测试注入；默认交给系统协议处理器
 */
function createCidOpener(options = {}) {
  // electron 只在主进程里有；单测跑在纯 node 下，所以延迟 require。
  const openUri = options.openUri ?? ((uri) => require('electron').shell.openExternal(uri));
  return async function openByUid(cid) {
    const value = String(cid ?? '').trim();
    if (!value) return { ok: false, message: '缺少会话 cid' };
    try {
      await openUri(`dingtalk://dingtalkclient/page/conversation?cid=${value}`);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: `打开钉钉聊天失败：${error?.message ?? error}` };
    }
  };
}

/**
 * @param {object} [options]
 * @param {(script:string, timeout:number)=>Promise<string>} [options.runPowerShell] 测试注入
 * @param {number} [options.timeout]
 */
function createChatOpener(options = {}) {
  const run = options.runPowerShell ?? defaultRunPowerShell;
  const timeout = options.timeout ?? 15000;

  return async function openSingleChat(name) {
    const text = String(name ?? '').trim();
    if (!text) return { ok: false, message: '缺少姓名，无法打开聊天' };
    let stdout;
    try {
      stdout = await run(buildOpenChatScript(text), timeout);
    } catch (error) {
      return { ok: false, message: `打开钉钉聊天失败：${error?.message ?? error}` };
    }
    const line = String(stdout ?? '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .pop();
    let parsed = null;
    try {
      parsed = JSON.parse(line);
    } catch {
      /* 落到下面的兜底 */
    }
    if (parsed?.ok) return { ok: true };
    const reason = parsed?.reason;
    return { ok: false, message: REASONS[reason] ?? `打开钉钉聊天失败：${line || '脚本没有输出结果'}` };
  };
}

module.exports = { createChatOpener, createCidOpener, buildOpenChatScript, WINDOW_CLASS, SEARCH_BOX };
