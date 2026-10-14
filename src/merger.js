const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/** 校验是否为合法 MPEG-TS（同步字节 0x47） */
function isValidTs(file) {
  try {
    const st = fs.statSync(file);
    if (st.size < 188) return false;
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(188 * 4);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      if (n < 188 || buf[0] !== 0x47) return false;
      const packets = Math.min(4, Math.floor(n / 188));
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

/**
 * 构造 concat 列表规格。
 * 同目录：list 与分片同目录、只写纯文件名、cwd=该目录、-i 用相对名（最稳）。
 * 跨目录：回退绝对路径 + -safe 0。
 * 返回 { cwd, listFile, listArg, listContent, safe }
 */
function buildConcatSpec(segAbsList, workDir) {
  const dirs = new Set(segAbsList.map((f) => path.dirname(f)));
  const sameDir = dirs.size === 1;
  const segDir = path.dirname(segAbsList[0]);
  const esc = (s) => s.replace(/'/g, "'\\''");

  if (sameDir) {
    const cwd = segDir;
    const listFile = path.join(cwd, 'concat_list.txt');
    const listArg = 'concat_list.txt';
    const listContent = segAbsList
      .map((f) => `file '${esc(path.basename(f))}'`)
      .join('\n');
    return { cwd, listFile, listArg, listContent, safe: false };
  }

  // 跨目录：写到可用的工作目录，list 用绝对路径 + 正斜杠
  const cwd = (workDir && fs.existsSync(workDir)) ? workDir : segDir;
  const listFile = path.join(cwd, 'concat_list.txt');
  const listContent = segAbsList
    .map((f) => `file '${esc(f.replace(/\\/g, '/'))}'`)
    .join('\n');
  return { cwd, listFile, listArg: listFile, listContent, safe: true };
}

class Merger extends EventEmitter {
  constructor(downloadRoot) {
    super();
    this.root = downloadRoot;
    this.jobs = new Map();
    this.procs = new Map();
    this.customFfmpeg = null;
  }

  ffmpegInfo() {
    return { path: this._findFfmpeg() };
  }

  setFfmpegPath(p) { this.customFfmpeg = p; }

  _findFfmpeg() {
    if (this.customFfmpeg && fs.existsSync(this.customFfmpeg)) return this.customFfmpeg;

    // 1) 打包后：extraResources 解包到 resources/bin/ffmpeg.exe（真实文件，可直接 spawn）
    //    必须优先，因为 asar 内的 ffmpeg 虽 existsSync 为 true 但无法被 spawn 执行
    const resourceCandidates = [
      path.join(process.resourcesPath || '', 'bin', 'ffmpeg.exe'),
      path.join(__dirname, '..', '..', 'bin', 'ffmpeg.exe')
    ];
    for (const c of resourceCandidates) {
      if (c && fs.existsSync(c) && !c.includes('app.asar')) return c;
    }

    // 2) 开发环境：node_modules 内的 ffmpeg-static
    try {
      const embedded = require('ffmpeg-static');
      if (embedded && fs.existsSync(embedded) && !String(embedded).includes('app.asar')) {
        return embedded;
      }
    } catch (_) {}

    // 3) 其它相对位置兜底
    const fallback = [
      path.join(__dirname, '..', 'bin', 'ffmpeg.exe'),
      path.join(__dirname, '..', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe')
    ];
    for (const c of fallback) {
      if (c && fs.existsSync(c) && !c.includes('app.asar')) return c;
    }

    // 4) 若只能拿到 asar 内路径，Electron 会自动解包 via app.asar.unpacked；
    //    ffmpeg-static 未配置 unpack 时通常不可执行，最终交给 PATH
    return 'ffmpeg';
  }

  async _probeFfmpeg() {
    const exe = this._findFfmpeg();
    return new Promise((resolve) => {
      const p = spawn(exe, ['-version'], { windowsHide: true });
      let out = '';
      p.stdout.on('data', (d) => (out += d.toString()));
      p.on('error', () => resolve(null));
      p.on('close', (code) => resolve(code === 0 ? exe : null));
    });
  }

  /** 扫描可合并的下载任务（分片完整） */
  scanTasks(manager) {
    const list = manager.listTasks();
    return list.map((t) => {
      const segCount = fs.existsSync(t.segDir) ? fs.readdirSync(t.segDir).filter((f) => f.endsWith('.ts')).length : 0;
      const output = path.join(t.workDir, t.name + '.mp4');
      return {
        id: t.id,
        name: t.name,
        workDir: t.workDir,
        segDir: t.segDir,
        total: t.total,
        segCount,
        status: t.status,
        output,
        outputExists: fs.existsSync(output)
      };
    }).filter((x) => x.segCount > 0);
  }

  listJobs() { return [...this.jobs.values()]; }

  cancel(jobId) {
    const p = this.procs.get(jobId);
    const j = this.jobs.get(jobId);
    if (p) {
      try { p.kill(); } catch (_) {}
      this.procs.delete(jobId);
    }
    if (j) {
      j.status = 'canceled';
      j.message = '已取消';
      this.emit('update', j);
    }
  }

  async start({ taskId, workDir, segDir, name, total, outputDir, outputName, segFiles }) {
    const exe = await this._probeFfmpeg();
    if (!exe) {
      throw new Error('未检测到内嵌 ffmpeg，请重新安装应用或检查 resources/bin/ffmpeg.exe。');
    }

    const id = 'm_' + (taskId || Date.now());

    // 分片来源：显式文件列表（手动选目录）优先，否则读取 segDir 下全部 .ts
    let segAbsList = [];
    if (Array.isArray(segFiles) && segFiles.length) {
      segAbsList = segFiles.slice();
    } else {
      if (!segDir || !fs.existsSync(segDir)) throw new Error('TS 片段目录不存在');
      segAbsList = fs.readdirSync(segDir)
        .filter((f) => f.toLowerCase().endsWith('.ts'))
        .sort()
        .map((f) => path.join(segDir, f));
    }
    segAbsList = segAbsList.filter((f) => fs.existsSync(f));
    if (!segAbsList.length) throw new Error('没有可合并的 .ts 片段');

    // 内容校验：剔除 0 字节 / HTML 错误页 / 未正确解密等非 TS 文件
    const invalid = [];
    const validSegs = segAbsList.filter((f) => {
      const ok = isValidTs(f);
      if (!ok) invalid.push(path.basename(f));
      return ok;
    });
    if (!validSegs.length) {
      throw new Error(
        `所选片段都不是有效的 TS 数据（共 ${segAbsList.length} 个，首个：${path.basename(segAbsList[0])}）。` +
        '可能是分片未下载完整、服务器返回错误页或加密流未正确解密，请重新下载后再合并。'
      );
    }
    const skippedCount = invalid.length;
    segAbsList = validSegs;

    // 输出目录：用户选择优先，否则任务所在根目录，最后用片段目录
    let outDir = (outputDir && path.isAbsolute(outputDir))
      ? outputDir
      : (workDir ? path.dirname(workDir) : path.dirname(segAbsList[0]));
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const safeOut = (outputName || name || 'merged').replace(/[\\/:*?"<>|]/g, '_').replace(/\.mp4$/i, '');
    let finalOutput = path.join(outDir, safeOut + '.mp4');
    if (fs.existsSync(finalOutput)) {
      let i = 1;
      while (fs.existsSync(path.join(outDir, `${safeOut}_${i}.mp4`))) i++;
      finalOutput = path.join(outDir, `${safeOut}_${i}.mp4`);
    }

    // —— 稳健的 concat 路径策略 ——
    // 首选：所有分片同目录时，concat 列表与分片放同目录、只写纯文件名，
    // 并以该目录为 cwd、-i 用相对文件名，彻底规避 Windows 盘符/中文/空格/层级问题。
    // 跨目录时才回退绝对路径 + -safe 0。
    const concat = buildConcatSpec(segAbsList, workDir);
    try {
      fs.writeFileSync(concat.listFile, concat.listContent, 'utf8');
    } catch (e) {
      throw new Error('无法写入临时合并列表：' + e.message);
    }

    const job = {
      id, taskId: taskId || null, name: safeOut, workDir: concat.cwd, output: finalOutput,
      status: 'running',
      percent: 0,
      total: total || segAbsList.length,
      processed: 0,
      message: '合并中…',
      startedAt: Date.now()
    };
    this.jobs.set(id, job);
    this.emit('update', job);

    // concat demuxer + copy（无损快速）
    const args = concat.safe
      ? ['-y', '-f', 'concat', '-safe', '0', '-i', concat.listArg, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', finalOutput]
      : ['-y', '-f', 'concat', '-i', concat.listArg, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', finalOutput];

    return new Promise((resolve) => {
      const proc = spawn(exe, args, { cwd: concat.cwd, windowsHide: true });
      this.procs.set(id, proc);
      let stderr = '';
      proc.stderr.on('data', (d) => {
        const s = d.toString();
        stderr += s;
        // 通过 "Opening '<文件>'" 计数估算进度
        const opens = s.match(/Opening '([^']+\.ts)'/g);
        if (opens) {
          job.processed = Math.min(job.total, job.processed + opens.length);
          job.percent = Math.min(99, Math.round((job.processed / job.total) * 100));
          this.emit('update', job);
        }
      });
      proc.on('error', (err) => {
        job.status = 'error';
        job.message = err.message;
        this.emit('update', job);
        resolve(job);
      });
      proc.on('close', (code) => {
        this.procs.delete(id);
        // 清理临时 concat 列表（避免残留在分片目录）
        try { fs.unlinkSync(concat.listFile); } catch (_) {}
        if (job.status === 'canceled') {
          try { fs.unlinkSync(finalOutput); } catch (_) {}
          return resolve(job);
        }
        if (code === 0 && fs.existsSync(finalOutput)) {
          job.status = 'completed';
          job.percent = 100;
          job.message = skippedCount > 0 ? `合并完成（已跳过 ${skippedCount} 个无效分片）` : '合并完成';
        } else {
          job.status = 'error';
          const tail = stderr.split('\n').map((x) => x.trim()).filter(Boolean).slice(-4).join(' ');
          job.message = 'ffmpeg 失败：' + (tail || ('exit code ' + code));
        }
        this.emit('update', job);
        resolve(job);
      });
    });
  }

  /** 扫描某目录下的 .ts 片段（供手动选择目录合并） */
  listSegs(dir) {
    if (!dir || !fs.existsSync(dir)) return [];
    const st = fs.statSync(dir);
    if (!st.isDirectory()) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.ts'))
      .sort()
      .map((f) => path.join(dir, f));
  }

  /**
   * 将指定 ts 片段快速 remux 为临时 MP4，用于播放（Chromium 不稳定支持 MPEG-TS MSE）。
   * 返回 Promise<{ok, file, error}>
   */
  buildPreviewMp4(segFiles, outFile) {
    return new Promise(async (resolve) => {
      const exe = await this._probeFfmpeg();
      if (!exe) return resolve({ ok: false, error: '未检测到内嵌 ffmpeg' });
      const list = (segFiles || []).filter((f) => fs.existsSync(f) && isValidTs(f));
      if (!list.length) return resolve({ ok: false, error: '暂无可播放的有效分片（可能尚未下载完整）' });

      const concat = buildConcatSpec(list, path.dirname(outFile));
      try {
        fs.writeFileSync(concat.listFile, concat.listContent, 'utf8');
      } catch (e) {
        return resolve({ ok: false, error: '无法写入临时合并列表：' + e.message });
      }
      try { if (fs.existsSync(outFile)) fs.unlinkSync(outFile); } catch (_) {}

      const inputArgs = concat.safe
        ? ['-f', 'concat', '-safe', '0', '-i', concat.listArg]
        : ['-f', 'concat', '-i', concat.listArg];
      const proc = spawn(exe, [
        '-y', ...inputArgs,
        '-c', 'copy', '-bsf:a', 'aac_adtstoasc', outFile
      ], { cwd: concat.cwd, windowsHide: true });

      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('error', (err) => resolve({ ok: false, error: err.message }));
      proc.on('close', (code) => {
        if (code === 0 && fs.existsSync(outFile)) return resolve({ ok: true, file: outFile });
        const tail = stderr.split('\n').map((x) => x.trim()).filter(Boolean).slice(-3).join(' ');
        resolve({ ok: false, error: tail || ('ffmpeg exit ' + code) });
      });
    });
  }
}

module.exports = Merger;
