const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

/* ================= 窗口控制 ================= */
$('#win-min').addEventListener('click', () => window.api.win.minimize());
$('#win-max').addEventListener('click', () => window.api.win.toggleMax());
$('#win-close').addEventListener('click', () => window.api.win.close());

/* ================= Tabs ================= */
function switchTab(tab) {
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.page').forEach((p) => p.classList.remove('active'));
  const page = $('#page-' + tab);
  if (page) page.classList.add('active');
  if (tab === 'merge') loadMergePage().catch((e) => console.error('merge page error', e));
  if (tab === 'settings') loadSettingsPage().catch((e) => console.error('settings page error', e));
}
$$('.tab').forEach((btn) => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

/* ================= 工具 ================= */
function fmtSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
const statusText = {
  parsing: '解析中', downloading: '下载中', paused: '已暂停',
  completed: '已完成', error: '失败'
};

/* ================= 新增下载弹窗 ================= */
const modal = $('#modal-mask');
const modalError = $('#modal-error');
const autoBox = $('#auto-merge-box');

$('#in-automerge').addEventListener('change', (e) => {
  autoBox.classList.toggle('hidden', !e.target.checked);
});

function openModal() {
  modalError.classList.add('hidden');
  modalError.textContent = '';
  // 每次打开恢复上次设置（URL/名称仍清空）
  window.api.settings.get().then((s) => {
    if (s.saveDir) $('#in-savedir').value = s.saveDir;
    if (s.outputDir) $('#in-outdir').value = s.outputDir;
    if (s.concurrency) $('#in-conc').value = s.concurrency;
    $('#in-automerge').checked = s.autoMerge !== false;
    autoBox.classList.toggle('hidden', !$('#in-automerge').checked);
  });
  modal.classList.remove('hidden');
  setTimeout(() => $('#in-url').focus(), 50);
}
function closeModal() { modal.classList.add('hidden'); }

$('#btn-add-open').addEventListener('click', openModal);
$('#modal-x').addEventListener('click', closeModal);
$('#modal-cancel').addEventListener('click', closeModal);
modal.addEventListener('mousedown', (e) => { if (e.target === modal) closeModal(); });

$('#btn-choose-savedir').addEventListener('click', async () => {
  const dir = await window.api.dialog.chooseDir($('#in-savedir').value || null);
  if (dir) $('#in-savedir').value = dir;
});
$('#btn-choose-outdir').addEventListener('click', async () => {
  const dir = await window.api.dialog.chooseDir($('#in-outdir').value || null);
  if (dir) $('#in-outdir').value = dir;
});

$('#modal-ok').addEventListener('click', async () => {
  const url = $('#in-url').value.trim();
  const name = $('#in-name').value.trim();
  const concurrency = parseInt($('#in-conc').value, 10) || 8;
  const saveDir = $('#in-savedir').value.trim();
  const autoMerge = $('#in-automerge').checked;
  const outputDir = $('#in-outdir').value.trim();
  const outputName = $('#in-outname').value.trim();

  modalError.classList.add('hidden');
  if (!url) return showModalErr('请输入 M3U8 地址');
  if (!/^https?:\/\//i.test(url)) return showModalErr('地址必须以 http:// 或 https:// 开头');

  const btn = $('#modal-ok');
  btn.disabled = true;
  btn.textContent = '提交中…';
  try {
    // 持久化用户设置（目录、线程、自动合并偏好）
    window.api.settings.set({ saveDir, outputDir, concurrency, autoMerge });
    await window.api.download.add({ url, name, concurrency, saveDir, autoMerge, outputDir, outputName });
    closeModal();
    $('#in-url').value = ''; $('#in-name').value = ''; $('#in-outname').value = '';
  } catch (err) {
    showModalErr('添加失败：' + (err.message || err));
  } finally {
    btn.disabled = false;
    btn.textContent = '开始下载';
  }
});
function showModalErr(msg) {
  modalError.textContent = msg;
  modalError.classList.remove('hidden');
}
$('#in-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#modal-ok').click(); });

/* ================= 删除确认弹窗 ================= */
const confirmMask = $('#confirm-mask');
const confirmName = $('#confirm-name');
const confirmCheck = $('#confirm-delete-files');
const confirmTip = $('#confirm-tip');
let confirmResolve = null;

