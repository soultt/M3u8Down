const fs = require('fs');
const path = require('path');

/**
 * 应用设置持久化：存于 userData/settings.json
 * 同时持有任务索引（taskIndex），使自选保存目录的任务在重启后也能恢复。
 */
class Store {
  constructor(userDataDir) {
    this.dir = userDataDir;
    this.file = path.join(userDataDir, 'settings.json');
    this.data = {
      settings: {
        saveDir: '',          // 默认分片保存目录
        outputDir: '',        // 默认 MP4 输出目录
        concurrency: 8,       // 默认线程数
        autoMerge: true,      // 默认是否自动合并
        ffmpegPath: ''        // 自定义 ffmpeg 路径（通常为空，使用内嵌）
      },
      taskIndex: []           // [{id, workDir}]
    };
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.data.settings = Object.assign({}, this.data.settings, raw.settings || {});
        this.data.taskIndex = Array.isArray(raw.taskIndex) ? raw.taskIndex : [];
      }
    } catch (_) {
      // 损坏则用默认值
    }
  }

  save() {
    try {
      if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (_) {}
  }

  getSettings() {
    return Object.assign({}, this.data.settings);
  }

  updateSettings(patch) {
    this.data.settings = Object.assign({}, this.data.settings, patch || {});
    this.save();
    return this.getSettings();
  }

  getTaskIndex() {
    return this.data.taskIndex.slice();
  }

  upsertTaskIndex(id, workDir) {
    const i = this.data.taskIndex.findIndex((x) => x.id === id);
    if (i >= 0) this.data.taskIndex[i].workDir = workDir;
    else this.data.taskIndex.push({ id, workDir });
    this.save();
  }

  removeTaskIndex(id) {
    this.data.taskIndex = this.data.taskIndex.filter((x) => x.id !== id);
    this.save();
  }
}

module.exports = Store;
