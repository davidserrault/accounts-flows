import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHistory} from '../dist/import.js';
import {buildModel} from '../dist/model.js';
import {compileMotion, sampleMotion} from '../dist/motion.js';
import {compileSimulation, liveBalances, liveSpending, sampleTrack} from '../dist/simulation.js';

import {overdraftHistory} from './fixtures/overdraft.mjs';

const makeModel = raw => buildModel(parseHistory(JSON.stringify(raw)));
const sum = pool => pool.reduce((n, t) => n + t.cents, 0);

test('imports negative initial, intermediate and final balances without weakening ledger validation', () => {
  for (const raw of [overdraftHistory(), overdraftHistory(-1234, []), overdraftHistory(-1234, [['2026-01-28', -537]])]) {
    const model = makeModel(raw), motion = compileMotion(model);
    assert.equal(sampleMotion(model, motion, 0).balances['account-0'], model.accounts[0].opening);
    assert.equal(sampleMotion(model, motion, motion.endAt).balances['account-0'], model.accounts[0].closing);
  }
  const bad = overdraftHistory(); bad.data[1].balanceBeforeMinor++;
  assert.throws(() => makeModel(bad), /reconcile/);
});

test('only the overdrawn portion of a payment is red, from its account origin through its expense arrival', () => {
  const model = makeModel(overdraftHistory()), motion = compileMotion(model);
  const first = motion.tracks.filter(t => t.segments.some(s => s.kind === 'expense' && s.dayIndex === 0));
  assert.equal(first.filter(t => t.overdraft).reduce((n, t) => n + t.weights[0].cents, 0), 2000);
  assert.equal(first.filter(t => !t.overdraft).reduce((n, t) => n + t.weights[0].cents, 0), 1500);
  for (const t of first.filter(t => t.overdraft)) {
    const s = t.segments[0];
    assert.equal(sampleTrack(t, t.born).segment.from, 'account-0');
    assert.equal(sampleTrack(t, t.born).u, 0);
    const midway = sampleMotion(model, motion, (s.start + s.end) / 2).particles.find(p => p.track.id === t.id);
    assert.equal(midway.track.overdraft, true); assert.equal(midway.value.segment, s);
    const arrival = sampleMotion(model, motion, s.end + .02).particles.find(p => p.track.id === t.id);
    assert.equal(arrival.track.overdraft, true); assert.equal(arrival.value.node, model.expenses[0].id);
  }
});

test('red expense fractions retain their colour after repayment, recombination and monthly reset', () => {
  const model = makeModel(overdraftHistory()), motion = compileMotion(model), id = model.expenses[0].id;
  const snapshot = sampleMotion(model, motion, Math.max(...motion.tracks.flatMap(t => t.segments.filter(s => s.kind === 'expense').map(s => s.end))) + .04);
  const red = snapshot.particles.filter(p => p.value.node === id && p.track.overdraft);
  assert.equal(red.reduce((n, p) => n + p.value.cents, 0), 2525);
  assert.equal(snapshot.spending.amounts[id], 5255);
  assert.equal(sampleMotion(model, motion, motion.endAt).balances['account-0'], 1245);
  const nextMonth = model.days.findIndex(d => d.monthStart && d.index > 0);
  const reset = sampleMotion(model, motion, nextMonth);
  assert.equal(reset.spending.total, 0);
  assert.ok(!reset.particles.some(p => p.value.node === id));
  assert.equal(sampleMotion(model, motion, Math.max(...motion.tracks.flatMap(t => t.segments.filter(s => s.kind === 'expense').map(s => s.end))) + .04).particles.filter(p => p.value.node === id && p.track.overdraft).reduce((n,p) => n+p.value.cents, 0), 2525, 'Backward seeks restore red particles');
});

