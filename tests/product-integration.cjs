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
    await page.goto('http://contour.test/');await page.waitForFunction(()=>S.devices);
    await mode('studio');assert.equal(await page.locator('#empty-import').isVisible(),true);check('Studio has direct import/open actions');
    await page.locator('#empty-import').click();await idle();
    await page.locator('#global-play').click();await page.waitForFunction(()=>S.playing);
    const started=await page.evaluate(()=>{window.testAudioNode=S.nodes[0];return S.started;});
    for(const name of ['simple','mashup','studio','simple'])await mode(name);
    assert.equal(await page.evaluate(()=>S.playing && S.nodes[0]===window.testAudioNode),true);
    assert.equal(await page.evaluate(()=>S.started),started);check('playback and audio nodes survive all tab handoffs');

    await mode('mashup');const loads=await page.evaluate(()=>__test.calls.filter(c=>c.cmd==='load_audio').length);
    await page.locator('#slot-a .mash-use').click();await idle();await page.locator('#slot-b .mash-use').click();await idle();
    assert.equal(await page.evaluate(()=>__test.calls.filter(c=>c.cmd==='load_audio').length),loads);
    assert.equal(await page.evaluate(()=>MASH.a.name===S.source.name && MASH.b.name===S.source.name),true);check('current-song handoffs do not reimport the file');
    await page.locator('#mash-run').click();await confirmIfOpen();await idle();
    await page.waitForFunction(()=>MASH.result);
    const renders=await page.evaluate(()=>__test.calls.filter(c=>c.cmd==='mashup_render').length);
    await page.locator('#mash-gain').evaluate(el=>{el.value='6';el.dispatchEvent(new Event('input',{bubbles:true}));});await page.waitForTimeout(80);
    assert.ok(Math.abs(await page.evaluate(()=>track('vocals').vol)-Math.pow(10,6/20))<.0001);
    assert.equal(await page.evaluate(()=>__test.calls.filter(c=>c.cmd==='mashup_render').length),renders);check('vocal gain updates instantly without a renderer call');
    await page.locator('#mash-play').focus();await page.keyboard.press('Control+z');await page.waitForTimeout(50);
    assert.ok(Math.abs(await page.evaluate(()=>track('vocals').vol)-1)<.0001);
    await page.keyboard.press('Control+Shift+z');await page.waitForTimeout(50);
    assert.ok(Math.abs(await page.evaluate(()=>track('vocals').vol)-Math.pow(10,6/20))<.0001);check('undo and redo work with a button focused');

    await page.waitForFunction(()=>!S.starting);if(!await page.evaluate(()=>S.playing))await page.locator('#global-play').click();await page.waitForFunction(()=>S.playing);
    await page.evaluate(()=>window.musicBefore=track('instrumental').sourceNode);
    const musicReads=await page.evaluate(()=>__test.calls.filter(c=>c.cmd==='pcm'&&c.args.id==='instrumental').length);
    await page.locator('#mash-key-up').click();await page.waitForFunction(()=>!S.busy && !MASH.pending && MASH.result.plan.semitones===1);
    assert.equal(await page.evaluate(()=>S.playing && track('instrumental').sourceNode===window.musicBefore),true);
    assert.equal(await page.evaluate(()=>__test.calls.filter(c=>c.cmd==='pcm'&&c.args.id==='instrumental').length),musicReads);check('key changes preserve the playing music node and reuse its buffer');

    await page.locator('.export-options-open').first().click();
    await page.evaluate(()=>{for(const [id,value]of [['format','flac16'],['rate','48000']]){document.getElementById(id).value=value;document.getElementById(id).dispatchEvent(new Event('change',{bubbles:true}));}document.getElementById('protect').checked=false;document.getElementById('apply-curves').checked=false;document.getElementById('protect').dispatchEvent(new Event('change',{bubbles:true}));});
    await page.locator('#close-export-options').click();await page.locator('#mash-save').click();await idle();
    assert.deepEqual(await page.evaluate(()=>{const x=__test.calls.filter(c=>c.cmd==='export_mix').at(-1).args;return[x.format,x.rate,x.protect,x.parts.every(p=>!p.envelope.length)];}),['flac16',48000,false,true]);
    await mode('simple');await page.locator('#simple-save').click();await idle();
    assert.deepEqual(await page.evaluate(()=>{const x=__test.calls.filter(c=>c.cmd==='export').at(-1).args;return[x.format,x.rate,x.protect];}),['flac16',48000,false]);check('Simple and Mashup use identical visible export settings');
    await page.locator('#simple-studio').click();await page.waitForTimeout(300);assert.equal(await page.evaluate(()=>S.mode),'studio');
    await page.evaluate(()=>{track('vocals').exportSelected=false;renderExportList();renderAll();});
    assert.equal(await page.locator('#export-list input[value=vocals]').isChecked(),false);check('export stem selections survive view rebuilds');

    await page.evaluate(()=>{S.region=[2,6];S.loop=true;ContourProduct.changed();});await page.waitForTimeout(30);
    await page.locator('.export-options-open').first().click();await page.keyboard.press('Escape');
    assert.deepEqual(await page.evaluate(()=>S.region),[2,6]);await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(()=>S.region),null);check('Escape dismisses only the foremost interaction');
    await page.evaluate(()=>{track('vocals').env=[{t:2,g:.5}];curvesChanged(track('vocals'));});await page.waitForTimeout(30);
    await page.keyboard.press('Control+z');await page.waitForTimeout(30);assert.equal(await page.evaluate(()=>track('vocals').env.length),0);check('automation edits participate in undo history');
    await mode('simple');await page.evaluate(()=>{S.loop=true;ContourProduct.changed();});await page.waitForTimeout(30);
    assert.equal(await page.locator('#mix-indicator').isVisible(),true);check('Simple exposes active advanced mixer effects');

    await idle();await page.evaluate(()=>ContourProduct.saveRecovery());await idle();
    const saves=await page.evaluate(()=>__test.calls.filter(c=>c.cmd==='save_project'&&c.args.path.includes('/Recovery/')).length);
    await page.evaluate(()=>{track('vocals').pan=.25;applyMix();});await page.waitForTimeout(30);await page.evaluate(()=>ContourProduct.saveRecovery());await idle();
    assert.equal(await page.evaluate(()=>__test.calls.filter(c=>c.cmd==='save_project'&&c.args.path.includes('/Recovery/')).length),saves);
    assert.ok(await page.evaluate(()=>__test.calls.some(c=>c.cmd==='recovery_update')));check('recovery writes audio once then saves only edit metadata');
    await page.evaluate(()=>{window.discardDecision=ContourProduct.canReplace('discard this session');});
    await page.waitForFunction(()=>document.getElementById('confirm-dialog').open);await page.locator('#confirm-no').click();assert.equal(await page.evaluate(()=>window.discardDecision),false);check('unsaved-change protection can cancel replacement');
    await page.evaluate(()=>ContourProduct.startup());await page.locator('#recover-session').click();await confirmIfOpen();await idle();
    assert.equal(await page.evaluate(()=>S.separated && S.projectPath===null),true);assert.equal(await page.locator('#recovery-banner').isVisible(),false);check('recovery restores saved audio and mixer as an unsaved session');

    await page.evaluate(()=>{S.savedMix=mixFingerprint();});await page.evaluate(()=>loadPath('six-stem.wav'));await idle();await mode('simple');
    await page.evaluate(()=>{S.goal='six';setRadio('.tiles','goal','six');showSimpleResults(false);});
    await page.locator('#simple-run').click();await confirmIfOpen();await page.waitForFunction(()=>S.separated&&!S.busy);
    await page.waitForTimeout(1300);
    await page.waitForFunction(()=>!S.starting);if(!await page.evaluate(()=>S.playing))await page.locator('#global-play').click();await page.waitForFunction(()=>S.playing);
    const paintBefore=await page.evaluate(()=>ContourPerf.strataPaints);await page.waitForTimeout(1200);
    const paints=await page.evaluate(()=>ContourPerf.strataPaints)-paintBefore;assert.ok(paints<=2,`Unexpected full waveform repaints: ${paints}`);check('steady playback moves a cursor instead of repainting the full waveform');

    await page.evaluate(()=>{stop();track('drums').buffer=null;__test.hold.pcm=true;track('drums').mute=false;});
    await page.locator('#global-play').click();await page.waitForFunction(()=>!!__test.release.pcm);await page.locator('#global-play').click();await page.evaluate(()=>__test.release.pcm());await page.waitForTimeout(400);
    assert.equal(await page.evaluate(()=>S.playing),false);check('pause cancels a playback request that is still buffering');

    await page.evaluate(()=>{track('vocals').label='Vocals & <song> \"quoted\"';renderAll();});assert.equal(await page.locator('#result-list .result strong').first().textContent(),'Vocals & <song> \"quoted\"');check('filenames and track labels render as literal text');
    await page.evaluate(()=>{S.source.name='A very long song title '.repeat(15)+'.wav';document.getElementById('now-name').textContent=S.source.name;});
    for(const [width,height]of [[1440,900],[1152,720],[960,600]]){
      await page.setViewportSize({width,height});
      for(const name of ['simple','studio','mashup']){await mode(name);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.equal(await page.locator('#global-play').isVisible(),true);}
    }
    await page.emulateMedia({reducedMotion:'reduce'});for(const name of ['simple','mashup','studio'])await mode(name);
    assert.equal(await page.evaluate(()=>ContourMotion.active()),0);check('six-stem layouts and long filenames fit effective 100/125/150 percent zoom sizes, including reduced motion');
    assert.deepEqual(errors,[]);console.log('All product workflow and performance regression scenarios passed.');
  } catch(e) { console.error('STATE',await page.evaluate(()=>({playing:S.playing,starting:S.starting,pos:S.pos,request:S.playRequest,pending:MASH.pending,rendering:MASH.rendering,revision:MASH.revision,settings:MASH.settings,plan:MASH.result?.plan,toast:document.getElementById('toast').textContent})));console.error(errors);throw e;} finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
