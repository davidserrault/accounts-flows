import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHistory} from '../dist/import.js';
import {buildModel} from '../dist/model.js';
import {compileMotion, sampleMotion} from '../dist/motion.js';
import {historyFixture} from './fixtures/history.mjs';

const parse = raw => parseHistory(JSON.stringify(raw));
test('original export format preserves opening cash, exact operations, paired transfers and final cash', () => {
  const data = parse(historyFixture()), model = buildModel(data);
  assert.equal(data.meta.subject, 'Alex');
  assert.deepEqual(model.accounts.map(a => a.opening), [10000, 5000]);
  assert.deepEqual(model.transactions.map(t => t.id), ['1','2','3','4']);
  assert.equal(model.stats.income, 3000);assert.equal(model.stats.expense, 500);
  assert.equal(model.stats.transferCount, 1);assert.equal(model.stats.closing, 17500);
  assert.deepEqual(model.days[1].opening, {'account-0':7500,'account-1':7000});
  assert.equal(Object.values(model.days[0].spendingClosing)[0], 500);
  assert.equal(Object.values(model.days[1].spendingOpening)[0], 0);
  const motion = compileMotion(model);
  assert.deepEqual(sampleMotion(model, motion, 0).balances, {'account-0':10000,'account-1':5000});
  assert.deepEqual(sampleMotion(model, motion, motion.endAt).balances, {'account-0':10500,'account-1':7000});
});
test('euro amounts, account-ID-only references, BOM and ascending transaction order are supported', () => {
  const raw = historyFixture();
  for (const a of raw.included.accounts) {delete a.openingBalanceMinor;delete a.closingBalanceMinor;}
  for (const t of raw.data) {
    delete t.amountMinor;delete t.balanceBeforeMinor;delete t.balanceAfterMinor;delete t.accountKey;
    if (t.counterparty) {delete t.counterparty.accountKey;delete t.counterparty.accountId;}
  }
  raw.data.reverse();
  const data = parseHistory('\uFEFF'+JSON.stringify(raw));
  assert.equal(buildModel(data).stats.closing, 17500);
});
test('empty histories with zero balances render with finite totals', () => {
  const raw=historyFixture();raw.data=[];
  raw.included.accounts=raw.included.accounts.slice(0,1);
  Object.assign(raw.included.accounts[0],{openingBalance:0,openingBalanceMinor:0,closingBalance:0,closingBalanceMinor:0});
  const model=buildModel(parse(raw)), motion=compileMotion(model);
  assert.equal(model.stats.averageCredit,0);assert.equal(model.stats.averagePayment,0);
  assert.equal(model.days.length,2);
  assert.equal(sampleMotion(model,motion,0).balances['account-0'],0);
});
test('non-Latin labels and colliding slugs still identify distinct nodes and financial flows', () => {
  const raw=historyFixture();
  raw.data=[...Array(4)].map((_,i)=>({id:i+1,accountKey:'checking_alex',accountId:7,date:'2026-01-31',currency:'EUR',amountMinor:100,balanceBeforeMinor:10000+i*100,balanceAfterMinor:10100+i*100,text:['A B','A-B','給与','給料'][i],parsedData:{categoryLabel:'Income'}}));
  raw.included.accounts[0].closingBalance=104;raw.included.accounts[0].closingBalanceMinor=10400;
  raw.included.accounts[1].closingBalance=50;raw.included.accounts[1].closingBalanceMinor=5000;
  const model=buildModel(parse(raw));
  assert.equal(new Set(model.incomes.map(n=>n.id)).size,4);
  assert.equal(model.days[0].incomeFlows.length,4);
  assert.equal(Object.values(model.days[0].nodeAmounts).reduce((a,b)=>a+b,0),400);
  assert.equal(compileMotion(model).tracks.filter(t=>t.income).length,4);
});
test('bad JSON, schemas and unsupported currencies give actionable errors', () => {
  assert.throws(()=>parseHistory('not JSON'),/not valid JSON/);
  for (const mutate of [r=>r.version=2,r=>r.format='other',r=>r.data={},r=>r.included.accounts=[]]) {
    const raw=historyFixture();mutate(raw);assert.throws(()=>parse(raw),/format|accounts/);
  }
  const raw=historyFixture();raw.meta.currency='USD';assert.throws(()=>parse(raw),/Only EUR/);
});
test('duplicate or missing IDs and unknown or contradictory account references are rejected', () => {
  for (const mutate of [r=>r.data[1].id='04',r=>r.data[0].id=null,r=>r.data[0].id='',r=>r.included.accounts[1].id=7,r=>r.data[0].accountKey='missing',r=>r.data[0].accountId=9,r=>r.data[1].counterparty.accountId=9]) {
    const raw=historyFixture();mutate(raw);assert.throws(()=>parse(raw),/ID|account/);
  }
});
test('balance discontinuities, inconsistent amounts and incomplete transfers are rejected before use', () => {
  let raw=historyFixture();raw.data[0].balanceBefore=74;raw.data[0].balanceBeforeMinor=7400;
  assert.throws(()=>parse(raw),/reconcile/);
  raw=historyFixture();raw.data[0].amountMinor=2999;assert.throws(()=>parse(raw),/inconsistent euro and cent/);
  raw=historyFixture();raw.data=raw.data.filter(t=>t.id!==3);assert.throws(()=>parse(raw),/transfer is incomplete/);
  raw=historyFixture();delete raw.data[1].parsedData.transferId;assert.throws(()=>parse(raw),/missing its transfer ID/);
  raw=historyFixture();raw.included.accounts[0].closingBalance=106;raw.included.accounts[0].closingBalanceMinor=10600;assert.throws(()=>parse(raw),/reconcile/);
});
test('invalid date ranges are still rejected', () => {
  for (const mutate of [r=>r.meta.startDate='2026-02-30',r=>r.meta.startDate='2026-02-02',r=>r.data[0].date='2026-02-30',r=>r.data[0].date='2027-01-01']) {
    const raw=historyFixture();mutate(raw);assert.throws(()=>parse(raw),/date|period|years/i);
  }
});
test('more than a century and one hundred accounts retain exact starting and final cash', () => {
  const raw=historyFixture();raw.meta.startDate='1900-01-01';raw.meta.endDate='2030-12-31';
  for(let i=0;i<118;i++)raw.included.accounts.push({key:`extra_${i}`,id:100+i,name:`Extra ${i}`,type:'savings',openingBalanceMinor:1,closingBalanceMinor:1});
  const model=buildModel(parse(raw)), motion=compileMotion(model);
  assert.equal(model.accounts.length,120);assert.equal(model.days.length,47847);
  assert.equal(model.days[0].key,'1900-01-01');assert.equal(model.days.at(-1).key,'2030-12-31');
  assert.equal(sampleMotion(model,motion,0).balances['account-119'],1);
  const final=sampleMotion(model,motion,motion.endAt).balances;
  assert.equal(Object.values(final).reduce((a,b)=>a+b,0),17618);
  assert.equal(final['account-0'],10500);assert.equal(final['account-119'],1);
  const february=model.days.find(d=>d.key==='2026-02-01');
  assert.deepEqual(february.opening,model.days[february.index-1].closing);
  assert.equal(Object.values(february.spendingOpening)[0],0);
});
test('operation and particle counts no longer reject an otherwise valid export', () => {
  const raw=historyFixture();raw.data=Array.from({length:50001},(_,i)=>({id:i+1,accountKey:'checking_alex',accountId:7,date:'2026-01-31',currency:'EUR',amountMinor:0,balanceBeforeMinor:100000100,balanceAfterMinor:100000100,text:'Balance check'}));
  Object.assign(raw.included.accounts[0],{openingBalance:1000001,openingBalanceMinor:100000100,closingBalance:1000001,closingBalanceMinor:100000100});
  Object.assign(raw.included.accounts[1],{closingBalance:50,closingBalanceMinor:5000});
  const data=parse(raw);
  assert.equal(data.transactions.length,50001);assert.equal(data.accounts[0].opening,100000100);
});
test('a valid history ending in year 9999 stops at its declared endpoint', () => {
  const raw=historyFixture();raw.data=[];raw.meta.startDate='9999-12-30';raw.meta.endDate='9999-12-31';
  for(const a of raw.included.accounts){a.closingBalance=a.openingBalance;a.closingBalanceMinor=a.openingBalanceMinor;}
  const model=buildModel(parse(raw));assert.equal(model.days.length,2);assert.equal(model.days.at(-1).key,'9999-12-31');
});
