const { protocol } = require('electron');
const fs = require('fs');
const path = require('path');

function registerSegProtocol() {
  // seg://file?path=<encoded absolute path>
  protocol.registerFileProtocol('seg', (request, callback) => {
    try {
      const u = new URL(request.url);
      const p = path.normalize(decodeURIComponent(u.searchParams.get('path') || ''));
      if (p && fs.existsSync(p)) return callback({ path: p });
    } catch (_) {}
    callback({ error: -6 });
  });
}

module.exports = { registerSegProtocol };
