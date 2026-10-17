import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {buildModel} from '../dist/model.js';
import {FlowRenderer} from '../dist/render.js';
import {frequencyFixture} from './fixtures/frequency.mjs';
const require = createRequire(import.meta.url);
const {createCanvas} = require(require.resolve('@napi-rs/canvas', {paths: [process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES]}));
const model = buildModel(frequencyFixture());

test('all three lists rank operation frequency above monetary amount, while retaining account identities', () => {
  assert.deepEqual(model.incomes.map(n => [n.name, n.count]), [['Regular income',3], ['Annual bonus',1]]);
  assert.deepEqual(model.expenses.map(n => [n.name, n.count]), [['Frequent category',3], ['Rare category',1]]);
  assert.deepEqual(model.accounts.map(n => [n.id, n.count]), [['b',7], ['a',1], ['c',0]]);
  assert.equal(model.accountMap.get('a').closing, 100000);
});
test('monthly income membership includes only sources with a receipt in that month, with no source in an empty month', () => {
  assert.deepEqual(model.monthlyIncomes.get('2026-01').map(n=>n.name), ['Annual bonus']);
  assert.deepEqual(model.monthlyIncomes.get('2026-02').map(n=>n.name), ['Regular income']);
  assert.equal(model.monthlyIncomes.has('2026-03'), false);
});
test('inactive monthly income labels are neither drawn nor selectable, and columns share the same top row', () => {
  const canvas = createCanvas(900,360), renderer = new FlowRenderer(canvas,model,null);
  renderer.resize(900,360,1);
  const labels = [], context = renderer.ctx, oldText = context.fillText;
  context.fillText = function(text,...args) {labels.push(text); return oldText.call(this,text,...args);};
  const february = model.days.findIndex(d=>d.key==='2026-02-01');
  renderer.draw(february,0,0);
  const bonus = renderer.nodes.get('income-annual-bonus'), regular = renderer.nodes.get('income-regular-income');
  assert.equal(bonus.visible, false); assert.equal(regular.visible,true);
  assert.ok(!labels.includes('Annual bonus')); assert.ok(labels.includes('Regular income'));
  assert.notEqual(renderer.hitTest(bonus.x,bonus.y)?.id,bonus.id);
  assert.equal(regular.y, renderer.nodes.get('b').y);
  assert.equal(regular.y, renderer.nodes.get('expense-frequent-category').y);
  assert.ok(regular.y < 100);
  labels.length=0;
  const march = model.days.findIndex(d=>d.key==='2026-03-01');
  renderer.draw(march,0,0);
  assert.ok(!labels.includes('Annual bonus') && !labels.includes('Regular income'));
  renderer.draw(0,0,0);
  assert.equal(renderer.nodes.get('income-annual-bonus').visible,true);
  assert.equal(renderer.nodes.get('income-regular-income').visible,false);
});
test('a January income particle remains drawn in transit during February after its source label is hidden', () => {
  const canvas = createCanvas(900,360), renderer = new FlowRenderer(canvas,model,null);
  renderer.resize(900,360,1);
  const context=renderer.ctx, oldFill=context.fill;
  let drawn=0;
  context.fill=function(...args){drawn++;return oldFill.apply(this,args);};
  renderer.draw(1,.3,0);
  const moving=renderer.snapshot.particles.filter(p=>p.value.segment?.from==='income-annual-bonus');
  assert.ok(moving.length>0);
  assert.equal(renderer.nodes.get('income-annual-bonus').visible,false);
  assert.ok(drawn>=moving.length,'All travelling particles retain a renderable route');
  assert.ok(moving.every(p=>Number.isFinite(renderer.incomeOrigin(p.value.segment.from,p.value.segment.dayIndex).y)));
});
