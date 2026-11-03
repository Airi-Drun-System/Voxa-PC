'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// окну доступны только эти каналы, никакого прямого доступа к файлам и Node
const CALLS = ['settings:get', 'settings:set', 'versions:list', 'instances:list', 'instances:create', 'instances:delete', 'instances:open', 'game:launch', 'mods:search', 'mods:install', 'mods:remove', 'packs:install', 'skin:get', 'skin:pick', 'skin:reset'];

contextBridge.exposeInMainWorld('voxa', {
  call: (channel, ...args) => (CALLS.includes(channel) ? ipcRenderer.invoke(channel, ...args) : Promise.reject(new Error('channel'))),
  onProgress: (cb) => ipcRenderer.on('progress', (_e, p) => cb(p))
});
