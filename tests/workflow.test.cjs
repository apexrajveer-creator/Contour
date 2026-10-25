const test = require('node:test');
const assert = require('node:assert/strict');
const { PhaseClock, defaultMashSettings } = require('../ui/workflow.js');
test('estimates use local stage progress, never the overall download/separation fraction', () => {
  const clock = new PhaseClock();
  clock.sample(.8, 'Vocals', '10%', 1000);
  assert.equal(clock.sample(.2, 'Vocals', '30%', 11000).remaining, 35);
  assert.equal(clock.sample(.7, 'Instruments', '30%', 12000).remaining, null);
});
test('download and setup stages do not invent time estimates', () => {
  const clock = new PhaseClock();
  clock.sample(0, 'Downloading model', '0%', 0);
  assert.equal(clock.sample(.4, 'Downloading model', '40%', 20000).remaining, null);
  assert.equal(clock.sample(.8, 'Analysing tempo and key', '', 30000).remaining, null);
});
test('a progress reset starts a fresh measurement window', () => {
  const clock = new PhaseClock();
  clock.sample(0, 'Vocals', '0%', 1000);
  assert.ok(clock.sample(.5, 'Vocals', '50%', 11000).remaining > 0);
  assert.equal(clock.sample(.1, 'Vocals', '10%', 12000).remaining, null);
});
test('short samples, completed phases and unknown detail never claim an ETA', () => {
  const clock = new PhaseClock();
  clock.sample(.1, 'Vocals', '10%', 0);
  assert.equal(clock.sample(.3, 'Vocals', '30%', 100).remaining, null);
  assert.equal(clock.sample(1, 'Vocals', '100%', 20000).remaining, null);
  assert.equal(clock.sample(.5, 'Reading audio', 'halfway', 30000).remaining, null);
});
test('fresh mashup defaults cannot share mutations', () => {
  const a = defaultMashSettings(), b = defaultMashSettings();
  a.semitones = 12; a.lock_beats = false;
  assert.equal(b.semitones, null); assert.equal(b.lock_beats, true);
});
const { EditHistory } = require('../ui/workflow.js');
test('history undo/redo and a new edit invalidate the abandoned redo branch',()=>{
 const h=new EditHistory();h.reset({gain:1});h.push({gain:2});h.push({gain:3});assert.deepEqual(h.move(-1),{gain:2});assert.equal(h.canRedo,true);h.push({gain:4});assert.equal(h.canRedo,false);assert.deepEqual(h.move(-1),{gain:2});
});
test('history bounds retained snapshots and ignores duplicate edits',()=>{
 const h=new EditHistory(3);h.reset({n:0});for(let n=1;n<8;n++)h.push({n});assert.equal(h.entries.length,3);assert.equal(h.push({n:7}),false);assert.deepEqual(h.move(-1),{n:6});assert.deepEqual(h.move(-1),{n:5});assert.equal(h.move(-1),null);
});
test('history snapshots are isolated from live automation mutations',()=>{
 const h=new EditHistory(),a={env:[{t:1,g:1}]};h.reset(a);a.env[0].g=.2;h.push(a);a.env[0].g=4;assert.deepEqual(h.move(-1),{env:[{t:1,g:1}]});assert.deepEqual(h.move(1),{env:[{t:1,g:.2}]});
});
