'use strict';

/**
 * 预加载脚本。
 *
 * 渲染进程没有 Node 权限（contextIsolation + nodeIntegration:false），
 * 这里只暴露四个必要方法，全部走 IPC。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcher', {
  search: (input) => ipcRenderer.invoke('launcher:search', input),
  activate: (id) => ipcRenderer.invoke('launcher:activate', { id }),
  avatar: (id) => ipcRenderer.invoke('launcher:avatar', id),
  status: () => ipcRenderer.invoke('launcher:status'),
  setCompact: (payload) => ipcRenderer.invoke('launcher:setCompact', payload),
  // 窗口四周有一圈透明边（给投影留空间）；让那圈不拦截鼠标。
  setIgnoreMouse: (ignore) => ipcRenderer.send('launcher:setIgnoreMouse', Boolean(ignore)),  hide: () => ipcRenderer.invoke('launcher:hide'),
  reindex: () => ipcRenderer.invoke('launcher:reindex'),
  openExternal: (url) => ipcRenderer.invoke('launcher:openExternal', url),
  onShown: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('launcher:shown', handler);
    return () => ipcRenderer.removeListener('launcher:shown', handler);
  },
  onStatus: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on('launcher:status', handler);
    return () => ipcRenderer.removeListener('launcher:status', handler);
  },
});
