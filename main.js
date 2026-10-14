const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const DownloadManager = require('./src/downloadManager');
const Merger = require('./src/merger');
const Store = require('./src/store');
const { registerSegProtocol } = require('./src/protocols');

// Windows 任务栏/通知身份与打包后 exe 名保持一致
app.setAppUserModelId('com.m3u8down.app');
app.setName('M3u8Down');

let mainWindow;
const dataArg = process.argv.find((a) => a.startsWith('--data-dir='));
if (dataArg) {
  let p = dataArg.split('=').slice(1).join('=');
  if (!path.isAbsolute(p)) p = path.join(__dirname, p);
  app.setPath('userData', p);
}
const userDataDir = () => app.getPath('userData');
const defaultRoot = path.join(userDataDir(), 'downloads');

// 窗口图标（开发环境用源码 ico；打包后由 exe 图标承载，找不到则忽略）
const devIcon = path.join(__dirname, 'build', 'icon.ico');
const appIcon = fs.existsSync(devIcon) ? devIcon : undefined;

if (!fs.existsSync(defaultRoot)) fs.mkdirSync(defaultRoot, { recursive: true });

const store = new Store(userDataDir());
const manager = new DownloadManager(defaultRoot, store);
const merger = new Merger(defaultRoot);

// taskId -> 播放窗口
const playWindows = new Map();

/** 独立唤回/前置某个窗口：恢复最小化、显示、聚焦，不影响其它窗口 */
function focusWindow(w) {
  if (!w || w.isDestroyed()) return;
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
}

// 恢复持久化的自定义 ffmpeg 路径
const savedFfmpeg = store.getSettings().ffmpegPath;
if (savedFfmpeg) merger.setFfmpegPath(savedFfmpeg);

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

manager.on('update', (task) => send('dl:update', task));
manager.on('log', (line) => send('dl:log', line));
merger.on('update', (job) => send('merge:update', job));

// 下载完成自动合并
manager.on('autoMerge', async (task) => {
  try {
    manager.setMerged(task.id, false, task.mp4File || '', '下载完成，自动合并中…');
    const job = await merger.start({
      taskId: task.id,
      workDir: task.workDir,
      segDir: task.segDir,
      name: task.name,
      total: task.total,
      outputDir: task.outputDir || '',
      outputName: task.outputName || ''
    });
    if (job.status === 'completed') {
      manager.setMerged(task.id, true, job.output, '已自动合并为 MP4');
    } else if (job.status === 'canceled') {
      manager.setMerged(task.id, false, '', '自动合并已取消');
    } else {
      manager.setMerged(task.id, false, '', '自动合并失败：' + (job.message || ''));
    }
  } catch (err) {
    manager.setMerged(task.id, false, '', '自动合并失败：' + (err.message || err));
  }
});

// 合并进度同步到下载任务提示
merger.on('update', (job) => {
  if (job.taskId && job.status === 'running') {
    const t = manager.getTask(job.taskId);
    if (t && t.autoMerge) t.message = `自动合并中 ${job.percent || 0}%`;
  }
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 900,
    minHeight: 620,
    frame: false,
    backgroundColor: '#f4f6fa',
    title: 'M3U8 下载器',
    icon: appIcon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  registerSegProtocol();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  manager.dispose();
  if (process.platform !== 'darwin') app.quit();
});

/* ---------------- IPC: 窗口控制 ---------------- */

ipcMain.on('win:minimize', () => mainWindow && mainWindow.minimize());
ipcMain.on('win:toggleMax', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('win:close', () => mainWindow && mainWindow.close());
ipcMain.handle('win:isMaximized', () => !!(mainWindow && mainWindow.isMaximized()));

/* 针对“发送消息的窗口自身”的控制（用于独立播放窗口，不影响主窗口） */
ipcMain.on('self:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
ipcMain.on('self:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close());
ipcMain.on('self:setFullScreen', (e, val) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w) w.setFullScreen(!!val);
});
ipcMain.handle('self:isFullScreen', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  return w ? w.isFullScreen() : false;
});

/* ---------------- IPC: 通用目录选择 ---------------- */

ipcMain.handle('dialog:chooseDir', async (_e, defaultPath) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: defaultPath || app.getPath('videos')
  });
  if (res.canceled || !res.filePaths[0]) return null;
  return res.filePaths[0];
});

/* ---------------- IPC: 应用设置持久化 ---------------- */

ipcMain.handle('settings:get', () => store.getSettings());
ipcMain.handle('settings:set', (_e, patch) => store.updateSettings(patch || {}));

/* ---------------- IPC: 下载 ---------------- */

ipcMain.handle('dl:add', async (_e, opts) => manager.addTask(opts));
ipcMain.handle('dl:list', () => manager.listTasks());
ipcMain.handle('dl:pause', (_e, id) => manager.pauseTask(id));
ipcMain.handle('dl:resume', (_e, id) => manager.resumeTask(id));
ipcMain.handle('dl:retry', (_e, id) => manager.retryTask(id));
ipcMain.handle('dl:remove', async (_e, { id, deleteFiles }) => {
  const r = await manager.removeTask(id, !!deleteFiles);
  const pw = playWindows.get(id);
  if (pw && !pw.isDestroyed()) pw.close();
  playWindows.delete(id);
  return r;
});

