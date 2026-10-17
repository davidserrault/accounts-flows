import test from 'node:test';
import assert from 'node:assert/strict';
import {DATA} from '../dist/data.js';
import {buildModel, cursorState, UNIT} from '../dist/model.js';
import {compileSimulation, liveBalances, liveSpending, sampleTrack} from '../dist/simulation.js';
const model = buildModel(DATA);
const frames = compileSimulation(model);

test('income display accumulates by source within the month, carries through empty days and resets across months and years', () => {
  let month = null, totals;
  for (const day of model.days) {
    if (month !== day.monthKey) {
      month = day.monthKey;
      totals = Object.fromEntries(model.incomes.map(n => [n.id, 0]));
    }
    assert.deepEqual(day.incomeOpening, totals);
    totals = {...totals};
    for (const flow of day.incomeFlows) totals[flow.from] += flow.cents;
    assert.deepEqual(day.incomeClosing, totals);
    assert.equal(day.income, day.incomeFlows.reduce((total, f) => total + f.cents, 0), 'Animated flows remain daily');
  }
  // Earlier snapshots stay unchanged when subsequent payments are accumulated.
  assert.deepEqual(model.days[0].incomeClosing, Object.fromEntries(model.incomes.map(n => [n.id, model.days[0].nodeAmounts[n.id]])));
  const months = model.days.filter((d, i) => d.monthEnd || i === model.days.length - 1);
  assert.equal(months.reduce((total, d) => total + Object.values(d.incomeClosing).reduce((a, b) => a + b, 0), 0), model.stats.income);
});

