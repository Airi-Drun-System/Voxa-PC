'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// окну доступны только эти каналы, никакого прямого доступа к файлам и Node
const CALLS = ['account:get', 'account:login', 'account:logout', 'horizon:status', 'horizon:install', 'horizon:launch', 'horizon:open', 'horizon:page', 'instances:copy', 'instances:update', 'instances:openSub', 'instances:worlds', 'content:list', 'content:toggle', 'content:remove', 'content:install', 'mods:updates', 'mods:updateAll', 'packs:import', 'game:stop', 'settings:get', 'settings:set', 'versions:list', 'instances:list', 'instances:create', 'instances:delete', 'instances:open', 'game:launch', 'mods:search', 'packs:install', 'skin:get', 'skin:pick', 'skin:reset'];

contextBridge.exposeInMainWorld('voxa', {
  call: (channel, ...args) => (CALLS.includes(channel) ? ipcRenderer.invoke(channel, ...args) : Promise.reject(new Error('channel'))),
  onProgress: (cb) => ipcRenderer.on('progress', (_e, p) => cb(p)),
  onLog: (cb) => ipcRenderer.on('log', (_e, line) => cb(line))
});
