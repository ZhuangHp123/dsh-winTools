'use strict';

/**
 * 全局热键选择。
 *
 * Windows 上热键可能已被别的程序占用（本机 uTools 默认就是 Alt+Space），
 * 而 globalShortcut.register 只返回一个布尔值，没有"为什么失败"。
 * 所以策略是给一串候选，按顺序尝试，用第一个注册成功的。
 *
 * 纯函数 + 注入 register，方便单测覆盖"第一个被占用就换下一个"的行为。
 */

/** 默认候选链：优先最顺手的位置，逐步退让。 */
const DEFAULT_HOTKEYS = [
  'Alt+Space',
  'Alt+Shift+Space',
  'Ctrl+Shift+Space',
  'Alt+`',
];

/**
 * 依次尝试注册，返回第一个成功的加速键。
 * @param {string[]} candidates
 * @param {(accelerator:string)=>boolean} register 成功返回 true
 * @returns {string|null} 全被占用时返回 null（调用方要提示用户改配置）
 */
function resolveHotkey(candidates, register) {
  for (const accelerator of candidates) {
    if (!accelerator) continue;
    try {
      if (register(accelerator)) return accelerator;
    } catch {
      // 格式非法等情况：继续试下一个，不要让启动流程中断。
    }
  }
  return null;
}

/**
 * 从配置里取热键候选：配置优先，其次环境变量，最后默认链。
 * @param {{hotkey?:string}|null} config
 * @param {object} [env]
 * @returns {string[]}
 */
function hotkeyCandidates(config, env = process.env) {
  const out = [];
  if (config && typeof config.hotkey === 'string' && config.hotkey.trim()) {
    out.push(config.hotkey.trim());
  }
  if (typeof env.DSH_HOTKEY === 'string' && env.DSH_HOTKEY.trim()) {
    out.push(env.DSH_HOTKEY.trim());
  }
  for (const accelerator of DEFAULT_HOTKEYS) {
    if (!out.includes(accelerator)) out.push(accelerator);
  }
  return out;
}

module.exports = { DEFAULT_HOTKEYS, resolveHotkey, hotkeyCandidates };
