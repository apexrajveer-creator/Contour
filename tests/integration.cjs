// Browser regression suite against the synthetic preview, with controlled IPC failures/delays.
// npm install; npx playwright install chromium; npm run test:ui
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const ui = path.resolve(__dirname, '../ui');
(async () => {
  let options = { headless: true };
  if (process.env.CONTOUR_TEST_CHROMIUM_MODULE) {
    const binary = (await import(process.env.CONTOUR_TEST_CHROMIUM_MODULE)).default;
    options = { ...options, executablePath: await binary.executablePath(), args: binary.args };
  }
  const browser = await chromium.launch(options);
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.route('http://contour.test/**', async route => {
    const file = new URL(route.request().url()).pathname.replace(/^\//, '') || 'index.html';
    if (file === 'mock.js') {
      const wrapper = `
window.__test = { calls: [], fail: {}, hold: {}, release: {} };
const testNative = window.__TAURI__.core.invoke;
window.__TAURI__.core.invoke = async (cmd, args = {}) => {
  window.__test.calls.push({cmd, args: structuredClone(args)});
  if (window.__test.hold[cmd]) { delete window.__test.hold[cmd]; await new Promise(resolve => window.__test.release[cmd] = resolve); }
  if (window.__test.fail[cmd]) { const message = window.__test.fail[cmd]; delete window.__test.fail[cmd]; throw message; }
  return testNative(cmd, args);
};`;
      await route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(ui, file), 'utf8') + wrapper });
    } else await route.fulfill({ path: path.join(ui, file) });
  });
  const check = name => console.log('PASS ' + name);
  const idle = () => page.waitForFunction(() => !S.busy && !S.preflighting && !MASH.pending);
  const mode = async name => { await page.locator(`.mode [data-mode="${name}"]`).click(); await page.waitForTimeout(330); };
  const confirmIfOpen = async () => {
    await page.waitForTimeout(100);
    if (await page.locator('#confirm-dialog').evaluate(el => el.open)) await page.locator('#confirm-yes').click();
  };
  try {
    await page.goto('http://contour.test/');
    await page.waitForFunction(() => S.devices && document.getElementById('task-stage').textContent.includes('Models ready'));
    assert.equal(await page.locator('#simple-run').isDisabled(), true);
    check('startup prerequisites and unavailable actions');

    await page.locator('#choose').click(); await page.waitForFunction(() => S.source && !S.busy);
    await page.locator('#simple-run').click(); await page.waitForFunction(() => S.busy);
    await mode('studio'); await page.waitForFunction(() => S.separated && !S.busy);
    assert.deepEqual(await page.evaluate(() => S.tracks.map(t => [t.id, t.mute])), [['original', true], ['vocals', true], ['instrumental', false]]);
    assert.equal(await page.evaluate(() => S.quality), 'balanced');
    check('Simple job retains karaoke preset after navigating to Studio');

    await page.evaluate(() => { S.projectPath = 'previous.contour'; });
    await page.locator('#studio-choose').click(); await confirmIfOpen(); await page.waitForFunction(() => !S.busy && !S.separated);
    assert.equal(await page.evaluate(() => S.projectPath), null);
    check('new imports clear the previous project identity');

    await mode('mashup');
    await page.evaluate(() => mashDrop(['first.wav', 'second.wav'])); await idle();
    assert.equal(await page.evaluate(() => !!MASH.a && !!MASH.b), true);
    assert.equal(await page.evaluate(() => __test.calls.filter(c => c.cmd === 'mashup_load').length), 2);
    check('two-file drop awaits both imports');

    await page.locator('#mash-run').click(); await confirmIfOpen(); await page.waitForFunction(() => S.busy);
    assert.equal(await page.locator('#task-cancel').isEnabled(), true);
    assert.deepEqual(await page.evaluate(() => {setProgress(.42,'Vocals song · Voc FT','42%');return [parseFloat(document.querySelector('#mash-progress i').style.width),document.getElementById('task-progress').getAttribute('aria-valuenow')];}), [42,'42']);
    await page.locator('#task-cancel').click(); await idle();
    assert.equal(await page.evaluate(() => MASH.result), null);
    check('Mashup shares real progress and cancellation controls');

    await page.locator('#mash-run').click(); await confirmIfOpen();
    await page.waitForFunction(() => MASH.result && !S.busy);
    const simpleRows = await page.locator('#result-list .result').count();
    assert.equal(simpleRows, 2);
    await mode('studio'); await page.locator('#lanes .lane').nth(1).locator('.m').click();
    assert.equal(await page.locator('#mash-rows .listen').first().getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('#result-list .listen').first().getAttribute('aria-pressed'), 'false');
    check('Mashup results and Studio mute edits propagate to both other views');

    await mode('mashup');
    await page.evaluate(() => { __test.hold.mashup_render = true; });
    await page.locator('#mash-key-up').click(); await page.waitForFunction(() => MASH.rendering);
    await page.locator('#mash-key-up').click();
    assert.equal(await page.locator('#mash-save').isDisabled(), true);
    await page.evaluate(() => __test.release.mashup_render());
    await idle();
    assert.equal(await page.evaluate(() => MASH.result.plan.semitones), 2);
    assert.equal(await page.evaluate(() => S.tracks.find(t => t.id === 'vocals').mute), true);
    check('latest adjustment wins and mixer edits survive successive renders');

    const before = await page.evaluate(() => S.tracks.map(t => t.id));
    await page.evaluate(() => { __test.fail.mashup_render = 'Injected render failure'; });
    await page.locator('#mash-key-up').click(); await idle();
    assert.deepEqual(await page.evaluate(() => S.tracks.map(t => t.id)), before);
    assert.equal(await page.evaluate(() => MASH.settings.semitones), 2);
    assert.equal(await page.locator('#task-retry').isVisible(), true);
    await page.locator('#task-retry').click(); await idle();
    assert.equal(await page.evaluate(() => MASH.result.plan.semitones), 3);
    check('failed adjustments retain the last result and retry the requested settings');

    await page.locator('#slot-a .mash-pick').click(); await idle();
    assert.equal(await page.locator('#mash-stale').isVisible(), true);
    assert.equal(await page.locator('#mash-run').textContent(), 'Rebuild mashup');
    assert.equal(await page.locator('#mash-key-up').isDisabled(), true);
    assert.equal(await page.evaluate(() => { const current = MASH.a; MASH.a = { ...current, name: 'Replacement song.wav' }; const saved = projectState().mashup.a.name; MASH.a = current; return saved === MASH.result.a.name; }), true);
    await page.locator('#mash-run').click(); await confirmIfOpen(); await idle();
    check('replacing sources marks the old result stale until rebuilt');

    await page.locator('#mash-save-project').click(); await idle();
    assert.ok(await page.evaluate(() => S.projectPath));
    await page.evaluate(() => openProject()); await idle();
    assert.equal(await page.evaluate(() => S.mode), 'studio');
    assert.equal(await page.evaluate(() => S.kind), 'rendered-mashup');
    assert.equal(await page.evaluate(() => S.separated), true);
    assert.match(await page.locator('#toast').textContent(), /saved mashup audio and mixer/);
    check('Mashup projects reopen honestly as a rendered mix in Studio');

    await page.evaluate(() => { __test.fail.separate = 'Injected engine failure'; });
    await page.locator('#studio-run').click(); await confirmIfOpen(); await idle();
    assert.equal(await page.evaluate(() => S.separated), true);
    assert.equal(await page.locator('#task-retry').isVisible(), true);
    check('failed re-separation preserves the frontend session and exposes retry');

    await page.evaluate(() => { prefs.exportDir = 'C:/Exports'; prefs.askExport = false; savePrefs(); });
    assert.deepEqual(await page.evaluate(() => { const p = JSON.parse(localStorage.getItem('contour.prefs.v2')); return [p.exportDir, p.askExport]; }), ['C:/Exports', false]);
    check('export folder and prompt preference persist');

    await mode('simple');
    await page.evaluate(() => { document.getElementById('simple-flagship').checked = true; });
    await page.evaluate(() => { showSimpleResults(false); });
    await page.locator('#simple-run').click();
    await page.waitForFunction(() => document.getElementById('confirm-dialog').open);
    assert.match(await page.locator('#confirm-message').textContent(), /CPU/);
    assert.match(await page.locator('#confirm-message').textContent(), /464/);
    await page.locator('#confirm-no').click(); await idle();
    check('preflight explains model download size and slow CPU quality before running');

    await mode('mashup');
    await page.evaluate(() => mashDrop(['new-a.wav', 'new-b.wav'])); await idle();
    await page.locator('#mash-run').click(); await confirmIfOpen(); await idle();
    await page.evaluate(() => { S.savedMix = 'unsaved'; });
    await page.locator('#mash-again').click();
    await page.waitForFunction(() => document.getElementById('confirm-dialog').open);
    await page.locator('#confirm-no').click(); await idle();
    assert.equal(await page.evaluate(() => S.separated), true);
    await page.locator('#mash-again').click(); await page.locator('#confirm-yes').click(); await idle();
    assert.deepEqual(await page.evaluate(() => [S.source, S.tracks.length, MASH.a, MASH.b, MASH.settings.semitones, S.projectPath]), [null, 0, null, null, null, null]);
    check('new Mashup protects unsaved work and resets the entire session');

    for (const size of [[1366,768], [1280,720], [1024,768]]) {
      await page.setViewportSize({width:size[0],height:size[1]});
      for (const name of ['simple','studio','mashup']) {
        await mode(name);
        assert.equal(await page.locator('#workspace').isVisible(), true);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      }
    }
    assert.deepEqual(errors, []);
    check('all tabs retain shared controls at laptop sizes without script errors');
    console.log('All browser workflow checks passed. Native inference is outside this mock suite.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
