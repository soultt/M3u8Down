const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const TASK_FILE = 'task.json';
const SEG_TIMEOUT = 30000;
const RETRY_LIMIT = 5;

/**
 * 校验文件是否为合法 MPEG-TS：
 * - 至少一个 TS 包长度(188)
 * - 以同步字节 0x47 开头
 * - 抽样前若干个 188 字节包，同步字节均为 0x47（排除 HTML/残缺/未解密数据）
 */
function isValidTs(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const st = fs.fstatSync(fd);
      if (st.size < 188) return false;
      const buf = Buffer.alloc(188 * 8);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      if (n < 188) return false;
      if (buf[0] !== 0x47) return false;
      const packets = Math.min(8, Math.floor(n / 188));
      for (let i = 0; i < packets; i++) {
        if (buf[i * 188] !== 0x47) return false;
      }
      return true;
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {
    return false;
  }
}


/** 轻量可取消信号 */
function createSignal() {
  return {
    aborted: false,
    _cbs: [],
    abort() {
      if (this.aborted) return;
      this.aborted = true;
      this._cbs.forEach((fn) => { try { fn(); } catch (_) {} });
      this._cbs = [];
    },
    onAbort(fn) { if (this.aborted) fn(); else this._cbs.push(fn); }
  };
}

function fetchUrl(url, redirects = 0, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new Error('已取消'));
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) M3u8Down/1.0',
        'Accept': '*/*'
      },
      timeout: SEG_TIMEOUT
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        if (redirects > 5) return reject(new Error('重定向次数过多'));
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(fetchUrl(next, redirects + 1, signal));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      resolve(res);
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (signal) signal.onAbort(() => { try { req.destroy(new Error('已取消')); } catch (_) {} });
  });
}

async function fetchText(url, signal) {
  const res = await fetchUrl(url, 0, signal);
  const chunks = [];
  for await (const c of res) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchToFile(url, filePath, expectedSize = null, signal) {
  const res = await fetchUrl(url, 0, signal);
  await new Promise((resolve, reject) => {
    const tmp = filePath + '.part';
    const ws = fs.createWriteStream(tmp);
    res.pipe(ws);
    ws.on('finish', () => ws.close((err) => err ? reject(err) : resolve()));
    ws.on('error', reject);
    res.on('error', reject);
    if (signal) signal.onAbort(() => { try { res.destroy(); } catch (_) {} try { ws.destroy(); } catch (_) {} });
  });
  if (signal && signal.aborted) throw new Error('已取消');
  if (expectedSize) {
    const st = fs.statSync(filePath + '.part');
    if (st.size !== expectedSize) {
      fs.unlinkSync(filePath + '.part');
      throw new Error(`分片大小不匹配 ${st.size}/${expectedSize}`);
    }
  }
  fs.renameSync(filePath + '.part', filePath);
}

/**
 * 解析 #EXT-X-KEY 标签（兼容属性带引号/不带引号、大小写、IV 带 0x 前缀等写法）。
 * 支持一个 m3u8 中多次出现 EXT-X-KEY（包括中途 METHOD=NONE 取消加密）。
 * 返回 { method, uri, iv } 或 null
 */
function parseExtXKey(line, baseUrl) {
  const methodM = line.match(/METHOD\s*=\s*("[^"]*"|[^,]+)/i);
  if (!methodM) return null;
  const method = methodM[1].replace(/^"|"$/g, '').trim().toUpperCase();
  if (method === 'NONE' || !method) return { method: 'NONE', uri: null, iv: null };

  const uriM = line.match(/URI\s*=\s*"([^"]*)"/i);
  let keyUri = null;
  if (uriM && uriM[1]) {
    const raw = uriM[1].trim();
    // data: 内联 key（base64）原样保留，下载阶段直接解码
    if (/^data:/i.test(raw)) {
      keyUri = raw;
    } else {
      try { keyUri = new URL(raw, baseUrl).toString(); } catch (_) { keyUri = raw; }
    }
  }

  let ivBuf = null;
  const ivM = line.match(/IV\s*=\s*("[^"]*"|[^,]+)/i);
  if (ivM) {
    const ivRaw = ivM[1].replace(/^"|"$/g, '').trim().replace(/^0x/i, '');
    // 16 字节 IV 以 32 位 hex 表示；非标准长度左补 0
    if (ivRaw) ivBuf = Buffer.from(ivRaw.padStart(32, '0'), 'hex');
  }
  return { method, uri: keyUri, iv: ivBuf };
}

/**
 * 解析 m3u8：支持 master playlist 选最高码率、相对路径、AES-128/192/256-CBC 解密
 */
function parseM3U(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  let key = null; // {method, uri, iv}
  let seq = 0;
  const segments = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line || line.startsWith('#EXT')) {
      if (line.startsWith('#EXT-X-KEY')) {
        key = parseExtXKey(line, baseUrl);
      } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE')) {
        seq = parseInt(line.split(':')[1], 10) || 0;
      }
      continue;
    }
    if (line.startsWith('#')) continue;
    // URI 行
    if (line.endsWith('.m3u8') || line.includes('.m3u8?') || /^https?:\/\//.test(line) || !line.startsWith('#')) {
      const abs = new URL(line, baseUrl).toString();
      if (line.toLowerCase().includes('.m3u8')) {
        return { isMaster: true, subPlaylists: [abs] };
      }
      segments.push({ url: abs, key, seq });
      seq++;
    }
  }
  return { isMaster: false, segments };
}

