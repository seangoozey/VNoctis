// Exercise real browser workers, IndexedDB, and asynchronous save writes.
const { chromium } = require('playwright');
const { createServer } = require('node:http');
const { readFileSync } = require('node:fs');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const bridge = readFileSync(require('node:path').resolve(__dirname, '../public/save-sync.js'));
const playerTest = readFileSync(require('node:path').resolve(__dirname, 'player-integration.cjs'), 'utf8');
const fixture = vm.runInNewContext(playerTest.match(/const fixture = (`[\s\S]*?`);/)[1]);
const token = `header.${Buffer.from(JSON.stringify({ userId: 'A' })).toString('base64url')}.signature`;
let state, uploads;
const server = createServer(async (req, res) => {
  const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
  if (req.url === '/save-sync.js') { res.setHeader('Content-Type', 'application/javascript'); return res.end(bridge); }
  if (req.url.startsWith('/api/')) {
    if (req.method === 'GET') return json({ ...state, deltaUploads: false });
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); uploads.push(body);
    state = { revision: state.revision + 1, snapshot: body.snapshot };
    return json({ revision: state.revision, disposition: 'current' });
  }
  res.setHeader('Content-Type', 'text/html');
  res.end(req.url.startsWith('/game') ? fixture : '<iframe src="/game?vnmGame=X&vnmUser=A"></iframe>');
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
    for (const mode of ['worker', 'blocked', 'crash']) {
      state = { revision: 0, snapshot: null }; uploads = [];
      const context = await browser.newContext();
      await context.addInitScript(({ token, mode }) => {
        localStorage.setItem('vnm-token', token);
        window.workerOperations = []; window.mainEncodings = 0; window.mainLargeJson = 0;
        const encode = window.btoa; window.btoa = value => { mainEncodings++; return encode(value); };
        const stringify = JSON.stringify;
        JSON.stringify = (...args) => {
          if (args[0]?.snapshot || (Array.isArray(args[0]) && typeof args[0][0]?.[1] === 'string' && args[0][0][1].length > 10000)) mainLargeJson++;
          return stringify(...args);
        };
        const NativeWorker = Worker;
        window.Worker = class extends NativeWorker {
          constructor(url) {
            if (mode === 'blocked') throw new Error('Workers blocked');
            super(url);
            this.crashed = false;
          }
          postMessage(message, transfers) {
            workerOperations.push(message.operation);
            if (mode === 'worker' && message.operation === 'snapshot' && workerOperations.filter(operation => operation === 'snapshot').length === 3) {
              // A later write after the acknowledgement scan has captured its
              // bytes must not be cleared by that scan's asynchronous result.
              window.delaySaveWorker = 150;
              setTimeout(() => {
                savedBytes[0] = 11;
                FS.writeFile('/home/web_user/.renpy/game/1.save', savedBytes);
                FS.syncfs(false, () => {});
              }, 10);
            }
            if (mode === 'crash' && !this.crashed) {
              this.crashed = true;
              setTimeout(() => this.onerror({ preventDefault() {} }), 0);
              return;
            }
            const delay = window.delaySaveWorker || 0;
            window.delaySaveWorker = 0;
            if (delay) setTimeout(() => super.postMessage(message, transfers), delay);
            else super.postMessage(message, transfers);
          }
        };
      }, { token, mode });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      const frame = page.frames().find(frame => frame.url().includes('/game?'));
      await frame.waitForFunction(() => document.body.dataset.ready === 'true');
      await frame.evaluate(mode => {
        FS.mkdirTree('/home/web_user/.renpy/game');
        window.savedBytes = new Uint8Array((mode === 'worker' ? 12 : 1) * 1024 * 1024).fill(7);
        window.mainEncodings = 0; window.mainLargeJson = 0;
        window.animationTicks = 0;
        const animate = () => { animationTicks++; requestAnimationFrame(animate); }; requestAnimationFrame(animate);
        window.delaySaveWorker = mode === 'worker' ? 150 : 0;
        FS.writeFile('/home/web_user/.renpy/game/1.save', savedBytes);
        FS.syncfs(false, () => {});
      }, mode);
      // Change the engine's bytes while the previous snapshot is in flight.
      if (mode === 'worker') {
        await frame.waitForTimeout(30);
        await frame.evaluate(() => {
          savedBytes[0] = 9;
          FS.writeFile('/home/web_user/.renpy/game/1.save', savedBytes);
          FS.syncfs(false, () => {});
        });
      }
      const deadline = Date.now() + 15000;
      const expected = mode === 'worker' ? 11 : 7;
      while ((!state.snapshot || Buffer.from(state.snapshot.files[0].data, 'base64')[0] !== expected) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      assert.equal(Buffer.from(state.snapshot?.files[0]?.data || '', 'base64')[0], expected);
      const metrics = await frame.evaluate(() => ({ operations: workerOperations, mainEncodings, mainLargeJson, animationTicks,
        firstByte: FS.readFile('/home/web_user/.renpy/game/1.save')[0], bytes: FS.readFile('/home/web_user/.renpy/game/1.save').length }));
      assert.equal(metrics.firstByte, expected, 'worker transfer must not detach or mutate engine memory');
      assert.ok(metrics.bytes > 0);
      if (mode === 'worker') {
        assert.ok(metrics.operations.includes('snapshot') && metrics.operations.includes('json'));
        assert.equal(metrics.mainEncodings, 0, 'base64 encoding belongs to the worker');
        assert.equal(metrics.mainLargeJson, 0, 'large JSON serialization belongs to the worker');
        assert.ok(metrics.animationTicks > 1, 'animation continues while save processing is pending');
        assert.ok(uploads.length >= 2, 'a save during preparation must follow the older captured snapshot');
      }
      assert.deepEqual(errors, []);
      console.log(`PASS ${mode}: ${JSON.stringify(metrics)}`);
      await context.close();
    }
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
