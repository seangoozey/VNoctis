// Exercise the built React player and bridge together, with a filesystem fixture.
const { chromium } = require('playwright');
const { createServer } = require('node:http');
const { readFileSync } = require('node:fs');
const { resolve, extname } = require('node:path');
const assert = require('node:assert/strict');

const dist = resolve(__dirname, '../dist');
let state = { revision: 0, snapshot: null };
const token = `header.${Buffer.from(JSON.stringify({ userId: 'A' })).toString('base64url')}.signature`;
const fixture = `<!DOCTYPE html><html><head><script src="/save-sync.js"></script></head><body><script>
  const files = new Map(), dirs = new Set(['/home/web_user/.renpy']);
  window.FS = {
    readdir: path => ['.', '..', ...new Set([...dirs, ...files.keys()].filter(p => p.startsWith(path + '/')).map(p => p.slice(path.length + 1).split('/')[0]))],
    stat: path => ({ mode: dirs.has(path) ? 0o40777 : 0o100666, mtime: new Date(1000) }),
    isDir: mode => (mode & 0o170000) === 0o40000,
    isFile: mode => (mode & 0o170000) === 0o100000,
    readFile: path => files.get(path), writeFile: (path, bytes) => files.set(path, bytes),
    mkdirTree: path => { const parts = path.split('/'); while(parts.length) { dirs.add(parts.join('/')); parts.pop(); } },
    utime() {}, unlink: path => files.delete(path), rmdir: path => dirs.delete(path),
    syncfs: (populate, callback) => queueMicrotask(() => callback(null))
  };
  window.IDBFS = { getDB: (name, callback) => callback(null, { transaction: () => {
    const tx = { objectStore: () => ({ openCursor: () => {
      const req = { result: null }; queueMicrotask(() => { req.onsuccess(); tx.oncomplete(); }); return req;
    } }) }; return tx;
  } }) };
  Module.FS = FS; Module.preInit.at(-1)();
  FS.syncfs(true, () => document.body.dataset.ready = 'true');
</script></body></html>`;

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const json = value => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
  if (url.pathname === '/api/v1/auth/me') return json({ userId: 'A', username: 'test', role: 'viewer' });
  if (url.pathname === '/api/v1/health') return json({ r2Mode: false });
  if (url.pathname === '/api/v1/library/X') return json({ id: 'X', extractedTitle: 'Fixture', buildStatus: 'built', webBuildPath: '/web-builds/test' });
  if (url.pathname === '/api/v1/games/X/saves') {
    if (request.method === 'GET') return json(state);
    let body = ''; for await (const chunk of request) body += chunk;
    const upload = JSON.parse(body);
    if (upload.revision !== state.revision) { response.statusCode = 409; return json({}); }
    state = { revision: state.revision + 1, snapshot: upload.snapshot }; return json(state);
  }
  if (url.pathname === '/web-builds/test/index.html') {
    response.setHeader('Content-Type', 'text/html'); return response.end(fixture);
  }
  const name = url.pathname.startsWith('/assets/') || url.pathname === '/save-sync.js' ? url.pathname.slice(1) : 'index.html';
  response.setHeader('Content-Type', { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' }[extname(name)] || 'application/octet-stream');
  response.end(readFileSync(resolve(dist, name)));
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}), headless: true });
    const context = await browser.newContext({ viewport: { width: 812, height: 375 }, isMobile: true, hasTouch: true });
    await context.addInitScript(token => localStorage.setItem('vnm-token', token), token);
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/play/X`);
    const toast = page.getByRole('status');
    await toast.waitFor({ state: 'visible' });
    await toast.waitFor({ state: 'hidden', timeout: 10000 });
    const frame = page.frames().find(frame => frame.url().includes('/web-builds/'));
    const write = (name, value) => frame.evaluate(async ({ name, value }) => {
      FS.mkdirTree('/home/web_user/.renpy/game');
      FS.writeFile('/home/web_user/.renpy/game/' + name, new TextEncoder().encode(value));
      await new Promise(resolve => FS.syncfs(false, resolve));
    }, { name, value });
    const waitRevision = async revision => {
      const deadline = Date.now() + 15000;
      while (state.revision < revision && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(state.revision, revision);
    };
    await write('persistent', 'seen text'); await waitRevision(1);
    assert.equal(await toast.count(), 0, 'persistent-only upload must remain quiet');
    await write('1-1-LT1.save', 'numbered save'); await waitRevision(2);
    await toast.waitFor({ state: 'visible', timeout: 2000 });
    assert.match(await toast.innerText(), /Save synced/);
    await toast.waitFor({ state: 'hidden', timeout: 6000 });
    await write('quick-1-LT1.save', 'quick save'); await waitRevision(3);
    await toast.waitFor({ state: 'visible', timeout: 2000 });
    assert.match(await toast.innerText(), /Save synced/);
    await page.getByRole('button', { name: 'Dismiss save sync notice' }).click();
    await toast.waitFor({ state: 'hidden' });
    assert.deepEqual(errors, []);
    console.log('PASS: built mobile player shows consecutive save acknowledgements, hides them, and keeps persistent-only sync quiet');
  } finally { if (browser) await browser.close(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