function openDeleteConfirm(task) {
  confirmName.textContent = (task && task.name) || '';
  confirmCheck.checked = false;
  confirmTip.textContent = '不勾选则仅从列表移除，文件会保留在磁盘中。';
  confirmTip.style.color = '#9ca3af';
  confirmMask.classList.remove('hidden');
  return new Promise((resolve) => { confirmResolve = resolve; });
}
function closeConfirm(result) {
  confirmMask.classList.add('hidden');
  if (confirmResolve) { confirmResolve(result); confirmResolve = null; }
}
$('#confirm-cancel').addEventListener('click', () => closeConfirm(null));
confirmMask.addEventListener('mousedown', (e) => { if (e.target === confirmMask) closeConfirm(null); });
$('#confirm-ok').addEventListener('click', () => closeConfirm({ deleteFiles: confirmCheck.checked }));
confirmCheck.addEventListener('change', () => {
  if (confirmCheck.checked) {
    confirmTip.textContent = '将同时删除该任务的分片目录及已生成的 MP4，操作不可恢复。';
    confirmTip.style.color = '#dc2626';
  } else {
    confirmTip.textContent = '不勾选则仅从列表移除，文件会保留在磁盘中。';
    confirmTip.style.color = '#9ca3af';
  }
});

/* ================= 下载列表（事件委托，按钮始终可用） ================= */
const taskMap = new Map();
const openPlayers = new Set();   // 当前已打开（含最小化）播放窗口的任务 id

window.api.download.onPlayerClosed?.((id) => {
  if (!id) return;
  openPlayers.delete(id);
  const t = taskMap.get(id);
  if (t) renderTask(t);
});

function refreshEmpty() {
  const has = $('#dl-list').children.length > 0;
  $('#dl-empty').style.display = has ? 'none' : 'block';
  const tasks = [...taskMap.values()];
  const active = tasks.filter((t) => t.status === 'downloading' || t.status === 'parsing').length;
  $('#dl-summary').textContent = tasks.length ? `共 ${tasks.length} 个任务 · ${active} 个进行中` : '';
}

function renderTask(t) {
  taskMap.set(t.id, t);
  let el = document.getElementById('dl-' + t.id);
  if (!el) {
    el = document.createElement('div');
    el.id = 'dl-' + t.id;
    el.className = 'dl-card';
    $('#dl-list').appendChild(el);
  }
  const canPause = t.status === 'downloading' || t.status === 'parsing';
  const canResume = t.status === 'paused' || t.status === 'error';
  const canRepair = t.status === 'completed' && !t.merged;
  const mergedBadge = t.merged ? '<span class="dl-status completed">已合并MP4</span>' : '';
  const playLabel = openPlayers.has(t.id) ? '唤回播放' : '▶ 播放';
  el.innerHTML = `
    <div class="dl-top">
      <span class="dl-name" title="${escapeHtml(t.name)}">${escapeHtml(t.name)}</span>
      <span class="dl-status ${t.status}">${statusText[t.status] || t.status}</span>
      ${mergedBadge}
      <span class="dl-url" title="${escapeHtml(t.url)}">${escapeHtml(t.url)}</span>
      <div class="dl-actions">
        <button class="btn sm" data-act="play" ${(t.done || 0) < 1 ? 'disabled' : ''}>${playLabel}</button>
        ${canPause ? '<button class="btn sm" data-act="pause">暂停</button>' : ''}
        ${canResume ? '<button class="btn sm" data-act="resume">继续</button>' : ''}
        ${canRepair ? '<button class="btn sm" data-act="repair">重新校验并合并</button>' : ''}
        ${t.mp4File ? '<button class="btn sm" data-act="openmp4">打开MP4</button>' : ''}
        <button class="btn sm" data-act="folder">目录</button>
        <button class="btn sm danger" data-act="del">删除</button>
      </div>
    </div>
    <div class="dl-save" title="${escapeHtml(t.workDir)}">分片目录：${escapeHtml(t.workDir)}</div>
    ${t.mp4File ? `<div class="dl-save" title="${escapeHtml(t.mp4File)}">MP4：${escapeHtml(t.mp4File)}</div>` : ''}
    <div class="progress-wrap">
      <div class="progress ${t.status}"><div style="width:${t.percent || 0}%"></div></div>
      <div class="progress-meta">
        <span>${t.done || 0} / ${t.total || '?'} 分片 · ${t.percent || 0}% ${t.speed ? '· ' + fmtSize(t.speed) + '/s' : ''}</span>
        <span>${t.autoMerge ? '完成后自动合并' : (t.status === 'completed' ? '可到合并页生成 MP4' : '')}</span>
      </div>
      ${t.message ? `<div class="dl-msg">${escapeHtml(t.message)}</div>` : ''}
    </div>
  `;
  refreshEmpty();
}