class DownloadManager extends EventEmitter {
  constructor(rootDir, store) {
    super();
    this.rootDir = rootDir;
    this.store = store || null;
    this.tasks = new Map();
    this.controls = new Map(); // id -> AbortController-like flags
    this._restore();
  }

  _taskFile(workDir) { return path.join(workDir, TASK_FILE); }

  _restore() {
    const seen = new Set();
    // 1) 通过设置中的任务索引恢复（覆盖自选目录）
    if (this.store) {
      for (const item of this.store.getTaskIndex()) {
        if (!item || !item.workDir || seen.has(item.workDir)) continue;
        this._loadTaskDir(item.workDir) && seen.add(item.workDir);
      }
    }
    // 2) 兜底扫描默认根目录
    if (fs.existsSync(this.rootDir)) {
      for (const name of fs.readdirSync(this.rootDir)) {
        const dir = path.join(this.rootDir, name);
        if (seen.has(dir)) continue;
        if (this._loadTaskDir(dir)) seen.add(dir);
      }
    }
  }

  _loadTaskDir(dir) {
    try {
      let st;
      try { st = fs.statSync(dir); } catch { return false; }
      if (!st.isDirectory()) return false;
      const tf = this._taskFile(dir);
      if (!fs.existsSync(tf)) return false;
      const t = JSON.parse(fs.readFileSync(tf, 'utf8'));
      if (['downloading', 'pausing', 'merging', 'parsing'].includes(t.status)) t.status = 'paused';
      // key 缓存经 JSON 往返后 Buffer 会退化为 {type:'Buffer',data:[...]} 普通对象，
      // 无法再用于 createDecipheriv；恢复时清空，首个加密分片会重新拉取并缓存为真正的 Buffer
      if (t.keyCache && typeof t.keyCache === 'object') {
        for (const k of Object.keys(t.keyCache)) {
          if (!Buffer.isBuffer(t.keyCache[k])) delete t.keyCache[k];
        }
      }
      this.tasks.set(t.id, t);
      return true;
    } catch (_) {
      return false;
    }
  }

  _persist(task) {
    try {
      if (!task.workDir || !fs.existsSync(task.workDir)) return;
      fs.writeFileSync(this._taskFile(task.workDir), JSON.stringify(task, null, 2));
      if (this.store) this.store.upsertTaskIndex(task.id, task.workDir);
    } catch (_) {}
  }

