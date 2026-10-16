#!/usr/bin/env node
/*
 * 发布脚本：为当前 package.json 版本创建/更新 GitHub Release，并上传 dist/ 产物。
 *
 * 为什么用 curl 而不是 Node fetch / PowerShell：
 *   1) 编码：Windows PowerShell 5.1 下 `Invoke-RestMethod -Body <字符串>` 会按本地代码页
 *      编码，中文描述会整体变成 "?"。本脚本把 JSON 写入 UTF-8 文件再用
 *      `curl --data-binary @file` 以原始字节发送，彻底规避乱码。
 *   2) 证书：部分环境存在 TLS 拦截（企业代理 CA 只在 Windows 证书库），Node 自带的
 *      CA 包会报 UNABLE_TO_VERIFY_LEAF_SIGNATURE；curl 走系统证书库，可直接连通
 *      （Windows 上附加 --ssl-no-revoke 规避吊销检查报错）。
 *
 * 用法：
 *   npm run release                      # 发布当前版本（创建/更新 release + 上传 dist 产物）
 *   node scripts/release.js --dry-run    # 只打印将要执行的操作，不发任何写请求
 *   node scripts/release.js --notes release-notes.md   # 用文件作为 Release 描述（UTF-8）
 *   node scripts/release.js --draft      # 创建为草稿
 *   node scripts/release.js --prerelease # 标记为预发布
 *   node scripts/release.js --overwrite  # 已存在的同名资产先删除再上传
 *   node scripts/release.js --assets dist/a.exe,dist/b.exe
 *
 * Token 来源（按优先级）：环境变量 GITHUB_TOKEN / GH_TOKEN，否则 `git credential fill`
 * （即复用 git push 已缓存的凭据）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, execFileSync } = require('child_process');

const API = 'https://api.github.com';
const UPLOAD = 'https://uploads.github.com';
const CURL = process.platform === 'win32' ? 'curl.exe' : 'curl';
const CURL_TLS = process.platform === 'win32' ? ['--ssl-no-revoke'] : [];

function parseArgs(argv) {
  const a = { dryRun: false, draft: false, prerelease: false, overwrite: false, notes: null, assets: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--dry-run') a.dryRun = true;
    else if (k === '--draft') a.draft = true;
    else if (k === '--prerelease') a.prerelease = true;
    else if (k === '--overwrite') a.overwrite = true;
    else if (k === '--notes') a.notes = argv[++i];
    else if (k === '--assets') a.assets = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else { console.error('未知参数: ' + k); process.exit(2); }
  }
  return a;
}

function sh(cmd, opts) { return execSync(cmd, { encoding: 'utf8', ...opts }).trim(); }

function detectRepo() {
  const url = sh('git remote get-url origin');
  const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (!m) throw new Error('无法从 origin 解析 GitHub 仓库: ' + url);
  return { owner: m[1], repo: m[2] };
}

function getToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  try {
    const out = execSync('git credential fill', {
      input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8'
    });
    const m = out.match(/^password=(.+)$/m);
    if (m) return m[1].trim();
  } catch (_) {}
  return null;
}

function defaultAssets() {
  return ['dist/M3u8Down-Setup.exe', 'dist/M3u8Down-portable.exe'].filter((p) => fs.existsSync(p));
}

function defaultBody(version) {
  return `## v${version}\n\n> 由 scripts/release.js 自动创建，可在 Release 页面编辑补充变更说明。\n`;
}

/**
 * 调用 curl 发请求。bodyFile/outFile 均为本地路径（自动转为正斜杠）。
 * 返回 HTTP 状态码；响应体写入 outFile。
 */
function curl(token, method, url, { bodyFile = null, outFile, contentType = null } = {}) {
  const args = [
    '-sS', ...CURL_TLS, '--retry', '2', '--retry-delay', '2',
    '-X', method,
    '-H', 'Authorization: token ' + token,
    '-H', 'User-Agent: m3u8down-release',
    '-H', 'Accept: application/vnd.github+json',
    '-o', outFile.replace(/\\/g, '/'),
    '-w', '%{http_code}'
  ];
  if (contentType) args.push('-H', 'Content-Type: ' + contentType);
  if (bodyFile) args.push('--data-binary', '@' + bodyFile.replace(/\\/g, '/'));
  args.push(url);
  const code = execFileSync(CURL, args, { encoding: 'utf8' }).trim();
  return parseInt(code, 10);
}

