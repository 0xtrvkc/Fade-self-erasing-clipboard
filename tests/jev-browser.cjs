/* Real Chromium integration checks with synthetic network responses; no live AI calls. */
'use strict';
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  http = require('node:http'),
  vm = require('node:vm');
const { chromium } = require(process.env.JEV_PLAYWRIGHT_PACKAGE || 'playwright');
const root = process.cwd(),
  watch = fs.existsSync(path.join(root, 'cloud/worker.js')),
  web = watch ? path.join(root, 'public') : root;
const scope = { URL };
vm.createContext(scope);
for (const f of ['contract.js', 'feature.js'])
  vm.runInContext(fs.readFileSync(path.join(web, 'jev', f), 'utf8'), scope);
const F = scope.JevFeature,
  id = F.id;
let server,
  browser,
  calls = 0,
  mode = 'ok',
  pending;
function answer(input) {
  const spec = F.build(input);
  const choices =
    {
      'evidence-audit': { relation0: 'supported', source0: 'item0' },
      'journal-review': { behavior0: 'departure' },
      'learning-coach': { concept: 'expectancy' },
      'research-router': { route: 'touch' },
      'loan-goals': { goal: 'liquidation' },
      'alert-parser': { direction0: 'up', direction1: 'down' },
    }[id] || {};
  return {
    model: 'fixture-not-live-jev',
    answers: Object.fromEntries(
      Object.entries(spec.questions).map(([key, q]) => {
        if (q.type === 'score')
          return [
            key,
            {
              type: 'score',
              score: 3,
              confidence: 0.95,
              probabilities: { 0: 0, 1: 0, 2: 0, 3: 1 },
            },
          ];
        const selected = choices[key] || Object.keys(q.criteria)[0];
        return [
          key,
          {
            type: 'choice',
            choice: selected,
            confidence: 0.95,
            probabilities: Object.fromEntries(
              Object.keys(q.criteria).map((k) => [k, k === selected ? 1 : 0]),
            ),
          },
        ];
      }),
    ),
  };
}
async function prepare(page) {
  if (id === 'journal-review') {
    const csv =
      'Open Date,Close Date,Symbol,Action,Units/Lots,Profit,Commission,Swap\n10/01/2026 00:00,10/01/2026 00:00,,Deposit,,10000,0,0\n10/02/2026 10:00,10/02/2026 10:10,XAUUSD,Buy,0.1,50,0,0\n10/02/2026 11:00,10/02/2026 11:10,XAUUSD,Sell,0.1,-25,0,0\n10/03/2026 10:00,10/03/2026 10:10,XAUUSD,Buy,0.1,50,0,0\n';
    await page
      .locator('#auditFile')
      .setInputFiles({ name: 'synthetic.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await page.waitForFunction(() => !document.getElementById('tabBtnQuant').hidden);
    await page.locator('#tabBtnQuant').click();
  }
  if (id === 'vault-search')
    await page.evaluate(() => {
      currentUid = OWNER_UID;
      activeScope = 'vault';
      document.getElementById('signIn').hidden = true;
      document.getElementById('clips').hidden = true;
      document.getElementById('vault').hidden = false;
      scopes.vault.items = {
        demo: {
          type: 'text',
          title: 'Deployment fix',
          content: 'Cloudflare Worker deployment',
          keptAt: Date.now(),
          group: {
            id: 'dev',
            name: 'Development',
            color: '#1f7a4d',
            order: 0,
            updatedAt: Date.now(),
          },
        },
      };
      render(scopes.vault);
    });
  if (id === 'learning-coach') {
    await page.evaluate(() => {
      state.route = 'quant';
      state.screen = 4;
      render();
    });
    const blocked = await page.evaluate(() => {
      try {
        JevApp.questionContext();
        return false;
      } catch {
        return true;
      }
    });
    assert.equal(blocked, true, 'Unanswered quiz reference is unavailable to coach');
    await page.locator('#stage .choice').first().click();
  }
  const values = {
    'evidence-audit': {
      claims: 'Commission is explicitly configured',
      evidence: 'strategy("demo", commission_value=0.1)',
    },
    'project-finder': { query: 'Trading consistency and drawdown' },
    'vault-search': { query: 'Cloudflare fix' },
    'journal-review': {
      plan: 'Enter only after the setup closes. No exceptions.',
      notes: 'Entered before the setup closed to chase the price.',
    },
    'learning-coach': { explanation: 'An 80% win rate always guarantees profit.' },
    'research-router': { query: 'Compare downside touches with expiry breaches' },
    'loan-goals': { goal: 'Compare liquidation exposure' },
    'alert-parser': { instruction: 'Alert above $4,200 and below $4,000' },
  }[id];
  for (const [key, value] of Object.entries(values)) await page.locator('#jev-' + key).fill(value);
  if (id === 'vault-search') {
    await page.getByRole('button', { name: 'Choose notes to search', exact: true }).click();
    await page.locator('.jev-checklist input').first().check();
  }
  await page.locator('.jev-panel > details').first().locator('summary').click();
  await page.locator('#jev-endpoint').fill('/api/jev');
  if (F.private && !watch) await page.locator('#jev-token').fill('x'.repeat(32));
}
async function run(viewport) {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce' }),
    page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.pathname === '/api/jev') {
      calls++;
      if (mode === 'hold') {
        await new Promise((resolve) => (pending = resolve));
      }
      if (mode === 'error')
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Jev unavailable; existing tools still work.' }),
        });
      if (mode === 'malformed')
        return route.fulfill({
          contentType: 'application/json',
          body: '{"model":"bad","answers":{}}',
        });
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(answer(request.postDataJSON().input)),
      });
    }
    if (watch && url.pathname === '/api/state')
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          quote: { price: 4100, updatedAt: Date.now() },
          fresh: true,
          emailReady: true,
          email: 'synthetic@example.com',
          levels: [],
          monitor: { mode: 'cloud', lastCheckAt: Date.now() },
        }),
      });
    if (url.hostname === '127.0.0.1') return route.continue();
    return route.abort();
  });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#jev-run', { state: 'attached' });
  await prepare(page);
  assert.ok(await page.locator('#jev-run').isVisible(), 'Jev control visible in its intended view');
  const before = calls;
  await page.locator('#jev-run').click();
  assert.match(await page.locator('#jev-status').innerText(), /checkbox/);
  assert.equal(calls, before, 'No inference without consent');
  await page.locator('#jev-preview-button').click();
  assert.match(await page.locator('#jev-status').innerText(), /No request sent/);
  assert.equal(calls, before, 'Preview is local');
  await page.locator('#jev-consent').check();
  await page.locator('#jev-run').click();
  await page.waitForFunction(() =>
    document.getElementById('jev-status').textContent.includes('fixture-not-live-jev'),
  );
  assert.ok((await page.locator('#jev-results li').count()) > 0);
  assert.equal(calls, before + 1);
  if (id === 'research-router') {
    const values = await page.evaluate(() =>
      ['lowerPct', 'upperPct', 'capitalMode'].map((id) => document.getElementById(id).value),
    );
    await page.locator('.jev-action').first().click();
    assert.deepEqual(
      await page.evaluate(() =>
        ['lowerPct', 'upperPct', 'capitalMode'].map((id) => document.getElementById(id).value),
      ),
      values,
    );
  } else if (id === 'loan-goals') {
    const values = await page.evaluate(() =>
      [...document.querySelectorAll('[data-field]')].map((x) => x.value),
    );
    await page.locator('.jev-action').first().click();
    assert.equal(await page.locator('#pane-risk').getAttribute('hidden'), null);
    assert.deepEqual(
      await page.evaluate(() => [...document.querySelectorAll('[data-field]')].map((x) => x.value)),
      values,
    );
  } else if (id === 'alert-parser') {
    await page.locator('.jev-action').first().click();
    assert.equal(await page.locator('#p1').inputValue(), '4200');
    assert.equal(await page.locator('#p2').inputValue(), '4000');
    assert.match(await page.locator('#jev-status').innerText(), /not armed/);
    assert.equal(calls, before + 1);
  } else if (id === 'vault-search') {
    await page.locator('.jev-action').first().click();
    assert.equal(
      await page.evaluate(() => scopes.vault.items.demo.content),
      'Cloudflare Worker deployment',
    );
  }
  await page.locator('#jev-run').click();
  await page.waitForFunction(() => !document.getElementById('jev-run').disabled);
  assert.equal(calls, before + 1, 'Unchanged requests use session cache');
  // Clear cache via context invalidation, and verify failures restore the control.
  await page.evaluate(() => window.dispatchEvent(new Event('jev:context')));
  mode = 'error';
  await page.locator('#jev-consent').check();
  await page.locator('#jev-run').click();
  await page.waitForFunction(() =>
    document.getElementById('jev-status').textContent.includes('Jev unavailable'),
  );
  assert.equal(await page.locator('#jev-results li').count(), 0);
  assert.ok(await page.locator('#jev-run').isEnabled());
  mode = 'malformed';
  await page.locator('#jev-run').click();
  await page.waitForFunction(() =>
    document.getElementById('jev-status').textContent.includes('Missing or mismatched'),
  );
  assert.ok(await page.locator('#jev-run').isEnabled());
  mode = 'hold';
  const count = calls;
  await page.locator('#jev-run').click();
  await page.waitForFunction(() => document.getElementById('jev-run').disabled);
  for (let i = 0; i < 100 && !pending; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(pending);
  await page.locator('#jev-clear').click();
  pending();
  pending = null;
  mode = 'ok';
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#jev-results li').count(), 0);
  assert.ok(await page.locator('#jev-run').isEnabled());
  assert.equal(calls, count + 1);
  assert.deepEqual(errors, [], 'No uncaught JavaScript errors');
  const geometry = await page.locator('.jev-panel').evaluate((el) => ({
    width: el.getBoundingClientRect().width,
    overflow: el.scrollWidth > el.clientWidth + 1,
  }));
  assert.ok(geometry.width > 100 && geometry.width <= viewport.width);
  assert.equal(geometry.overflow, false, 'Jev panel has no horizontal overflow');
  fs.mkdirSync('test-artifacts', { recursive: true });
  await page
    .locator('.jev-panel')
    .screenshot({ path: 'test-artifacts/jev-' + viewport.width + '.png' });
  console.log(
    'PASS real Chromium ' +
      id +
      ' ' +
      viewport.width +
      'px: consent, preview, typed result, bounded actions, cache, service failure, malformed response, cancellation, layout',
  );
  if (id === 'project-finder' && viewport.width === 1280) {
    await page.evaluate(() => activateFunMode());
    await page.waitForSelector('#normalModeBtn');
    await page.waitForSelector('#jev-run');
    assert.ok(await page.locator('#jev-run').isVisible());
    assert.deepEqual(errors, []);
    console.log('PASS project finder loads in Fun mode');
  }
  await context.close();
}
let base;
(async () => {
  try {
    server = http.createServer((req, res) => {
      const relative = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const filename = path.resolve(web, '.' + (relative === '/' ? '/index.html' : relative));
      if (!filename.startsWith(web + path.sep)) {
        res.writeHead(403).end();
        return;
      }
      try {
        const bytes = fs.readFileSync(filename);
        res.setHeader(
          'Content-Type',
          filename.endsWith('.js')
            ? 'text/javascript'
            : filename.endsWith('.css')
              ? 'text/css'
              : filename.endsWith('.json')
                ? 'application/json'
                : 'text/html',
        );
        res.end(bytes);
      } catch {
        res.writeHead(404).end();
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + server.address().port + '/';
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    await run({ width: 1280, height: 900 });
    await run({ width: 390, height: 844 });
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  }
})();