/* —— 事件委托：在静态容器上一次性绑定，内部 innerHTML 重建不影响 —— */
$('#dl-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn || btn.disabled) return;
  const card = e.target.closest('.dl-card');
  if (!card) return;
  const id = card.id.replace('dl-', '');
  const act = btn.dataset.act;
  const t = taskMap.get(id);
  if (!t && act !== 'del') return;

  try {
    if (act === 'play') {
      const r = await window.api.download.play(id);
      if (r && r.ok) { openPlayers.add(id); if (t) renderTask(t); }
      else if (r && !r.ok) alert(r.error);
    } else if (act === 'pause') {
      await window.api.download.pause(id);
    } else if (act === 'resume') {
      await window.api.download.resume(id);
    } else if (act === 'repair') {
      btn.disabled = true;
      btn.textContent = '校验中…';
      await window.api.download.resume(id);
    } else if (act === 'folder') {
      await window.api.download.openFolder(id);
    } else if (act === 'openmp4') {
      if (t && t.mp4File) await window.api.merge.open(t.mp4File);
    } else if (act === 'del') {
      const ok = await openDeleteConfirm(t);
      if (!ok) return;
      await window.api.download.remove(id, ok.deleteFiles);
      card.remove();
      taskMap.delete(id);
      openPlayers.delete(id);
      refreshEmpty();
    }
  } catch (err) {
    alert('操作失败：' + (err.message || err));
  }
});

window.api.download.onUpdate((t) => renderTask(t));

(async function initDownloads() {
  try {
    (await window.api.download.list()).forEach(renderTask);
    refreshEmpty();
  } catch (err) {
    console.error('init downloads failed', err);
  }
})();

/* ================= 合并页（弹窗选择 + 进度） ================= */
const mergeJobMap = new Map();
let manualSegFiles = [];
const mergeMask = $('#merge-mask');
const mergeErr = $('#merge-modal-error');

async function loadMergePage() {
  (await window.api.merge.list()).forEach(renderMergeJob);
  refreshMergeEmpty();
}

function refreshMergeEmpty() {
  $('#merge-empty-jobs').style.display = $('#merge-jobs').children.length ? 'none' : 'block';
}

/* 打开合并弹窗 */
async function openMergeModal() {
  mergeErr.classList.add('hidden');
  mergeErr.textContent = '';
  manualSegFiles = [];
  $('#manual-segdir').value = '';
  $('#manual-info').textContent = '';
  $('#manual-outname').value = '';
  // 恢复上次输出目录
  const s = await window.api.settings.get();
  $('#merge-out-dir').value = s.outputDir || '';
  mergeMask.classList.remove('hidden');
}
function closeMergeModal() { mergeMask.classList.add('hidden'); }

$('#btn-open-merge-modal').addEventListener('click', openMergeModal);
$('#merge-x').addEventListener('click', closeMergeModal);
$('#merge-modal-cancel').addEventListener('click', closeMergeModal);
mergeMask.addEventListener('mousedown', (e) => { if (e.target === mergeMask) closeMergeModal(); });

