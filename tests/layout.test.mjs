import test from 'node:test';
import assert from 'node:assert/strict';
import {diagramHeight,diagramLayout,availableDiagramHeight,timelineBalanceChart} from '../dist/layout.js';
import {buildModel} from '../dist/model.js';
import {parseHistory} from '../dist/import.js';
import {historyFixture} from './fixtures/history.mjs';
import {overdraftHistory} from './fixtures/overdraft.mjs';

test('the balance timeline combines all accounts, includes opening and final balances, and cancels internal transfers',()=>{
  const model=buildModel(parseHistory(JSON.stringify(historyFixture())));
  const chart=timelineBalanceChart(model,320);
  assert.deepEqual(chart.points,[{index:0,cents:15000},{index:1,cents:14500},{index:2,cents:17500}]);
  for(const point of chart.points.slice(1)) assert.equal(point.cents,Object.values(model.days[point.index-1].closing).reduce((a,b)=>a+b,0));
  assert.equal(chart.points.at(-1).cents,model.stats.closing);
});
test('the balance timeline preserves both endpoints and extrema of a century-long history in bounded geometry',()=>{
  const raw=historyFixture();raw.meta.startDate='1900-01-01';raw.meta.endDate='2030-12-31';
  const model=buildModel(parseHistory(JSON.stringify(raw)));
  for(const width of [320,1400]) {
    const chart=timelineBalanceChart(model,width);
    assert.ok(chart.points.length<=width*2+2);
    assert.deepEqual(chart.points[0],{index:0,cents:15000});
    assert.deepEqual(chart.points.at(-1),{index:model.days.length,cents:17500});
    assert.ok(chart.points.some(p=>p.cents===14500));
    assert.ok(!/NaN|Infinity/.test(chart.line+chart.area));
    assert.equal(chart.hasNegative,false);
  }
});
test('compression retains a brief overdraft and exact zero crossings in the chart geometry',()=>{
  const model=buildModel(parseHistory(JSON.stringify(overdraftHistory(1000,[['2026-01-24',-3000],['2026-01-25',3000]]))));
  const chart=timelineBalanceChart(model,1);
  assert.ok(chart.points.some(p=>p.cents===-2000));
  assert.equal(chart.minimum,-2000);assert.equal(chart.maximum,1000);
  assert.ok(chart.zeroY>3&&chart.zeroY<chart.height-3);
  assert.ok(chart.line.startsWith('M0 3'));
  assert.ok(chart.area.endsWith(`L1 ${chart.zeroY}L0 ${chart.zeroY}Z`));
});
test('flat, zero, negative-only and single-day balances have finite chart paths',()=>{
  for(const opening of [-5000,0,5000]) {
    const raw=overdraftHistory(opening,[]);raw.meta.endDate=raw.meta.startDate;
    const chart=timelineBalanceChart(buildModel(parseHistory(JSON.stringify(raw))),0);
    assert.equal(chart.width,1);assert.equal(chart.points.length,2);
    assert.ok(!/NaN|Infinity/.test(chart.line+chart.area));
    assert.equal(chart.hasNegative,opening<0);
    if(opening===0)assert.equal(chart.zeroY,22);
    else assert.equal(chart.zeroY,opening<0?3:41);
  }
});
test('row space increases with accounts, income sources and expense categories without limiting node counts',()=>{
  const counts=(accounts,incomes,expenses)=>({accounts:{length:accounts},incomes:{length:incomes},expenses:{length:expenses}});
  assert.equal(diagramHeight(counts(4,3,21),600),600);
  assert.ok(diagramHeight(counts(120,3,21),600)>19000);
  assert.ok(diagramHeight(counts(4,120,21),600)>16000);
  assert.ok(diagramHeight(counts(4,3,300),600)>7900);
  assert.ok(diagramHeight(counts(1000,1000,3000),600)>diagramHeight(counts(120,120,300),600));
});

test('diagram viewport fills the space above the player and responds to shorter screens and a taller player',()=>{
  assert.equal(availableDiagramHeight(180,788),600);
  assert.equal(availableDiagramHeight(180,988),800);
  assert.equal(availableDiagramHeight(180,688),500);
  assert.equal(availableDiagramHeight(400,350),120);
  const layout = diagramLayout({accounts:{length:1},incomes:{length:1},expenses:{length:1}},800);
  assert.equal(layout.height,800);
  assert.equal(layout.top,64,'A single row stays at the top instead of moving into the middle');
});