test('all source transactions and account histories reconcile to the cent', () => {
  assert.equal(model.stats.transactionCount, 1139);
  assert.equal(model.stats.incomeCount, 32);
  assert.equal(model.stats.expenseCount, 923);
  assert.equal(model.stats.transferCount, 92);
  assert.equal(model.stats.income, 9194628);
  assert.equal(model.stats.expense, 7750676);
  assert.equal(model.stats.opening, 580000);
  assert.equal(model.stats.closing, 2023952);
  assert.equal(model.stats.opening + model.stats.income - model.stats.expense, model.stats.closing);
});
test('monthly averages include partial and empty calendar months across years', () => {
  assert.equal(model.stats.monthCount,25);
  assert.equal(model.stats.monthlyIncome,9194628/25);
  assert.equal(model.stats.monthlyExpense,7750676/25);
  const data = {meta:{start:'2025-12-31',end:'2026-02-01'},accounts:[{id:'account-a',opening:10000,closing:12000}],transactions:[{id:1,date:'2025-12-31',account:'account-a',cents:3000,before:10000,after:13000,label:'Salary',category:'Income'},{id:2,date:'2026-02-01',account:'account-a',cents:-1000,before:13000,after:12000,label:'Payment',category:'Shopping'}]};
  const short = buildModel(data);
  assert.equal(short.stats.monthCount,3);
  assert.equal(short.stats.monthlyIncome,1000);
  assert.equal(short.stats.monthlyExpense,1000/3);
  const empty = buildModel({...data,meta:{start:'2026-02-01',end:'2026-02-01'},accounts:[{id:'account-a',opening:0,closing:0}],transactions:[]});
  assert.equal(empty.stats.monthCount,1);
  assert.equal(empty.stats.monthlyIncome,0);
  assert.equal(empty.stats.monthlyExpense,0);
});
test('daily periods include empty days, leap day, and both recorded endpoints', () => {
  assert.equal(model.days.length, 731);
  assert.equal(model.days[0].key, '2018-10-09');
  assert.equal(model.days.at(-1).key, '2020-10-08');
  assert.ok(model.days.some(d => d.key === '2020-02-29'));
  assert.equal(model.days.filter(d => d.entries.length === 0).length, 186);
  assert.equal(model.stats.dailyIncome, model.stats.income / 731);
  assert.equal(model.stats.dailyExpense, model.stats.expense / 731);
  for (let i = 1; i < model.days.length; i++) {
    assert.equal(Date.parse(model.days[i].key) - Date.parse(model.days[i-1].key), 86400000);
    assert.deepEqual(model.days[i].opening, model.days[i-1].closing);
  }
});
test('daily flows use only their actual transaction date and count internal transfers once', () => {
  assert.equal(model.days.reduce((n,d) => n+d.income, 0), model.stats.income);
  assert.equal(model.days.reduce((n,d) => n+d.expense, 0), model.stats.expense);
  assert.equal(model.days.reduce((n,d) => n+d.transferred, 0), 2534305);
  assert.equal(model.days.reduce((n,d) => n+d.entries.length, 0), 1139);
  for (const d of model.days) {
    assert.ok(d.entries.every(t => t.date === d.key));
    assert.equal(Object.values(d.closing).reduce((a,b)=>a+b,0) - Object.values(d.opening).reduce((a,b)=>a+b,0), d.income-d.expense);
  }
});
test('all 731 daily particle ledgers reach exact recorded opening and closing balances', () => {
  for (const [i,d] of model.days.entries()) {
    const frame = frames[i];
    assert.deepEqual(liveBalances(model,frame,0), d.opening);
    assert.deepEqual(liveBalances(model,frame,1), d.closing);
    for (const a of model.accounts) {
      const pool = frame.endWallets[a.id];
      assert.equal(pool.reduce((n,t)=>n+t.cents,0), d.closing[a.id]);
      assert.equal(pool.length, Math.ceil(d.closing[a.id]/UNIT));
      assert.ok(pool.every(t=>t.cents>0&&t.cents<=UNIT));
      assert.ok(pool.filter(t=>t.cents<UNIT).length<=1);
    }
  }
});
test('income, transfers and expenses overlap on a day with all three kinds', () => {
  const index = model.days.findIndex(d => d.key === '2018-12-28');
  const frame = frames[index];
  const moving = frame.tracks.map(t=>sampleTrack(t,.24)).filter(v=>v?.segment);
  assert.deepEqual(new Set(moving.map(v=>v.segment.kind)), new Set(['income','transfer','expense']));
  const day=model.days[index];
  const tax=model.expenses.find(n=>n.name==='Taxes');
  assert.equal(liveSpending(model,frame,.94).amounts[tax.id]-day.spendingOpening[tax.id],44533);
  assert.equal(liveBalances(model,frame,1)['account-0'],day.closing['account-0']);
});
test('departure waves keep sparse fast leaders, dense middles and slower tails', () => {
  const i=model.days.findIndex(d=>d.incomeFlows.some(f=>f.from==='income-salary'));
  const deposits=frames[i].tracks.flatMap(t=>t.segments.filter(s=>s.kind==='income')).sort((a,b)=>a.start-b.start);
  const duration=items=>items.reduce((n,s)=>n+s.end-s.start,0)/items.length;
  assert.ok(duration(deposits.slice(-Math.floor(deposits.length*.1)))>duration(deposits.slice(0,Math.floor(deposits.length*.1)))*1.7);
  const leaders=deposits.filter(s=>s.start<.06+.20*.1).length;
  const bulk=deposits.filter(s=>s.start>=.06+.20*.45&&s.start<.06+.20*.55).length;
  assert.ok(bulk>leaders*4);
});
test('spending carries the month forward and grows only on arrivals to exact cumulative totals', () => {
  for (const [i,day] of model.days.entries()) {
    const frame=frames[i];
    let previous=liveSpending(model,frame,0);
    assert.deepEqual(previous.amounts,day.spendingOpening);
    if(day.monthStart) {
      assert.equal(previous.total,0);
      assert.ok(Object.values(previous.counts).every(n=>n===0));
    }
    const arrivals=frame.tracks.flatMap(t=>t.segments.filter(s=>s.kind==='expense'));
    if (arrivals.length) {
      const first=Math.min(...arrivals.map(s=>s.end));
      assert.deepEqual(liveSpending(model,frame,first-.000001).amounts,day.spendingOpening);
    }
    for (let step=1;step<=50;step++) {
      const current=liveSpending(model,frame,step/50);
      for(const n of model.expenses) {
        assert.ok(current.amounts[n.id]>=previous.amounts[n.id]);
        assert.ok(current.amounts[n.id]<=day.spendingClosing[n.id]);
        if(current.counts[n.id]===0)assert.equal(current.amounts[n.id],0);
      }
      previous=current;
    }
    const complete=liveSpending(model,frame,.94);
    assert.equal(complete.total,Object.values(day.spendingClosing).reduce((a,b)=>a+b,0));
    assert.deepEqual(complete.amounts,day.spendingClosing);
  }
});
test('concurrent cash movements conserve money without negative balances or duplicate tokens', () => {
  for(const [i,day] of model.days.entries()) {
    const frame=frames[i];
    const expected=Object.values(day.opening).reduce((a,b)=>a+b,0)+Object.values(day.spendingOpening).reduce((a,b)=>a+b,0)+day.income;
    const events=frame.tracks.flatMap(t=>[t.born,...t.weights.map(w=>w.at),...t.segments.flatMap(s=>[s.start,s.end]),...(t.died===null?[]:[t.died])]);
    const times=new Set([0,1,...Array.from({length:51},(_,s)=>s/50)]);
    // Verify both sides of every split/recombination event, where errors hide.
    for(const t of frame.tracks)for(const w of t.weights.slice(1))for(const dt of [-.000001,0,.000001])times.add(w.at+dt);
    for(const progress of times) {
      const mass=frame.tracks.reduce((n,t)=>n+(sampleTrack(t,progress)?.cents||0),0);
      assert.equal(mass,expected,`${day.key} mass at ${progress}`);
      assert.ok(Object.values(liveBalances(model,frame,progress)).every(v=>Number.isFinite(v)&&v>=-.001));
    }
    assert.equal(new Set(frame.tracks.map(t=>t.id)).size,frame.tracks.length);
    for(const t of frame.tracks)for(const s of t.segments){assert.ok(s.start>=t.born);assert.ok(s.end<=.9000001);}
    assert.ok(events.every(Number.isFinite));
  }
});
test('empty days retain the same money, particles and identities', () => {
  const i=model.days.findIndex((d,i)=>i>0&&d.entries.length===0);
  const before=frames[i-1],empty=frames[i];
  assert.deepEqual(empty.endWallets,before.endWallets);
  assert.ok(empty.tracks.every(t=>t.segments.length===0));
  assert.deepEqual(liveBalances(model,empty,.5),model.days[i].opening);
  assert.deepEqual(liveSpending(model,empty,.5).amounts,model.days[i].spendingOpening);
  assert.deepEqual(empty.endSpendingWallets,before.endSpendingWallets);
});
test('seeking backwards and across cache checkpoints reconstructs identical token tracks', () => {
  const expected=[2,79,310,730].map(i=>[i,structuredClone(frames[i])]);
  void frames[0];void frames[500];void frames[32];
  for(const [i,frame] of expected.reverse())assert.deepEqual(frames[i],frame);
  assert.deepEqual(cursorState(731,731),{index:730,progress:1,cursor:731});
  assert.deepEqual(cursorState(30.5,731),{index:30,progress:.5,cursor:30.5});
  assert.equal(cursorState(-10,731).cursor,0);
  assert.equal(cursorState(999,731).cursor,731);
});
test('unmatched transfers still fail validation', () => {
  const data=structuredClone(DATA);data.transactions.find(t=>t.transferId).transferId='broken';
  assert.throws(()=>buildModel(data),/Unmatched internal transfer/);
});

