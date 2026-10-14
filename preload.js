const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    toggleMax: () => ipcRenderer.send('win:toggleMax'),
    close: () => ipcRenderer.send('win:close'),
    isMaximized: () => ipcRenderer.invoke('win:isMaximized'),
    closePlayer: () => ipcRenderer.send('player:close'),
    selfMinimize: () => ipcRenderer.send('self:minimize'),
    selfClose: () => ipcRenderer.send('self:close'),
    setFullScreen: (v) => ipcRenderer.send('self:setFullScreen', v),
    isFullScreen: () => ipcRenderer.invoke('self:isFullScreen')
  },
  dialog: {
    chooseDir: (defaultPath) => ipcRenderer.invoke('dialog:chooseDir', defaultPath)
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch)
  },
  download: {
    add: (opts) => ipcRenderer.invoke('dl:add', opts),
    list: () => ipcRenderer.invoke('dl:list'),
    pause: (id) => ipcRenderer.invoke('dl:pause', id),
    resume: (id) => ipcRenderer.invoke('dl:resume', id),
    retry: (id) => ipcRenderer.invoke('dl:retry', id),
    remove: (id, deleteFiles) => ipcRenderer.invoke('dl:remove', { id, deleteFiles }),
    play: (id) => ipcRenderer.invoke('dl:play', id),
    focusPlayer: (id) => ipcRenderer.invoke('dl:focusPlayer', id),
    playerOpen: (id) => ipcRenderer.invoke('dl:playerOpen', id),
    openFolder: (id) => ipcRenderer.invoke('dl:openFolder', id),
    onUpdate: (cb) => ipcRenderer.on('dl:update', (_e, t) => cb(t)),
    onLog: (cb) => ipcRenderer.on('dl:log', (_e, l) => cb(l)),
    onPlayerClosed: (cb) => ipcRenderer.on('dl:playerClosed', (_e, id) => cb(id))
  },
  player: {
    readPlaylist: (f) => ipcRenderer.invoke('player:readPlaylist', f),
    segUrl: (p) => ipcRenderer.invoke('player:segUrl', p),
    segExists: (p) => ipcRenderer.invoke('player:segExists', p),
    join: (...parts) => ipcRenderer.invoke('player:join', ...parts),
    buildPreview: (payload) => ipcRenderer.invoke('player:buildPreview', payload)
  },
  merge: {
    scan: () => ipcRenderer.invoke('merge:scan'),
    start: (payload) => ipcRenderer.invoke('merge:start', payload),
    cancel: (id) => ipcRenderer.invoke('merge:cancel', id),
    list: () => ipcRenderer.invoke('merge:list'),
    pickSegDir: () => ipcRenderer.invoke('merge:pickSegDir'),
    pickSegFiles: () => ipcRenderer.invoke('merge:pickSegFiles'),
    open: (file) => ipcRenderer.invoke('merge:open', file),
    ffmpegInfo: () => ipcRenderer.invoke('merge:ffmpegInfo'),
    chooseFfmpeg: () => ipcRenderer.invoke('merge:chooseFfmpeg'),
    resetFfmpeg: () => ipcRenderer.invoke('merge:resetFfmpeg'),
    onUpdate: (cb) => ipcRenderer.on('merge:update', (_e, j) => cb(j))
  }
});