ipcMain.handle('dl:play', async (_e, id) => {
  const task = manager.getTask(id);
  if (!task) return { ok: false, error: '任务不存在' };
  const segs = fs.existsSync(task.segDir)
    ? fs.readdirSync(task.segDir).filter((f) => f.endsWith('.ts')).sort()
        .map((f) => path.join(task.segDir, f))
    : [];
  if (!segs.length && !task.mp4File) {
    return { ok: false, error: '还没有可播放的内容，请先下载分片' };
  }

  // 已存在该任务的播放窗口：直接独立唤回（恢复最小化 + 前置聚焦）
  const existing = playWindows.get(id);
  if (existing && !existing.isDestroyed()) {
    focusWindow(existing);
    return { ok: true, reopened: true };
  }

  const playWin = new BrowserWindow({
    width: 900,
    height: 600,
    frame: false,
    title: `播放 - ${task.name}`,
    icon: appIcon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true
    }
  });
  playWin.setMenuBarVisibility(false);
  playWindows.set(id, playWin);
  playWin.on('closed', () => {
    playWindows.delete(id);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('dl:playerClosed', id);
    }
  });

  // 优先播放已合并 MP4
  const mp4 = (task.mp4File && fs.existsSync(task.mp4File)) ? task.mp4File : '';
  await playWin.loadFile(path.join(__dirname, 'renderer', 'player.html'), {
    query: {
      taskId: id,
      name: task.name,
      mp4,
      workDir: task.workDir,
      segCount: String(segs.length)
    }
  });
  focusWindow(playWin);
  return { ok: true };
});

/* 独立唤回指定任务的播放窗口（不影响主窗口） */
ipcMain.handle('dl:focusPlayer', (_e, id) => {
  const w = playWindows.get(id);
  if (!w || w.isDestroyed()) return { ok: false };
  focusWindow(w);
  return { ok: true };
});

ipcMain.handle('dl:playerOpen', (_e, id) => {
  const w = playWindows.get(id);
  return !!(w && !w.isDestroyed() && w.isVisible());
});

/* 播放器请求：基于当前已下载分片生成临时预览 MP4 */
ipcMain.handle('player:buildPreview', async (_e, { workDir, segCount }) => {
  // 找到任务
  let segDir = null;
  for (const t of manager.listTasks()) {
    if (t.workDir === workDir) { segDir = t.segDir; break; }
  }
  if (!segDir) return { ok: false, error: '任务不存在' };
  const segs = fs.readdirSync(segDir).filter((f) => f.endsWith('.ts')).sort()
    .map((f) => path.join(segDir, f));
  if (!segs.length) return { ok: false, error: '暂无可播放分片' };
  const outFile = path.join(workDir, 'preview.mp4');
  const r = await merger.buildPreviewMp4(segs, outFile);
  return r;
});

ipcMain.handle('dl:openFolder', (_e, id) => {
  const task = manager.getTask(id);
  if (task && fs.existsSync(task.workDir)) shell.openPath(task.workDir);
});

ipcMain.handle('player:readPlaylist', (_e, file) => {
  try {
    return { ok: true, text: fs.readFileSync(file, 'utf8') };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('player:segUrl', (_e, segAbs) => 'seg://file?path=' + encodeURIComponent(segAbs));
ipcMain.handle('player:segExists', (_e, segAbs) => fs.existsSync(segAbs));
ipcMain.handle('player:join', (_e, ...parts) => path.join(...parts));
ipcMain.on('player:close', (e) => e.sender.close && BrowserWindow.fromWebContents(e.sender)?.close());

/* ---------------- IPC: 合并 ---------------- */

ipcMain.handle('merge:scan', () => merger.scanTasks(manager));
ipcMain.handle('merge:start', (_e, payload) => merger.start(payload));
ipcMain.handle('merge:cancel', (_e, id) => merger.cancel(id));
ipcMain.handle('merge:list', () => merger.listJobs());

/* 选择一个 TS 片段目录，返回其中的 .ts 文件绝对路径列表 */
ipcMain.handle('merge:pickSegDir', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '选择包含 .ts 分片的目录',
    properties: ['openDirectory']
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const dir = res.filePaths[0];
  const files = merger.listSegs(dir);
  return { dir, files, count: files.length };
});

/* 也支持直接多选 .ts 文件 */
ipcMain.handle('merge:pickSegFiles', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '选择需要合并的 .ts 分片（可多选，按文件名顺序合并）',
    filters: [{ name: 'TS 分片', extensions: ['ts'] }],
    properties: ['openFile', 'multiSelections']
  });
  if (res.canceled || !res.filePaths.length) return null;
  const files = res.filePaths.slice().sort();
  return { dir: path.dirname(files[0]), files, count: files.length };
});

ipcMain.handle('merge:open', (_e, file) => {
  if (file && fs.existsSync(file)) shell.showItemInFolder(file);
});
ipcMain.handle('merge:ffmpegInfo', async () => {
  // 仅返回可用性与是否为自定义，不暴露具体目录
  const exe = await merger._probeFfmpeg();
  const settings = store.getSettings();
  return { available: !!exe, custom: !!settings.ffmpegPath };
});
ipcMain.handle('merge:chooseFfmpeg', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '选择 ffmpeg 可执行文件',
    filters: [{ name: 'ffmpeg', extensions: ['exe'] }],
    properties: ['openFile']
  });
  if (res.canceled || !res.filePaths[0]) return null;
  merger.setFfmpegPath(res.filePaths[0]);
  store.updateSettings({ ffmpegPath: res.filePaths[0] });
  return { ok: true };
});
ipcMain.handle('merge:resetFfmpeg', async () => {
  merger.setFfmpegPath(null);
  store.updateSettings({ ffmpegPath: '' });
  const exe = await merger._probeFfmpeg();
  return { ok: !!exe };
});