test('initial account cash is visible from the first frame and remains carried across every month boundary', () => {
  const initial={'account-0':60000,'account-1':250000,'account-2':70000,'account-3':200000};
  assert.deepEqual(liveBalances(model,frames[0],0),initial);
  assert.equal(frames[0].tracks.filter(t=>t.born===0&&t.start.startsWith('account-')).length,580);
  for(const [i,day] of model.days.entries()) {
    if(!day.monthStart||i===0)continue;
    const before=frames[i-1],next=frames[i];
    assert.deepEqual(liveBalances(model,next,0),liveBalances(model,before,1));
    for(const a of model.accounts) {
      const previousIds=before.endWallets[a.id].map(t=>t.id).sort();
      const nextIds=next.tracks.filter(t=>sampleTrack(t,0)?.node===a.id).map(t=>t.id).sort();
      assert.deepEqual(nextIds,previousIds,`${day.key} ${a.name} retained particles`);
    }
  }
});
test('expense particles persist within a month and reset only at the next month, including year boundaries', () => {
  for(const [i,day] of model.days.entries()) {
    const frame=frames[i];
    assert.deepEqual(liveSpending(model,frame,0).amounts,day.spendingOpening);
    assert.deepEqual(liveSpending(model,frame,1).amounts,day.spendingClosing);
    if(i===0)continue;
    const before=frames[i-1];
    if(day.monthStart) {
      assert.equal(liveSpending(model,frame,0).total,0);
      assert.equal(frame.tracks.filter(t=>sampleTrack(t,0)?.node?.startsWith('expense-')).length,0);
      assert.ok(model.days[i-1].monthEnd);
    } else {
      assert.deepEqual(liveSpending(model,frame,0),liveSpending(model,before,1));
      for(const n of model.expenses) {
        assert.deepEqual(frame.tracks.filter(t=>sampleTrack(t,0)?.node===n.id).map(t=>t.id).sort(),before.endSpendingWallets[n.id].map(t=>t.id).sort());
      }
    }
  }
  const endpoints=model.days.filter((d,i)=>d.monthEnd||i===model.days.length-1);
  assert.equal(endpoints.length,25);
  assert.equal(endpoints.reduce((total,d)=>total+Object.values(d.spendingClosing).reduce((a,b)=>a+b,0),0),model.stats.expense);
  assert.equal(model.days.at(-1).monthEnd,false,'The last partial month stays visible');
});
