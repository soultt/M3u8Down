/* 播放策略（Chromium 对 MPEG-TS 的 MSE 支持不稳定，统一走 MP4）：
 * 1. 若任务已合并出 MP4，直接播放该 MP4；
 * 2. 否则调用主进程，用内嵌 ffmpeg 把当前已下载的 TS 分片快速 remux 成临时 preview.mp4 播放。
 *    下载中可点「刷新到最新进度」重新生成。
 */
const video = document.getElementById('v');
const statusEl = document.getElementById('status');
const tipEl = document.getElementById('tip');
const refreshBtn = document.getElementById('refresh');

const params = new URLSearchParams(location.search);
const titleName = params.get('name') || '播放';
const mp4Path = params.get('mp4') || '';
const workDir = params.get('workDir') || '';
const segCount = parseInt(params.get('segCount') || '0', 10);
document.title = '播放 - ' + titleName;
document.getElementById('ptitle').textContent = '播放 - ' + titleName;

/* —— 窗口控制：只作用于播放窗口自身，不影响主窗口 —— */
document.getElementById('pclose').addEventListener('click', () => window.api.win.selfClose());
document.getElementById('pmin').addEventListener('click', () => window.api.win.selfMinimize());

async function toggleFullscreen() {
  const isFs = await window.api.win.isFullScreen();
  window.api.win.setFullScreen(!isFs);
  document.getElementById('fullscreen').textContent = isFs ? '全屏' : '退出全屏';
}
document.getElementById('pfull').addEventListener('click', toggleFullscreen);
document.getElementById('fullscreen').addEventListener('click', toggleFullscreen);
// 双击视频切换全屏
video.addEventListener('dblclick', toggleFullscreen);
// F 键全屏、Esc 由系统处理退出；轮询同步按钮文案
setInterval(async () => {
  try {
    const fs = await window.api.win.isFullScreen();
    document.getElementById('fullscreen').textContent = fs ? '退出全屏' : '全屏';
  } catch (_) {}
}, 600);

function setStatus(s) { statusEl.textContent = s; }

async function playFile(abs) {
  const u = await window.api.player.segUrl(abs);
  video.src = u;
  video.load();
  try { await video.play(); } catch (_) {}
}

async function playMp4Direct() {
  setStatus('加载已合并 MP4…');
  await playFile(mp4Path);
  setStatus('正在播放 MP4');
  tipEl.textContent = '';
  refreshBtn.style.display = 'none';
}

async function buildAndPlay() {
  refreshBtn.disabled = true;
  setStatus('正在生成可播放预览（合并已下载分片）…');
  const r = await window.api.player.buildPreview({ workDir, segCount });
  refreshBtn.disabled = false;
  if (r && r.ok) {
    await playFile(r.file);
    setStatus('播放中（当前已下载进度）');
    tipEl.textContent = '下载有更新后，可点右上角“刷新到最新进度”重新加载';
  } else {
    setStatus('无法播放：' + (r && r.error ? r.error : '未知错误'));
    tipEl.textContent = '请等待更多分片下载完成后重试，或在合并页生成 MP4。';
  }
}

refreshBtn.addEventListener('click', async () => {
  // 重新读取分片数后重建
  refreshBtn.disabled = true;
  setStatus('正在刷新到最新进度…');
  const r = await window.api.player.buildPreview({ workDir, segCount: 999999 });
  refreshBtn.disabled = false;
  if (r && r.ok) {
    await playFile(r.file + '?t=' + Date.now());
    setStatus('已刷新到最新进度');
  } else {
    setStatus('刷新失败：' + (r && r.error ? r.error : ''));
  }
});

video.addEventListener('error', () => {
  if (video.src) setStatus('视频解码失败，可能分片尚未下完整');
});

(async function init() {
  if (mp4Path) return playMp4Direct();
  refreshBtn.style.display = '';
  await buildAndPlay();
})();