  listTasks() {
    return [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  getTask(id) { return this.tasks.get(id); }

  setMerged(id, merged, mp4File, message) {
    const t = this.tasks.get(id);
    if (!t) return;
    t.merged = !!merged;
    if (mp4File) t.mp4File = mp4File;
    if (message) t.message = message;
    this._persist(t);
    this.emit('update', t);
  }

  async addTask({ url, name, concurrency = 8, headers = {}, saveDir, autoMerge = false, outputDir = '', outputName = '' }) {
    if (!url || !/^https?:\/\//i.test(url)) throw new Error('请输入合法的 http(s) m3u8 地址');
    const id = crypto.randomBytes(6).toString('hex');
    const safeName = (name || ('video_' + id)).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
    // 保存目录：用户选择的目录下创建任务子目录；未选则默认内部目录
    const baseRoot = (saveDir && path.isAbsolute(saveDir)) ? saveDir : this.rootDir;
    if (!fs.existsSync(baseRoot)) fs.mkdirSync(baseRoot, { recursive: true });
    let workDir = path.join(baseRoot, safeName + '_' + id.slice(0, 4));
    let n = 1;
    while (fs.existsSync(workDir)) {
      workDir = path.join(baseRoot, `${safeName}_${id.slice(0, 4)}_${n++}`);
    }
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(path.join(workDir, 'segs'), { recursive: true });

    const task = {
      id, url, name: safeName, workDir, saveDir: baseRoot,
      concurrency: Math.max(1, Math.min(32, parseInt(concurrency, 10) || 8)),
      headers,
      status: 'parsing', // parsing|downloading|paused|completed|error|removed
      total: 0, done: 0, failed: 0,
      percent: 0, speed: 0,
      message: '正在解析播放列表…',
      createdAt: Date.now(),
      segDir: path.join(workDir, 'segs'),
      keyCache: {},
      bytesLoaded: 0,
      autoMerge: !!autoMerge,
      outputDir: outputDir || '',
      outputName: (outputName || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80),
      merged: false,
      mp4File: ''
    };
    this.tasks.set(id, task);
    this._persist(task);
    this.emit('update', task);

    // 异步开始
    this._run(task).catch((err) => {
      // 已被删除/取消则不再回写状态
      if (!this.tasks.has(id)) return;
      const c = this.controls.get(id);
      if (c && c.canceled) return;
      task.status = 'error';
      task.message = err.message || String(err);
      this._persist(task);
      this.emit('update', task);
    });

    return task;
  }

  async _resolvePlaylist(url, depth = 0, signal) {
    const text = await fetchText(url, signal);
    const parsed = parseM3U(text, url);
    if (parsed.isMaster) {
      if (depth > 3) throw new Error('播放列表嵌套过深');
      // 简单策略：取第一个子列表（多数情况下为唯一/最高码率需 BANDWIDTH 判断，这里做一次比较）
      const candidates = parsed.subPlaylists.map((u) => ({ u, bw: 0 }));
      // 尝试从原始文本中提取 BANDWIDTH
      const blocks = text.split(/#EXT-X-STREAM-INF/).slice(1);
      blocks.forEach((b, idx) => {
        const m = b.match(/BANDWIDTH=(\d+)/);
        if (m && candidates[idx]) candidates[idx].bw = parseInt(m[1], 10);
      });
      candidates.sort((a, b) => b.bw - a.bw);
      return this._resolvePlaylist(candidates[0].u, depth + 1, signal);
    }
    return parsed.segments;
  }

  /**
   * 规范化 key 字节：
   * - data: URI（base64 内联 key）直接解码
   * - 服务器返回 32 字符 hex 文本（常见伪二进制写法）时按 hex 解为 16 字节
   * - 其它情况按原始二进制返回（16/24/32 字节分别对应 AES-128/192/256）
   */
  _normalizeKey(k, raw) {
    if (/^data:/i.test(k.uri || '')) {
      const u = k.uri;
      const comma = u.indexOf(',');
      if (comma < 0) throw new Error('data: key URI 格式异常');
      const meta = u.slice(5, comma).toLowerCase();
      const payload = u.slice(comma + 1);
      if (meta.includes(';base64')) return Buffer.from(payload, 'base64');
      return Buffer.from(decodeURIComponent(payload), 'binary');
    }
    // 去掉首尾空白/换行（部分 key 服务会附带 \n）
    let buf = raw;
    if (buf.length > 0) {
      const start = buf[0] === 0x0a || buf[0] === 0x0d ? 1 : 0;
      let end = buf.length;
      while (end > start && (buf[end - 1] === 0x0a || buf[end - 1] === 0x0d)) end--;
      if (end !== buf.length || start !== 0) buf = buf.slice(start, end);
    }
    // 32 个可见 ASCII hex 字符 → 当作 16 字节二进制 key
    if (buf.length === 32 && /^[0-9a-fA-F]{32}$/.test(buf.toString('latin1'))) {
      return Buffer.from(buf.toString('latin1'), 'hex');
    }
    return buf;
  }

  async _getKey(task, seg, signal) {
    const k = seg.key;
    if (!k || k.method === 'NONE') return null;
    if (!/^AES-(128|192|256)$/i.test(k.method)) {
      throw new Error('暂不支持的加密方式: ' + k.method);
    }
    const cacheKey = k.uri || '__inline__';
    const cached = task.keyCache[cacheKey];
    // 仅当缓存是真正的 Buffer 才复用；JSON 往返后会退化为普通对象，需重新获取
    if (cached && Buffer.isBuffer(cached)) return cached;

    let keyBuf;
    if (/^data:/i.test(k.uri || '')) {
      keyBuf = this._normalizeKey(k, Buffer.alloc(0));
    } else if (k.uri) {
      // key 服务偶发 403/超时：最多重试 3 次
      let lastErr;
      for (let i = 0; i < 3; i++) {
        try {
          const res = await fetchUrl(k.uri, 0, signal);
          const chunks = [];
          for await (const c of res) chunks.push(c);
          keyBuf = this._normalizeKey(k, Buffer.concat(chunks));
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          if (signal && signal.aborted) throw e;
          await new Promise((r) => setTimeout(r, 400 * (i + 1)));
        }
      }
      if (lastErr) throw lastErr;
    } else {
      throw new Error('加密分片缺少 key URI');
    }

    // key 长度必须匹配算法：AES-128=16, AES-192=24, AES-256=32
    const expectLen = { 'AES-128': 16, 'AES-192': 24, 'AES-256': 32 }[k.method.toUpperCase()];
    if (keyBuf.length !== expectLen) {
      throw new Error(`key 长度 ${keyBuf.length} 与 ${k.method} 要求的 ${expectLen} 字节不匹配`);
    }
    task.keyCache[cacheKey] = keyBuf;
    return keyBuf;
  }

  async _run(task) {
    // 先建立控制对象，使解析阶段也能被删除/取消中断
    let control = this.controls.get(task.id);
    if (!control) {
      control = { paused: false, canceled: false, running: true, timer: null, signal: createSignal() };
      this.controls.set(task.id, control);
    }
    // 解析
    const segments = await this._resolvePlaylist(task.url, 0, control.signal);
    if (control.canceled) return;
    if (!segments.length) throw new Error('播放列表中没有分片');
    task.total = segments.length;
    task.status = 'downloading';
    task.message = '';
    // 写本地播放列表，供边下边播（按序号命名，EXTINF 用占位）
    this._writeLocalPlaylist(task, segments.length);
    this._persist(task);
    this.emit('update', task);


    let cursor = 0;
    let active = 0;
    let finished = 0;
    let bytesSinceTick = 0;
    let lastTick = Date.now();

    const segPath = (idx) => path.join(task.segDir, String(idx).padStart(6, '0') + '.ts');

    const decryptIfNeeded = async (buf, seg) => {
      if (!seg.key || seg.key.method === 'NONE') return buf;
      const keyBuf = await this._getKey(task, seg, control.signal);
      // RFC 8216：EXT-X-KEY 未显式给出 IV 时，IV = 该分片媒体序列号（128-bit 大端）
      let ivUse = seg.key.iv;
      if (!ivUse) {
        ivUse = Buffer.alloc(16);
        ivUse.writeBigUInt64BE(BigInt(seg.seq), 8);
      }
      // 动态算法：aes-128-cbc / aes-192-cbc / aes-256-cbc
      const algo = (seg.key.method + '-cbc').toLowerCase();
      // 终极保险：确保 key/iv 是 Buffer（历史 task.json 反序列化或异常路径可能残留普通对象）
      const safeKey = Buffer.isBuffer(keyBuf) ? keyBuf : Buffer.from(keyBuf);
      if (!Buffer.isBuffer(ivUse)) ivUse = Buffer.from(ivUse);
      const decipher = crypto.createDecipheriv(algo, safeKey, ivUse);
      decipher.setAutoPadding(true);
      try {
        return Buffer.concat([decipher.update(buf), decipher.final()]);
      } catch (e) {
        throw new Error('解密失败（key/IV 不匹配或分片损坏）: ' + e.message);
      }
    };

    const downloadOne = async (idx, seg, retry = 0) => {
      const fp = segPath(idx);
      // 任务已取消：直接退出，不再下载/重试/写盘
      if (control.canceled) return;
      // 断点续传：已存在文件必须是合法 TS，否则（残缺/HTML/未解密残留）删除重下
      if (fs.existsSync(fp)) {
        if (isValidTs(fp)) {
          finished++;
          task.done = finished;
          task.percent = Math.round((finished / task.total) * 10000) / 100;
          this.emit('update', task);
          return;
        }
        if (control.canceled) return;
        try { fs.unlinkSync(fp); } catch (_) {}
      }
      try {
        await fetchToFile(seg.url, fp, null, control.signal);
        if (control.canceled) { try { fs.existsSync(fp) && fs.unlinkSync(fp); } catch (_) {} return; }
        // 解密
        if (seg.key && seg.key.method !== 'NONE') {
          const enc = fs.readFileSync(fp);
          const dec = await decryptIfNeeded(enc, seg);
          fs.writeFileSync(fp, dec);
        }
        if (control.canceled) return;
        // 内容校验：必须是合法 TS（防止错误页/坏片/解密异常被当成成功）
        if (!isValidTs(fp)) {
          try { fs.unlinkSync(fp); } catch (_) {}
          throw new Error('分片内容不是有效的 TS 数据（可能是错误页或解密失败）');
        }
        const st = fs.statSync(fp);
        bytesSinceTick += st.size;
        finished++;
        task.failed = 0;
      } catch (err) {
        if (control.canceled) return; // 取消导致的错误，静默丢弃
        if (retry < RETRY_LIMIT) {
          await new Promise((r) => setTimeout(r, 500 * (retry + 1)));
          if (control.canceled) return;
          return downloadOne(idx, seg, retry + 1);
        }
        task.failed++;
        task.message = `分片 ${idx} 下载失败: ${err.message}`;
      }
      if (control.canceled) return;
      task.done = finished;
      task.percent = Math.round((finished / task.total) * 10000) / 100;
      this.emit('update', task);
    };

    return new Promise((resolve) => {
      let finishedFlag = false;

      const finish = () => {
        if (finishedFlag) return;
        finishedFlag = true;
        control.running = false;
        if (control.timer) { clearInterval(control.timer); control.timer = null; }
        if (control.canceled) return resolve('canceled');
        if (task.done >= task.total) {
          task.status = 'completed';
          task.percent = 100;
          task.speed = 0;
          task.message = task.autoMerge ? '下载完成，准备自动合并…' : '下载完成，可以合并';
        } else if (task.failed > 0) {
          task.status = 'error';
          task.speed = 0;
          task.message = `${task.failed} 个分片下载失败，可点击继续重试`;
        }
        this._writeLocalPlaylist(task, task.total, task.status === 'completed');
        this._persist(task);
        this.emit('update', task);
        if (task.status === 'completed' && task.autoMerge && !task.merged) {
          this.emit('autoMerge', task);
        }
        resolve();
      };

      const pump = () => {
        if (control.canceled) {
          if (active === 0) finish();
          return;
        }
        if (control.paused) {
          // 在途分片继续完成，不再派发新分片；全部落地后进入暂停态
          if (active === 0) {
            task.status = 'paused';
            task.speed = 0;
            task.message = '已暂停';
            this._writeLocalPlaylist(task, task.total);
            this._persist(task);
            this.emit('update', task);
          }
          return;
        }
        while (active < task.concurrency && cursor < segments.length) {
          const idx = cursor++;
          active++;
          downloadOne(idx, segments[idx]).finally(() => {
            active--;
            if (cursor >= segments.length && active === 0) return finish();
            pump();
          });
        }
        if (cursor >= segments.length && active === 0) finish();
      };

      control.timer = setInterval(() => {
        if (control.canceled) {
          clearInterval(control.timer);
          control.timer = null;
          return;
        }
        const now = Date.now();
        const dt = (now - lastTick) / 1000;
        task.speed = (!control.paused && !control.canceled && dt > 0)
          ? Math.round(bytesSinceTick / dt) : 0;
        bytesSinceTick = 0;
        lastTick = now;
        this._writeLocalPlaylist(task, task.total);
        this._persist(task);
        this.emit('update', task);
        // 恢复驱动
        if (!control.paused && !control.canceled && task.status !== 'completed') pump();
      }, 1000);

      pump();
    });
  }

  _writeLocalPlaylist(task, count, finalOnly = false) {
    // 目录已被删除（任务连同文件删除）时直接跳过，避免 ENOENT 崩溃
    if (!task.workDir || !fs.existsSync(task.workDir)) return;
    try {
      // 仅包含已存在分片，播放器/合并均可读取
      const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:10', '#EXT-X-MEDIA-SEQUENCE:0'];
      for (let i = 0; i < count; i++) {
        const fp = path.join(task.segDir, String(i).padStart(6, '0') + '.ts');
        if (fs.existsSync(fp)) {
          lines.push('#EXTINF:10.0,');
          lines.push('segs/' + String(i).padStart(6, '0') + '.ts');
        }
      }
      if (finalOnly) lines.push('#EXT-X-ENDLIST');
      fs.writeFileSync(path.join(task.workDir, 'playlist-local.m3u8'), lines.join('\n'));
    } catch (_) {}
  }

  pauseTask(id) {
    const t = this.tasks.get(id);
    const c = this.controls.get(id);
    if (t && ['downloading', 'parsing'].includes(t.status)) {
      if (c) c.paused = true;
      t.status = 'paused';
      t.message = '暂停中，等待在途分片完成…';
      this._persist(t);
      this.emit('update', t);
    }
    return t;
  }

  resumeTask(id) {
    const t = this.tasks.get(id);
    if (!t) return null;
    const c = this.controls.get(id);
    if (c && c.running) {
      // 循环仍在（暂停态），解除标志即可，定时器会驱动 pump
      c.paused = false;
      t.status = 'downloading';
      t.message = '';
      this._persist(t);
      this.emit('update', t);
    } else if (t.status === 'paused' || t.status === 'error' ||
               (t.status === 'completed' && !t.merged)) {
      // 已完成但合并失败/存在坏分片：重跑会校验并补下坏片（autoMerge 时再自动合并）
      this._restart(t);
    }
    return t;
  }

  retryTask(id) { return this.resumeTask(id); }

  async _restart(task) {
    task.status = 'downloading';
    task.message = '';
    this.emit('update', task);
    try {
      await this._run(task);
    } catch (err) {
      task.status = 'error';
      task.message = err.message;
      this._persist(task);
      this.emit('update', task);
    }
  }

  async removeTask(id, deleteFiles) {
    const t = this.tasks.get(id);
    if (!t) return { ok: false };
    const c = this.controls.get(id);
    if (c) {
      c.canceled = true;
      c.paused = true;
      if (c.signal) c.signal.abort();      // 立即中断进行中的 HTTP 请求
      if (c.timer) { clearInterval(c.timer); c.timer = null; }
    }
    this.tasks.delete(id);
    this.controls.delete(id);
    // 同步删除持久化记录（任务索引）
    if (this.store) this.store.removeTaskIndex(id);
    if (deleteFiles && t.workDir && fs.existsSync(t.workDir)) {
      fs.rmSync(t.workDir, { recursive: true, force: true });
    }
    return { ok: true };
  }

  dispose() {
    for (const c of this.controls.values()) c.canceled = true;
  }
}

module.exports = DownloadManager;