async function main() {
  const args = parseArgs(process.argv);
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const version = pkg.version;
  const tag = 'v' + version;
  const { owner, repo } = detectRepo();

  const token = getToken();
  if (!token) {
    console.error('未找到 GitHub token：请设置环境变量 GITHUB_TOKEN，或先执行一次 git push 以缓存凭据。');
    process.exit(1);
  }

  const assets = args.assets || defaultAssets();
  if (!assets.length) { console.error('未找到可上传的产物，请先执行 npm run dist。'); process.exit(1); }

  // 以 UTF-8 读取描述文件；随后写入 UTF-8 临时文件由 curl 原样发送，不会出现 "?" 乱码
  const notesFromFile = args.notes ? fs.readFileSync(args.notes, 'utf8') : null;

  console.log('仓库 : ' + owner + '/' + repo);
  console.log('版本 : ' + version + '  (tag ' + tag + ')');
  console.log('产物 : ' + assets.join(', '));
  console.log('描述 : ' + (args.notes ? ('读取自 ' + args.notes) : '默认（更新 release 时保留原有描述）'));
  console.log('模式 : ' + (args.dryRun ? 'dry-run' : 'publish') + (args.draft ? ' / draft' : '') + (args.prerelease ? ' / prerelease' : ''));

  if (args.dryRun) { console.log('\n[dry-run] 跳过所有网络写入。'); return; }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm3u8rel-'));
  const outFile = path.join(tmp, 'resp.json');
  const jsonBody = (obj) => { const f = path.join(tmp, 'body.json'); fs.writeFileSync(f, JSON.stringify(obj), 'utf8'); return f; };

  try {
    // 1) 查询 / 创建 / 更新 Release
    let rel = null;
    let code = curl(token, 'GET', `${API}/repos/${owner}/${repo}/releases/tags/${tag}`, { outFile });
    if (code === 200) rel = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    else if (code !== 404) throw new Error('查询 release 失败: HTTP ' + code + ' ' + safeRead(outFile));

    if (!rel) {
      const body = jsonBody({
        tag_name: tag, target_commitish: 'main', name: 'M3u8Down ' + tag,
        body: notesFromFile != null ? notesFromFile : defaultBody(version),
        draft: args.draft, prerelease: args.prerelease
      });
      code = curl(token, 'POST', `${API}/repos/${owner}/${repo}/releases`, { bodyFile: body, outFile, contentType: 'application/json; charset=utf-8' });
      if (code !== 201) throw new Error('创建 release 失败: HTTP ' + code + ' ' + safeRead(outFile));
      rel = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      console.log('✓ 已创建 release #' + rel.id);
    } else {
      // 更新时仅在显式提供 --notes 才覆盖描述，避免清掉手工编辑的内容
      const patch = { name: 'M3u8Down ' + tag, draft: args.draft, prerelease: args.prerelease };
      if (notesFromFile != null) patch.body = notesFromFile;
      code = curl(token, 'PATCH', `${API}/repos/${owner}/${repo}/releases/${rel.id}`, { bodyFile: jsonBody(patch), outFile, contentType: 'application/json; charset=utf-8' });
      if (code !== 200) throw new Error('更新 release 失败: HTTP ' + code + ' ' + safeRead(outFile));
      rel = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      console.log('✓ 已更新 release #' + rel.id + (notesFromFile != null ? '（描述已刷新）' : ''));
    }

    // 2) 上传产物
    const existing = new Map((rel.assets || []).map((a) => [a.name, a]));
    for (const file of assets) {
      const name = path.basename(file);
      if (!fs.existsSync(file)) { console.warn('✗ 跳过（不存在）: ' + file); continue; }
      const old = existing.get(name);
      if (old && !args.overwrite) { console.log('• 已存在，跳过: ' + name + '（用 --overwrite 覆盖）'); continue; }
      if (old && args.overwrite) {
        const dc = curl(token, 'DELETE', `${API}/repos/${owner}/${repo}/releases/assets/${old.id}`, { outFile });
        if (dc !== 204 && dc !== 404) throw new Error('删除旧资产失败: HTTP ' + dc);
        console.log('• 已删除旧资产: ' + name);
      }
      // 直接以产物文件为请求体，原始字节发送
      const uc = curl(token, 'POST', `${UPLOAD}/repos/${owner}/${repo}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}`,
        { bodyFile: file, outFile, contentType: 'application/octet-stream' });
      if (uc !== 201) throw new Error(`上传 ${name} 失败: HTTP ${uc} ${safeRead(outFile)}`);
      const info = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      console.log(`✓ 已上传 ${name}  ${(info.size / 1048576).toFixed(1)} MB`);
    }

    console.log('\n完成: ' + rel.html_url);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
}

function safeRead(f) { try { return fs.readFileSync(f, 'utf8').slice(0, 300); } catch (_) { return ''; } }

main().catch((e) => { console.error('发布失败: ' + (e && e.message ? e.message : e)); process.exit(1); });