test('negative daily frames retain exact balances and red expense colours across cache reconstruction', () => {
  const model = makeModel(overdraftHistory()), frames = compileSimulation(model), id = model.expenses[0].id;
  for (const day of model.days) {
    const frame = frames[day.index];
    assert.deepEqual(liveBalances(model, frame, 0), day.opening);
    assert.deepEqual(liveBalances(model, frame, 1), day.closing);
    assert.deepEqual(liveSpending(model, frame, 1).amounts, day.spendingClosing);
    assert.equal(sum(frame.endWallets['account-0']) + sum(frame.endDebts['account-0']), day.closing['account-0']);
  }
  assert.equal(frames[2].endSpendingWallets[id].filter(t => t.overdraft).reduce((n,t) => n+t.cents, 0), 2525);
  const expected = structuredClone(frames[2]); void frames[0]; void frames[5];
  assert.deepEqual(frames[2], expected);
});

test('signed particle money is conserved through overdraft creation and partial/full repayment', () => {
  const model = makeModel(overdraftHistory()), motion = compileMotion(model);
  const times = new Set([0, motion.endAt]);
  for (let c = 0; c <= motion.endAt; c += .031) times.add(c);
  for (const t of motion.tracks) for (const at of [t.born, t.died, ...t.weights.map(w => w.at)]) {
    if (at !== null) for (const delta of [-.000001, 0, .000001]) if (at + delta >= 0) times.add(at + delta);
  }
  for (const c of times) {
    const expected = model.stats.opening + model.days.filter(d => d.index <= c).reduce((n,d) => n+d.income, 0);
    assert.equal(motion.tracks.reduce((n,t) => n+(sampleTrack(t,c)?.cents || 0), 0), expected, `Signed mass at ${c}`);
    assert.ok(Object.values(sampleMotion(model, motion, c).balances).every(Number.isFinite));
  }
});

test('transfers can both create and repay overdrafts without duplicating money', () => {
  const raw = overdraftHistory(500, []);
  raw.included.accounts[0].closingBalanceMinor = -700;
  raw.included.accounts.push({key:'savings',id:2,name:'Savings',type:'savings',openingBalanceMinor:-400,closingBalanceMinor:800});
  raw.data = [
    {id:1,accountKey:'checking',accountId:1,date:'2026-01-28',amountMinor:-1200,balanceBeforeMinor:500,balanceAfterMinor:-700,counterparty:{accountKey:'savings',accountId:2},parsedData:{transferId:'transfer'}},
    {id:2,accountKey:'savings',accountId:2,date:'2026-01-28',amountMinor:1200,balanceBeforeMinor:-400,balanceAfterMinor:800,counterparty:{accountKey:'checking',accountId:1},parsedData:{transferId:'transfer'}}
  ];
  const model = makeModel(raw), motion = compileMotion(model);
  assert.deepEqual(sampleMotion(model, motion, 0).balances, {'account-0':500,'account-1':-400});
  assert.deepEqual(sampleMotion(model, motion, motion.endAt).balances, {'account-0':-700,'account-1':800});
  const frames = compileSimulation(model);
  assert.deepEqual(liveBalances(model, frames[0], 1), model.days[0].closing);
});


test('repeated zero crossings and fractional repayments keep the exact final ledger', () => {
  let seed = 7231;
  const random = () => {seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32;};
  for (let scenario = 0; scenario < 12; scenario++) {
    const entries = Array.from({length: 40}, (_, i) => {
      const date = new Date(Date.UTC(2026, 0, 24 + Math.floor(i / 3))).toISOString().slice(0, 10);
      return [date, Math.floor(random() * 12000) - 6000];
    });
    const raw = overdraftHistory(Math.floor(random() * 6000) - 3000, entries);
    raw.meta.endDate = '2026-02-28';
    const model = makeModel(raw), motion = compileMotion(model), frames = compileSimulation(model);
    assert.equal(sampleMotion(model, motion, motion.endAt).balances['account-0'], model.accounts[0].closing);
    for (const day of model.days) assert.deepEqual(liveBalances(model, frames[day.index], 1), day.closing);
    for (const t of motion.tracks) for (const w of t.weights) {
      for (const delta of [-.000001, 0, .000001]) {
        const c = w.at + delta; if (c < 0) continue;
        const expected = model.stats.opening + model.days.filter(d => d.index <= c).reduce((n,d) => n+d.income, 0);
        assert.equal(motion.tracks.reduce((n,t) => n+(sampleTrack(t,c)?.cents || 0), 0), expected);
      }
    }
  }
});
