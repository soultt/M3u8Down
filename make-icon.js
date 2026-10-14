/* 用 Electron 的 nativeImage 由 PNG 生成多尺寸 Windows .ico（无需第三方依赖）
 * 用法: npx electron make-icon.js
 */
const fs = require('fs');
const path = require('path');
const { app, nativeImage } = require('electron');

app.disableHardwareAcceleration();

app.whenReady().then(() => {
  const src = path.join(__dirname, '图标.png');
  const outDir = path.join(__dirname, 'build');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, 'icon.ico');

  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const base = nativeImage.createFromPath(src);
  const pngs = sizes.map((s) => {
    const img = base.resize({ width: s, height: s, quality: 'best' });
    return { size: s, buf: img.toPNG() };
  });

  // 手工组装 ICO（PNG 内嵌格式，Vista+ 支持，electron-builder 接受）
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);   // reserved
  header.writeUInt16LE(1, 2);   // type: icon
  header.writeUInt16LE(pngs.length, 4);

  const dirEntries = [];
  const imageDatas = [];
  let offset = 6 + pngs.length * 16;
  pngs.forEach((p) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(p.size >= 256 ? 0 : p.size, 0);  // width (0 => 256)
    entry.writeUInt8(p.size >= 256 ? 0 : p.size, 1);  // height
    entry.writeUInt8(0, 2);   // palette
    entry.writeUInt8(0, 3);   // reserved
    entry.writeUInt16LE(1, 4);  // planes
    entry.writeUInt16LE(32, 6); // bpp
    entry.writeUInt32LE(p.buf.length, 8);  // size
    entry.writeUInt32LE(offset, 12);       // offset
    offset += p.buf.length;
    dirEntries.push(entry);
    imageDatas.push(p.buf);
  });

  fs.writeFileSync(out, Buffer.concat([header, ...dirEntries, ...imageDatas]));
  console.log('ICO written:', out);
  app.quit();
});