function renderMergeJob(j) {
  mergeJobMap.set(j.id, j);
  let el = document.getElementById('job-' + j.id);
  if (!el) {
    el = document.createElement('div');
    el.id = 'job-' + j.id;
    el.className = 'job-row';
    $('#merge-jobs').appendChild(el);
  }
  const running = j.status === 'running';
  const label = running ? '合并中' : j.status === 'completed' ? '已完成'
    : j.status === 'canceled' ? '已取消' : '失败';
  el.innerHTML = `
    <span class="name">${escapeHtml(j.name)}.mp4
      <span class="dl-status ${running ? 'downloading' : j.status}">${label}</span>
    </span>
    <div class="progress-wrap">
      <div class="progress ${j.status === 'completed' ? 'completed' : j.status === 'error' ? 'error' : ''}">
        <div style="width:${j.percent || 0}%"></div>
      </div>
      <div class="progress-meta"><span>${escapeHtml(j.message || '')} ${j.percent || 0}%</span></div>
    </div>
    <button class="btn sm" data-jact="open" ${j.status !== 'completed' ? 'disabled' : ''}>打开文件</button>
    <button class="btn sm danger" data-jact="cancel" ${running ? '' : 'disabled'}>取消合并</button>
    <div class="job-out" title="${escapeHtml(j.output || '')}">${j.output ? '输出：' + escapeHtml(j.output) : ''}</div>
  `;
  refreshMergeEmpty();
}

/* —— 合并任务事件委托 —— */
$('#merge-jobs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-jact]');
  if (!btn || btn.disabled) return;
  const row = e.target.closest('.job-row');
  const id = row.id.replace('job-', '');
  const j = mergeJobMap.get(id);
  if (!j) return;
  if (btn.dataset.jact === 'cancel') window.api.merge.cancel(id);
  else if (btn.dataset.jact === 'open') window.api.merge.open(j.output);
});

$('#btn-merge-out-dir').addEventListener('click', async () => {
  const dir = await window.api.dialog.chooseDir($('#merge-out-dir').value || null);
  if (dir) {
    $('#merge-out-dir').value = dir;
    window.api.settings.set({ outputDir: dir });
  }
});

function setManualSeg(picked) {
  if (!picked) return;
  manualSegFiles = picked.files || [];
  $('#manual-segdir').value = picked.dir || '';
  $('#manual-info').textContent = `已选择 ${picked.count} 个 .ts 片段，将按文件名顺序合并`;
}
$('#btn-pick-segdir').addEventListener('click', async () => {
  setManualSeg(await window.api.merge.pickSegDir());
});
$('#btn-pick-segfiles').addEventListener('click', async () => {
  setManualSeg(await window.api.merge.pickSegFiles());
});
$('#btn-manual-merge').addEventListener('click', async () => {
  mergeErr.classList.add('hidden');
  if (!manualSegFiles.length) {
    mergeErr.textContent = '请先选择包含 .ts 片段的目录或文件';
    mergeErr.classList.remove('hidden');
    return;
  }
  const outputDir = $('#merge-out-dir').value.trim();
  const outputName = $('#manual-outname').value.trim();
  const name = outputName || ('merged_' + Date.now());
  if (outputDir) window.api.settings.set({ outputDir });
  const btn = $('#btn-manual-merge');
  btn.disabled = true;
  try {
    const job = await window.api.merge.start({
      taskId: 'manual_' + Date.now(),
      segFiles: manualSegFiles,
      workDir: '',
      segDir: '',
      name,
      outputDir,
      outputName: name
    });
    renderMergeJob(job);
    closeMergeModal();
  } catch (err) {
    mergeErr.textContent = '合并失败：' + (err.message || err);
    mergeErr.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
});

window.api.merge.onUpdate((j) => renderMergeJob(j));

/* ================= 设置页 ================= */
async function loadSettingsPage() {
  const status = $('#ffmpeg-status');
  try {
    const info = await window.api.merge.ffmpegInfo();
    if (info.available) {
      status.className = 'settings-status';
      status.textContent = info.custom
        ? '当前使用：你手动指定的 ffmpeg，可正常使用。'
        : '当前使用：应用内置 ffmpeg，可正常使用。';
    } else {
      status.className = 'settings-status bad';
      status.textContent = '未检测到可用的 ffmpeg，请手动指定 ffmpeg.exe。';
    }
  } catch (e) {
    status.className = 'settings-status bad';
    status.textContent = '检测失败：' + (e.message || e);
  }
}
$('#btn-set-ffmpeg').addEventListener('click', async () => {
  const r = await window.api.merge.chooseFfmpeg();
  if (r && r.ok) { alert('已指定 ffmpeg'); loadSettingsPage(); }
});
$('#btn-reset-ffmpeg').addEventListener('click', async () => {
  const r = await window.api.merge.resetFfmpeg();
  alert(r.ok ? '已恢复使用内置 ffmpeg' : '内置 ffmpeg 不可用，请手动指定。');
  loadSettingsPage();
});
