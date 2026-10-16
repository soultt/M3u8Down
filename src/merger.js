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

/**
 * 构造“重编码规整时间戳”的 ffmpeg 参数。
 * concat demuxer 把所有分片合并为一条输入；通过：
 *   - -fflags +genpts+discardcorrupt  重建 PTS 并丢弃损坏时间戳（防止分片坏时间戳带毒拼接）
 *   - fps=SRC_FPS                     跟随源帧率做 CFR 归一化（不能硬编码 30，否则 25/29.97fps 源会变速卡顿）
 *   - setpts=PTS-STARTPTS             视频时间戳归零并连续化
 *   - aresample=async=1000            音频在分片边界补偿空洞/堆积（1000 样本，比 1 更稳）
 *   - asetpts=PTS-STARTPTS            音频时间戳归零并连续化
 *   - -fps_mode cfr                   明确恒定帧率输出（新版 ffmpeg，旧版 -vsync cfr 同义）
 * 从根上解决拼接处跳帧/快进/音画漂移问题。
 */
function buildConcatEncodeArgs(listArg, safe, output, hasAudio, fps) {
  // 跟随源帧率；探测不到时回退 30（仅兜底，绝大多数 HLS 为 25/29.97/30）
  const fpsNum = (fps && fps > 0 && fps <= 240) ? Math.round(fps * 1000) / 1000 : 30;

  // -progress pipe:1：向 stdout 输出机器可读进度（out_time_us/speed），驱动真实进度条。
  // -nostats/-loglevel error：关闭 stderr 的统计刷屏，只保留真正的错误信息用于报错。
  const input = [
    '-y', '-hide_banner', '-loglevel', 'error', '-nostats',
    '-progress', 'pipe:1', '-stats_period', '0.25',
    '-fflags', '+genpts+discardcorrupt', '-err_detect', 'ignore_err'
  ];
  if (safe) input.push('-f', 'concat', '-safe', '0');
  else input.push('-f', 'concat');
  input.push('-i', listArg);

  const vf = [
    'setpts=PTS-STARTPTS',
    `fps=${fpsNum}`, // 跟随源帧率做 CFR 归一化，避免 -r 与源时间基冲突
    'scale=trunc(iw/2)*2:trunc(ih/2)*2' // H.264 需偶数宽高
  ];

  if (hasAudio) {
    return [
      ...input,
      '-vf', vf.join(','),
      '-fps_mode', 'cfr',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-af', 'aresample=async=1000:first_pts=0,asetpts=PTS-STARTPTS',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
      '-movflags', '+faststart',
      output
    ];
  }
  return [
    ...input,
    '-vf', vf.join(','),
    '-fps_mode', 'cfr',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-an',
    '-movflags', '+faststart',
    output
  ];
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

  /**
   * 探测首个分片是否包含音频流（用 ffmpeg -i 解析流信息）。
   * ffmpeg 不带 -i 输出会以非 0 退出，故只解析 stderr 文本。
   */
  _hasAudio(exe, cwd, file) {
    return new Promise((resolve) => {
      let out = '';
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      try {
        const p = spawn(exe, ['-hide_banner', '-i', file], { cwd, windowsHide: true });
        p.stderr.on('data', (d) => {
          out += d.toString();
          // 看到流映射区即可判断，提前结束
          if (/Stream .*Audio:/.test(out)) done(true);
          else if (/At least one output file must be specified|Output #/.test(out)) {
            done(/Stream .*Audio:/.test(out));
          }
        });
        p.on('error', () => done(true));
        p.on('close', () => done(/Stream .*Audio:/.test(out)));
      } catch (_) {
        done(true);
      }
    });
  }

  /**
   * 探测首个分片的视频帧率（用于重编码时跟随源帧率，避免 25fps 源被强制 30fps 而变速卡顿）。
   * 优先用 ffprobe（与 ffmpeg 同目录），拿不到则解析 ffmpeg -i 的 stderr 中的 tbr 帧率。
   * 任何失败都安全返回 null（调用方回退默认帧率）。
   */
  _probeFps(exe, cwd, file) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };

      // 1) 优先 ffprobe（ffmpeg-static 只带 ffmpeg，探测同目录是否有 ffprobe）
      const ffprobe = path.join(path.dirname(exe), 'ffprobe' + (process.platform === 'win32' ? '.exe' : ''));
      if (fs.existsSync(ffprobe)) {
        try {
          const p = spawn(ffprobe, [
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=r_frame_rate,avg_frame_rate',
            '-of', 'default=noprint_wrappers=1',
            file
          ], { cwd, windowsHide: true });
          let out = '';
          p.stdout.on('data', (d) => (out += d.toString()));
          p.on('error', () => parseViaFfmpeg());
          p.on('close', (code) => {
            if (code !== 0) return parseViaFfmpeg();
            // r_frame_rate=25/1 或 30000/1001
            const m = out.match(/r_frame_rate=(\d+)\/(\d+)/);
            if (m && parseInt(m[2], 10) > 0) {
              const f = parseInt(m[1], 10) / parseInt(m[2], 10);
              if (f > 0 && f <= 240) return done(f);
            }
            parseViaFfmpeg();
          });
          return;
        } catch (_) { /* 落到 ffmpeg 解析 */ }
      }

      const parseViaFfmpeg = () => {
        try {
          const p = spawn(exe, ['-hide_banner', '-i', file], { cwd, windowsHide: true });
          let out = '';
          p.stderr.on('data', (d) => {
            out += d.toString();
            // 形如: Stream #0:0: Video: h264 ..., 25 tbr, 90k tbn, 50 tbc
            // 或 29.97 tbr
            if (/tbr/.test(out)) {
              const m = out.match(/,\s*([\d.]+)\s+tbr/);
              if (m) {
                const f = parseFloat(m[1]);
                if (f > 0 && f <= 240) return done(f);
              }
            }
            if (/At least one output file must be specified|Output #/.test(out)) done(null);
          });
          p.on('error', () => done(null));
          p.on('close', () => {
            const m = out.match(/,\s*([\d.]+)\s+tbr/);
            done(m ? parseFloat(m[1]) : null);
          });
        } catch (_) {
          done(null);
        }
      };

      parseViaFfmpeg();
    });
  }

  /**
   * 批量探测各分片时长（秒）。
   * concat demuxer 不会报告总时长，ffmpeg-static 也不带 ffprobe，故按批次调用
   * `ffmpeg -i a -i b ...`（只读各文件头，不解码），从 stderr 的
   * `Input #n ... from '<file>'` 与其后的 `Duration:` 解析每片时长；
   * 无法解析的分片返回 null，由调用方用平均值兜底。
   */
  _probeSegDurations(exe, cwd, files) {
    const BATCH = 32;
    const result = new Array(files.length).fill(null);

    const runBatch = (batch) => new Promise((resolve) => {
      const args = ['-hide_banner'];
      for (const f of batch) args.push('-i', f);
      let out = '';
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(out); } };
      let p;
      try { p = spawn(exe, args, { cwd, windowsHide: true }); }
      catch (_) { return resolve(''); }
      p.stderr.on('data', (d) => { out += d.toString(); });
      p.on('error', done);
      p.on('close', done);
    });

    return (async () => {
      for (let i = 0; i < files.length; i += BATCH) {
        const batch = files.slice(i, i + BATCH);
        const out = await runBatch(batch);
        // 按 `Input #n` 分块，避免分片解析失败时 Duration 与文件错位
        for (const blk of out.split(/Input #\d+/).slice(1)) {
          const fm = blk.match(/from '([^']+)'/);
          const dm = blk.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
          if (!fm || !dm) continue;
          const base = path.basename(fm[1].replace(/\\/g, '/'));
          const j = batch.findIndex((f) => path.basename(f) === base);
          if (j >= 0) {
            const sec = Number(dm[1]) * 3600 + Number(dm[2]) * 60 + parseFloat(dm[3]);
            if (isFinite(sec) && sec > 0) result[i + j] = sec;
          }
        }
      }
      return result;
    })();
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

    const totalFiles = segAbsList.length;
    const job = {
      id, taskId: taskId || null, name: safeOut, workDir: concat.cwd, output: finalOutput,
      status: 'running',
      percent: 0,
      total: total || totalFiles,
      processed: 0,
      segIndex: 0,        // 当前正在合并的分片序号（从 1 起）
      segTotal: totalFiles,
      segName: '',
      message: `合并中（0/${totalFiles}）`,
      startedAt: Date.now()
    };
    this.jobs.set(id, job);
    this.emit('update', job);

    // HLS 分片各自带独立/非连续时间戳，直接 -c copy 拼接会在衔接处出现跳帧、快进。
    // 因此重编码并逐段重置 PTS/DTS，统一帧率/像素格式/采样率，保证音视频严格连续。兼容有/无音频。
    const firstSeg = segAbsList[0];
    const [useAudio, srcFps] = await Promise.all([
      segAbsList.length > 0 ? this._hasAudio(exe, concat.cwd, firstSeg) : Promise.resolve(true),
      segAbsList.length > 0 ? this._probeFps(exe, concat.cwd, firstSeg) : Promise.resolve(null)
    ]);

    // —— 总时长（驱动真实编码进度）——
    // concat demuxer 不报告 Duration，ffmpeg-static 也不带 ffprobe，故批量读取各分片
    // 头部的 Duration 求和，得到与 -progress 的 out_time 同一时间基下的总时长。
    const segDurs = await this._probeSegDurations(exe, concat.cwd, segAbsList);
    const knownDur = segDurs.filter((d) => d && d > 0);
    const avgDur = knownDur.length ? knownDur.reduce((a, b) => a + b, 0) / knownDur.length : 10;
    const durList = segDurs.map((d) => (d && d > 0 ? d : avgDur));
    const cumEnd = [];
    let accDur = 0;
    for (const d of durList) { accDur += d; cumEnd.push(accDur); }
    const totalDurSec = accDur > 0 ? accDur : totalFiles * 10;

    // 跟随源帧率归一化（探测不到时函数内部回退 30）
    const args = buildConcatEncodeArgs(concat.listArg, concat.safe, finalOutput, useAudio, srcFps);

    // 进度：解析 ffmpeg `-progress` 的 out_time，换算为真实百分比；分片序号由累计时长反推
    let lastIndex = 1;
    const onProgress = (block) => {
      let us = parseInt(block.out_time_us, 10);
      if (!isFinite(us)) us = parseInt(block.out_time_ms, 10) * 1000; // 个别版本早期为 N/A，回退毫秒字段
      if (!isFinite(us) || us < 0) return;
      const tSec = us / 1e6;
      let idx = lastIndex;
      while (idx < totalFiles && cumEnd[idx - 1] < tSec) idx++;
      lastIndex = idx;
      // 按已编码媒体时间占比推进，封顶 99，完成时再置 100
      const percent = totalDurSec > 0
        ? Math.max(0, Math.min(99, Math.round((tSec / totalDurSec) * 100))) : 0;
      const spd = (block.speed && block.speed !== 'N/A') ? ` · ${block.speed}` : '';
      job.segIndex = lastIndex;
      job.segName = segAbsList[lastIndex - 1] ? path.basename(segAbsList[lastIndex - 1]) : '';
      job.percent = percent;
      job.message = `合并中（第 ${lastIndex}/${totalFiles} 片${spd}）`;
      this.emit('update', job);
    };

    return new Promise((resolve) => {
      const proc = spawn(exe, args, { cwd: concat.cwd, windowsHide: true });
      this.procs.set(id, proc);
      let stderr = '';
      let outLine = '';
      let block = {};

      // `-progress pipe:1`：每 stats_period 输出一组 key=value，以 progress=continue/end 收尾
      proc.stdout.on('data', (d) => {
        outLine += d.toString();
        let nl;
        while ((nl = outLine.indexOf('\n')) >= 0) {
          const line = outLine.slice(0, nl).trim();
          outLine = outLine.slice(nl + 1);
          const eq = line.indexOf('=');
          if (eq < 0) continue;
          block[line.slice(0, eq)] = line.slice(eq + 1);
          if (line.startsWith('progress=')) { onProgress(block); block = {}; }
        }
        if (outLine.length > 65536) outLine = outLine.slice(-4096);
      });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
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
          job.segIndex = totalFiles;
          const skipTxt = skippedCount > 0 ? `，已跳过 ${skippedCount} 个无效分片` : '';
          job.message = `合并完成（${totalFiles}/${totalFiles} 片${skipTxt}）`;
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
}

/**
 * 构造“快速合并（stream copy）”的 ffmpeg 参数。
 * 仅用于播放预览等临时场景：不重编码、速度快，
 * 但不重建时间戳——同一 m3u8 分片来自同一编码流水线，通常可正常播放；
 * 正式合并请使用 buildConcatEncodeArgs（重编码规整 PTS/DTS）。
 */
function buildConcatCopyArgs(listArg, safe, output) {
  const input = ['-y'];
  if (safe) input.push('-f', 'concat', '-safe', '0');
  else input.push('-f', 'concat');
  input.push('-i', listArg);
  return [
    ...input,
    '-c', 'copy',
    '-movflags', '+faststart',
    output
  ];
}

/**
 * 将指定 ts 片段快速 remux 为临时 MP4，用于播放（Chromium 不稳定支持 MPEG-TS MSE）。
 * 与合并页/自动合并区分：播放预览用 -c copy 极速产出临时文件，不重编码、不规整时间戳。
 * 返回 Promise<{ok, file, error}>
 */
Merger.prototype.buildPreviewMp4 = function (segFiles, outFile) {
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

    // 快速合并：concat demuxer + -c copy，不做转码
    const args = buildConcatCopyArgs(concat.listArg, concat.safe, outFile);
    const proc = spawn(exe, args, { cwd: concat.cwd, windowsHide: true });

    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => resolve({ ok: false, error: err.message }));
    proc.on('close', (code) => {
      try { fs.unlinkSync(concat.listFile); } catch (_) {}
      if (code === 0 && fs.existsSync(outFile)) return resolve({ ok: true, file: outFile });
      const tail = stderr.split('\n').map((x) => x.trim()).filter(Boolean).slice(-3).join(' ');
      resolve({ ok: false, error: tail || ('ffmpeg exit ' + code) });
    });
  });
};

module.exports = Merger;
