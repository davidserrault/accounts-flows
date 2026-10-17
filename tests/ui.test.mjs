import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {historyFixture} from './fixtures/history.mjs';
import {money} from '../dist/model.js';
import {overdraftHistory} from './fixtures/overdraft.mjs';

const require = createRequire(import.meta.url);
const {createCanvas, GlobalFonts} = require(require.resolve('@napi-rs/canvas', {paths: [process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES]}));
GlobalFonts.registerFromPath('/usr/share/fonts/opentype/urw-base35/NimbusSans-Regular.otf','Arial');
GlobalFonts.registerFromPath('/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf','Liberation Mono');
const html = fs.readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');
const nativeCanvas = createCanvas(1400, 600);
class Element {
  constructor(id, tagName = 'DIV') {
    this.id=id;this.tagName=tagName.toUpperCase();this.hidden=false;this.open=false;this.value='';this.textContent='';this.innerHTML='';this.children=[];this.events=new Map();this.attrs={};
    this.style={setProperty:(k,v)=>{this.style[k]=v;}};
    const classes=new Set();this.classList={toggle:(k,on)=>on?classes.add(k):classes.delete(k),contains:k=>classes.has(k)};
  }
  addEventListener(type,handler){if(!this.events.has(type))this.events.set(type,[]);this.events.get(type).push(handler);}
  fire(type,extra={}){return Promise.all((this.events.get(type)||[]).map(handler=>handler({target:this,pointerType:'mouse',preventDefault(){},...extra})));}
  click(){return this.fire('click');}
  setAttribute(k,v){this.attrs[k]=String(v);}
  getAttribute(k){return this.attrs[k];}
  appendChild(e){this.children.push(e);}
  replaceChildren(...children){this.children=[...children];}
  focus(){globalThis.document.activeElement=this;}
  getBoundingClientRect(){const height=Math.max(600,parseInt(this.style.minHeight)||0);return {left:0,top:0,width:1400,height,right:1400,bottom:height};}
  showModal(){this.open=true;}
  close(){this.open=false;}
}
const elements = new Map();
for(const match of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)){
  const el=new Element(match[2],match[1]);el.hidden=/\bhidden\b/.test(match[0]);elements.set(el.id,el);
}
const canvas=elements.get('flow-canvas');
canvas.getContext=()=>nativeCanvas.getContext('2d');
Object.defineProperty(canvas,'width',{set:v=>{nativeCanvas.width=v},get:()=>nativeCanvas.width});
Object.defineProperty(canvas,'height',{set:v=>{nativeCanvas.height=v},get:()=>nativeCanvas.height});
const doc=new Element('document');
doc.body=new Element('body','BODY');doc.documentElement=new Element('html','HTML');doc.hidden=false;doc.activeElement=doc.body;
doc.getElementById=id=>{assert.ok(elements.has(id),`Missing DOM element: ${id}`);return elements.get(id);};
doc.querySelectorAll=()=>[];
doc.createElement=tag=>new Element('',tag);
globalThis.document=doc;
globalThis.window={devicePixelRatio:1,matchMedia:()=>({matches:false,addEventListener(){}}),addEventListener(){}};
globalThis.ResizeObserver=class{constructor(handler){this.handler=handler}observe(){}};
const queued=[];globalThis.requestAnimationFrame=handler=>queued.push(handler);
await import('../dist/app.js');
const api=window.AccountsFlow;
const el=id=>elements.get(id);
let clock=0;
function advance(ms){for(let i=0;i<Math.ceil(ms/50);i++){clock+=50;queued.shift()(clock);}}

test('income amounts stay white until the month ends, reset next month, and reconstruct correctly when scrubbing', () => {
  const id = 'income-salary';
  const start = api.model.days.findIndex(d => d.nodeAmounts[id] > 0);
  const last = api.model.days.findIndex(d => d.monthKey === api.model.days[start].monthKey && d.monthEnd);
  const context = api.renderer.ctx, original = context.fillText;
  let amount;
  context.fillText = function(value, x, y, ...args) {
    const n = api.renderer.nodes.get(id);
    if (n && x === n.x && y === n.labelY + 16) amount = {value, alpha: this.globalAlpha, colour: this.fillStyle};
    return original.call(this, value, x, y, ...args);
  };
  try {
    for (const index of [start, start + 1, last]) {
      api.seek(index);
      const day = api.model.days[index], n = api.renderer.nodes.get(id);
      assert.equal(n.labelCents, day.incomeClosing[id]);
      assert.equal(n.active, true);
      assert.deepEqual(amount, {value: money(day.incomeClosing[id]), alpha: 1, colour: '#ffffff'});
      assert.equal(el('day-income').textContent, money(Object.values(day.incomeClosing).reduce((a,b) => a+b, 0)));
    }
    api.inspect(id);
    assert.ok(el('detail-metrics').innerHTML.includes('Received so far this month'));
    assert.ok(el('detail-transactions').innerHTML.includes('Salary'));
    el('close-panel').fire('click');
    api.seek(last + 1);
    assert.equal(api.renderer.nodes.get(id).labelCents, 0);
    assert.equal(api.renderer.nodes.get(id).active, false);
    assert.equal(amount.value, '€0');
    api.seek(last);
    assert.deepEqual(amount, {value: money(api.model.days[last].incomeClosing[id]), alpha: 1, colour: '#ffffff'});
  } finally {context.fillText = original; api.seek(0);}
});
async function importFile(raw, name='accounts.json', size=1000) {
  el('history-file').files=[{name,size,text:async()=>typeof raw==='string'?raw:JSON.stringify(raw)}];
  el('history-file').value=name;
  await el('history-file').fire('change');
}

test('app initializes from the real HTML and dataset with accessible controls',()=>{
  assert.equal(el('stat-transactions').textContent,'1,139');
  assert.equal(el('stat-income').textContent,'€3,678');
  assert.equal(el('stat-expense').textContent,'€3,100');
  assert.equal(api.renderer.nodes.size,26);
  assert.equal(api.getState().playing,false);
  assert.equal(el('play').getAttribute('aria-label'),'Play animation');
  assert.equal(el('day-select').value,'2018-10-09');
  assert.equal(el('day-select').min,'2018-10-09');
  assert.equal(el('day-select').max,'2020-10-08');
  assert.ok(!html.includes('data-phase'));
  assert.equal(el('timeline').max,731);
  assert.equal(el('live-total').textContent,'€5,800');
  assert.deepEqual(Object.fromEntries([...api.renderer.nodes.values()].filter(n=>n.kind==='account').map(n=>[n.id,n.cents])),{'account-0':60000,'account-1':250000,'account-2':70000,'account-3':200000});
});
test('default 1× keeps the previous 4× timing, and Pause freezes calendar and particle drift',()=>{
  api.seek(0);const oldTime=api.getState().time;el('play').fire('click');advance(800);
  assert.ok(Math.abs(api.getState().cursor-1)<.001);
  assert.ok(Math.abs(api.getState().time-oldTime-.1875)<.001);
  assert.equal(api.getState().speed,1);
  assert.equal(api.getState().playing,true);
  el('play').fire('click');const before=api.getState();advance(1000);
  assert.equal(api.getState().cursor,before.cursor);
  assert.equal(api.getState().time,before.time);
  assert.equal(el('play-text').textContent,'Play');
});
test('scrubbing reconstructs the exact endpoint and any earlier day, without restarting playback',()=>{
  el('timeline').value=731;el('timeline').fire('input');
  assert.equal(api.getState().index,730);assert.equal(api.getState().progress,1);
  assert.equal(el('live-total').textContent,'€20,240');
  assert.equal(el('play-text').textContent,'Replay');
  el('day-select').value='2018-10-16';el('day-select').fire('change');
  assert.equal(api.getState().index,7);assert.equal(api.getState().progress,0);
  assert.equal(api.getState().playing,false);
  assert.equal(el('observed-period').textContent,'8 / 731 days');
  el('day-select').value='bad-date';el('day-select').fire('change');assert.equal(api.getState().index,7);
});
test('day navigation, all new speed multipliers and loop controls work',()=>{
  api.seek(4);doc.fire('keydown',{target:doc.body,key:'ArrowLeft'});assert.equal(api.getState().index,3);
  doc.fire('keydown',{target:doc.body,key:'ArrowRight'});assert.equal(api.getState().index,4);
  for(const speed of [2,4,8,16]) {
    el('speed').value=speed;el('speed').fire('change');api.seek(0);const oldTime=api.getState().time;api.play();advance(800);
    assert.ok(Math.abs(api.getState().cursor-speed)<.001);
    assert.ok(Math.abs(api.getState().time-oldTime-.1875*speed)<.001);
    api.pause();
  }
  el('speed').value=2;el('speed').fire('change');
  el('loop').fire('click');assert.equal(el('loop').getAttribute('aria-pressed'),'true');
  api.seek(730.99);api.play();advance(1000);assert.ok(api.getState().cursor<1);assert.equal(api.getState().playing,true);
  el('loop').fire('click');api.pause();el('speed').value=1;el('speed').fire('change');
});
test('playback stops at the final balance and Replay returns to the beginning',()=>{
  api.seek(730.95);api.play();advance(400);
  assert.equal(api.getState().cursor,731);assert.equal(api.getState().playing,true);
  advance(1800);assert.equal(api.getState().cursor,731);assert.equal(api.getState().playing,false);
  el('play').fire('click');assert.equal(api.getState().cursor,0);assert.equal(api.getState().playing,true);api.pause();
});
test('selecting an account pauses and shows only the chosen day’s transactions and balances',()=>{
  const index=api.model.days.findIndex(d=>d.key==='2018-12-28');
  api.seek(index+.75);api.play();api.inspect('account-0');
  assert.equal(api.getState().playing,false);assert.equal(el('detail-panel').hidden,false);
  assert.equal(el('detail-title').textContent,'Current account');
  assert.ok(el('detail-metrics').innerHTML.includes('Closing balance'));
  assert.ok(el('detail-metrics').innerHTML.includes('Initial balance'));
  assert.ok(el('detail-metrics').innerHTML.includes('€600.00'));
  assert.ok(el('detail-metrics').innerHTML.includes('Start of day balance'));
  assert.ok(el('detail-transactions').innerHTML.includes('Balance:'));
  assert.equal(el('detail-period').textContent,'28 Dec 2018');
  assert.equal((el('detail-transactions').innerHTML.match(/class="transaction"/g)||[]).length,3);
  assert.equal(el('more-transactions').hidden,true);
  el('close-panel').fire('click');assert.equal(el('detail-panel').hidden,true);
});
test('hover, node selection, keyboard scrubbing and hidden-tab pause work',()=>{
  api.seek(5.2);const node=api.renderer.nodes.get('income-salary');
  canvas.fire('pointermove',{clientX:node.x,clientY:node.y});assert.equal(el('tooltip').hidden,false);
  assert.ok(el('tooltip').innerHTML.includes('Salary'));canvas.fire('pointerleave');assert.equal(el('tooltip').hidden,true);
  doc.fire('keydown',{target:doc.body,key:'ArrowRight'});assert.equal(api.getState().index,6);
  el('timeline').fire('keydown',{key:'PageDown'});assert.equal(api.getState().index,7);
  api.play();doc.hidden=true;doc.fire('visibilitychange');assert.equal(api.getState().playing,false);doc.hidden=false;
});
test('circles and flow connectors appear only when a node is hovered',()=>{
  const context=api.renderer.ctx, original=context.stroke;
  let strokes=0;context.stroke=function(...args){strokes++;return original.apply(this,args)};
  api.renderer.draw(0,.3,3);assert.equal(strokes,2,'Only column dividers remain without hover');
  strokes=0;api.renderer.draw(0,.3,3,'account-0');assert.ok(strokes>2,'Hover reveals connected circles and flows');
  strokes=0;api.renderer.draw(0,.3,3);assert.equal(strokes,2,'Guides disappear when hover ends');
  context.stroke=original;
});
test('spending labels remain grey until the first arrival, then amounts and circles grow',()=>{
  const id='expense-rent';
  const index=api.model.days.findIndex(m=>m.nodeAmounts[id]>0);
  const arrivals=api.renderer.motion.tracks.flatMap(t=>t.segments.filter(s=>s.kind==='expense'&&s.to===id&&s.dayIndex===index)).sort((a,b)=>a.end-b.end);
  const first=arrivals[0].end;
  const context=api.renderer.ctx, original=context.fillText;
  let labelAlpha;
  context.fillText=function(value,...args){if(value==='Rent')labelAlpha=this.globalAlpha;return original.call(this,value,...args)};
  try {
    api.seek(first-.000001);
    let node=api.renderer.nodes.get(id);
    assert.equal(node.active,false);assert.equal(node.cents,0);assert.equal(node.r,0);
    assert.ok(Math.abs(labelAlpha-.38)<=1/255, `Inactive label alpha: ${labelAlpha}`);
    api.seek(first+.004);
    node=api.renderer.nodes.get(id);
    assert.equal(node.active,true);assert.ok(node.cents>0);assert.ok(node.r>0);
    assert.equal(labelAlpha,1);
    const early=node.cents, earlyRadius=node.r;
    api.seek(first+(arrivals.at(-1).end-first)*.6);node=api.renderer.nodes.get(id);
    assert.ok(node.cents>early);assert.ok(node.r>earlyRadius);
    assert.ok(node.cents<api.model.days[index].nodeAmounts[id]);
    api.seek(arrivals.at(-1).end+.02);node=api.renderer.nodes.get(id);
    assert.equal(node.cents,api.model.days[index].nodeAmounts[id]);
    assert.ok(api.renderer.spending.total>=120049);
    const accumulated=api.renderer.nodes.get(id).cents, accumulatedRadius=api.renderer.nodes.get(id).r;
    api.seek(Math.floor(arrivals.at(-1).end)+1);assert.equal(api.renderer.nodes.get(id).active,true);
    assert.equal(api.renderer.nodes.get(id).cents,accumulated);
    assert.equal(api.renderer.nodes.get(id).r,accumulatedRadius);
    assert.ok(api.renderer.spending.total>=120049);
    const nextMonth=api.model.days.findIndex((d,i)=>i>index&&d.monthStart);
    api.seek(nextMonth);assert.equal(api.renderer.nodes.get(id).active,false);
    assert.equal(api.renderer.nodes.get(id).cents,0);assert.equal(el('day-expense').textContent,'€0');
  } finally {context.fillText=original;}
});
test('render all days and animation positions, including narrow-screen plot sizes',()=>{
  for(const width of [900,1400]){
    api.renderer.resize(width,560,1);
    for(const index of [0,1,3,19,28,80,81,111,220,310,365,508,640,729,730])for(const progress of [0,.1,.24,.42,.65,.95,1]){
      api.renderer.draw(index,progress,3);
      for(const n of api.renderer.nodes.values()){
        assert.ok([n.x,n.y,n.r,n.cents].every(Number.isFinite));
        assert.ok(n.y-n.r>=0 && n.y+n.r<=api.renderer.contentHeight);
        assert.ok(n.labelY+(n.kind==='account'?31:16)<=api.renderer.contentHeight,`Label clipped: ${n.name}`);
      }
    }
  }
  api.renderer.resize(1400,600,1);api.renderer.draw(80,.24,8);
  const out='/workspace/scratch/b8cc603f4b5d/accounts-flow-daily-canvas-qa.png';
  fs.writeFileSync(out,nativeCanvas.toBuffer('image/png'));
  assert.ok(fs.statSync(out).size>10000);
});

test('expense details match the monthly cumulative circle and include earlier days with pagination',()=>{
  let chosen;
  for(const day of api.model.days) {
    if(!day.monthEnd)continue;
    for(const node of api.model.expenses) {
      const entries=api.model.days.slice(day.monthStartIndex,day.index+1).flatMap(d=>d.expenseFlows.filter(f=>f.to===node.id).flatMap(f=>f.transactions));
      if(entries.length>10){chosen={day,node,entries};break;}
    }
    if(chosen)break;
  }
  assert.ok(chosen,'A category has enough transactions to paginate');
  const {day,node,entries}=chosen;
  api.seek(day.index+.94);api.inspect(node.id);
  assert.equal(api.renderer.nodes.get(node.id).cents,day.spendingClosing[node.id]);
  assert.ok(el('detail-metrics').innerHTML.includes('Spent so far this month'));
  assert.ok(el('detail-metrics').innerHTML.includes('Month to date total'));
  assert.ok(el('detail-period').textContent.includes('—'));
  assert.ok(el('detail-transactions').innerHTML.includes(`${entries.length} transactions this month to date`));
  assert.equal((el('detail-transactions').innerHTML.match(/class="transaction"/g)||[]).length,10);
  assert.equal(el('more-transactions').hidden,false);
  el('more-transactions').fire('click');assert.equal(api.getState().shown,20);
  assert.equal((el('detail-transactions').innerHTML.match(/class="transaction"/g)||[]).length,Math.min(20,entries.length));
  el('close-panel').fire('click');
});

test('the current account starts at €600 and a remaining positive balance never renders as zero',()=>{
  const context=api.renderer.ctx,original=context.fillText;
  const drawLabel=cursor=>{
    let next=false,label;
    context.fillText=function(value,...args){if(next){label=value;next=false;}if(value==='Current account')next=true;return original.call(this,value,...args);};
    api.seek(cursor);
    return {label,node:api.renderer.nodes.get('account-0')};
  };
  try {
    const start=drawLabel(0);assert.equal(start.label,'€600.00');assert.equal(start.node.cents,60000);
    const positive=api.renderer.motion.tracks.filter(t=>t.start==='account-0').flatMap(t=>t.segments).find(s=>s.kind==='transfer');
    const at=drawLabel(positive.start+(positive.end-positive.start)*.99999);
    assert.ok(at.node.cents>0);assert.notEqual(at.label,'€0.00');assert.ok(at.node.r>0);
    for(const day of api.model.days.filter(d=>d.monthStart)) {
      const before=drawLabel(Math.max(0,day.index-.000001)).node.cents;
      const after=drawLabel(day.index).node.cents;
      assert.ok(Math.abs(after-before)<1,'Account cash does not reset at month boundaries');
      if(after>0)assert.notEqual(drawLabel(day.index).label,'€0.00');
    }
  } finally {context.fillText=original;}
});

test('file chooser imports a full history, resets playback and refreshes every dataset control',async()=>{
  let opened=false;el('history-file').addEventListener('click',()=>{opened=true;});
  await el('import-file').fire('click');assert.equal(opened,true);
  api.seek(20);api.inspect('account-0');api.play();
  await importFile(historyFixture(),'my-accounts.json');
  assert.equal(api.model.meta.subject,'Alex');assert.equal(el('person-name').textContent,'Alex');
  assert.equal(el('stat-accounts').textContent,2);assert.equal(el('stat-transactions').textContent,'4');
  assert.ok(el('stat-history').innerHTML.includes('2 '));
  assert.equal(el('day-select').min,'2026-01-31');assert.equal(el('day-select').max,'2026-02-01');
  assert.equal(el('timeline').max,2);assert.equal(api.renderer.nodes.size,4);
  assert.equal(api.getState().cursor,0);assert.equal(api.getState().playing,false);assert.equal(api.getState().speed,1);
  assert.equal(el('detail-panel').hidden,true);assert.equal(doc.body.style.overflow,'');
  assert.equal(el('live-total').textContent,'€150');
  assert.deepEqual(Object.fromEntries([...api.renderer.nodes.values()].filter(n=>n.kind==='account').map(n=>[n.id,n.cents])),{'account-0':10000,'account-1':5000});
  assert.equal(el('import-error').hidden,true);assert.equal(el('use-demo').hidden,false);
  assert.match(el('import-status').textContent,/my-accounts.json.*4 operations loaded/);
  assert.equal(el('import-file').disabled,false);assert.equal(el('history-file').value,'');
  api.seek(2);assert.equal(el('live-total').textContent,'€175');
  assert.deepEqual(api.renderer.balances,{'account-0':10500,'account-1':7000});
});
test('invalid or unreadable files retain the current accounts and show an accessible error',async()=>{
  const previous=api.model,cursor=api.getState().cursor;
  await importFile('broken JSON');
  assert.equal(api.model,previous);assert.equal(api.getState().cursor,cursor);
  assert.equal(el('import-error').hidden,false);assert.match(el('import-error').textContent,/valid JSON/);
  el('history-file').files=[{name:'unreadable.json',size:1000,text:async()=>{throw new Error('File could not be read.');}}];
  await el('history-file').fire('change');
  assert.equal(api.model,previous);assert.match(el('import-error').textContent,/could not be read/);
  assert.equal(el('import-file').disabled,false);
});
test('uploaded names are treated as text in headers, details and node controls',async()=>{
  const raw=historyFixture();raw.meta.persona.name='<img src=x onerror=alert(1)>';
  raw.included.accounts[0].name='<script>alert(1)</script>';raw.included.accounts[0].bank='<b>Bank</b>';
  raw.data[3].text='<img src=x>';raw.data[3].parsedData.categoryLabel='<svg onload=alert(1)>';
  await importFile(raw,'<script>.json');
  assert.equal(el('person-name').textContent,raw.meta.persona.name);
  assert.equal(api.renderer.nodes.get('account-0').name,raw.included.accounts[0].name);
  api.seek(0);api.inspect('account-0');
  assert.equal(el('detail-title').textContent,raw.included.accounts[0].name);
  assert.ok(el('detail-metrics').innerHTML.includes('&lt;b&gt;Bank&lt;/b&gt;'));
  assert.ok(el('detail-transactions').innerHTML.includes('&lt;img src=x&gt;'));
  assert.ok(!el('detail-transactions').innerHTML.includes('<img'));
  el('close-panel').fire('click');
});
test('different account counts and zero-activity files produce finite layouts with visible labels',async()=>{
  const raw=historyFixture();
  for(let i=0;i<4;i++)raw.included.accounts.push({key:`extra_${i}`,id:20+i,name:`Extra ${i}`,type:'savings',currency:'EUR',openingBalanceMinor:1000,closingBalanceMinor:1000});
  await importFile(raw);
  assert.equal(api.model.accounts.length,6);assert.equal(api.renderer.height,600);
  assert.ok(api.renderer.contentHeight>900);assert.equal(canvas.height,600);
  for(const n of api.renderer.nodes.values()) {
    assert.ok([n.x,n.y,n.r,n.cents].every(Number.isFinite));
    assert.ok(n.labelY+(n.kind==='account'?31:16)<api.renderer.contentHeight);
  }
  const empty=historyFixture();empty.data=[];empty.included.accounts=empty.included.accounts.slice(0,1);
  Object.assign(empty.included.accounts[0],{openingBalance:0,openingBalanceMinor:0,closingBalance:0,closingBalanceMinor:0});
  await importFile(empty);
  assert.equal(api.model.stats.transactionCount,0);assert.equal(api.renderer.nodes.size,1);
  assert.equal(api.renderer.nodes.get('account-0').r,0);
  assert.equal(el('live-total').textContent,'€0');assert.equal(el('stat-income').textContent,'€0');
  assert.ok(!el('timeline-chart').innerHTML.includes('NaN'));
  api.seek(2);assert.equal(el('play-text').textContent,'Replay');
});
test('Use demo restores original data and prevents an earlier pending file read from replacing it',async()=>{
  let release;
  el('history-file').files=[{name:'pending.json',size:1000,text:()=>new Promise(resolve=>{release=resolve;})}];
  const pending=el('history-file').fire('change');
  assert.equal(el('import-file').disabled,true);
  await el('use-demo').fire('click');
  release(JSON.stringify(historyFixture()));await pending;
  assert.equal(api.model.meta.subject,'Camille');assert.equal(api.model.stats.transactionCount,1139);
  assert.equal(api.renderer.nodes.size,26);assert.equal(el('timeline').max,731);
  assert.equal(el('diagram-space').style.height,`${api.renderer.contentHeight}px`);assert.equal(api.renderer.height,600);
  assert.equal(el('day-select').value,'2018-10-09');assert.equal(el('live-total').textContent,'€5,800');
  assert.equal(el('use-demo').hidden,true);assert.equal(el('import-error').hidden,true);
  assert.equal(el('import-file').disabled,false);assert.equal(api.getState().speed,1);
});

test('long imports adapt all accounts, income sources, dates and scrolling without growing the canvas bitmap',async()=>{
  const raw=historyFixture();raw.meta.startDate='1900-01-01';raw.meta.endDate='2030-12-31';
  for(let i=0;i<118;i++)raw.included.accounts.push({key:`extra_${i}`,id:100+i,name:`Extra ${i}`,type:'savings',openingBalanceMinor:1000,closingBalanceMinor:1000});
  for(let i=0;i<8;i++)raw.data.push({id:5+i,accountKey:'checking_alex',accountId:7,date:'2026-02-01',currency:'EUR',amountMinor:100,balanceBeforeMinor:10500+i*100,balanceAfterMinor:10600+i*100,text:`Source ${i}`,parsedData:{categoryLabel:'Income'}});
  raw.included.accounts[0].closingBalance=113;raw.included.accounts[0].closingBalanceMinor=11300;
  await importFile(raw,'large-history.json',100*1024*1024);
  assert.equal(el('import-error').hidden,true);
  assert.equal(api.model.accounts.length,120);assert.equal(api.model.incomes.length,9);
  assert.equal(el('stat-accounts').textContent,120);assert.ok(el('stat-history').innerHTML.includes('131 '));
  assert.equal(api.renderer.nodes.size,130);assert.equal(el('timeline').max,47847);
  assert.equal(el('day-select').min,'1900-01-01');assert.equal(el('day-select').max,'2030-12-31');
  assert.ok(el('import-status').textContent.includes('9 income sources'));
  assert.ok(el('timeline-chart').innerHTML.includes('viewBox="0 0 1400 44"'));
  assert.equal((el('timeline-chart').innerHTML.match(/class="timeline-curve"/g)||[]).length,2);
  assert.equal(canvas.height,600);assert.ok(api.renderer.contentHeight>19000);
  assert.ok(api.renderer.nodes.get('account-0').y<600);assert.ok(api.renderer.nodes.get('income-salary').y<600);
  const last=api.renderer.nodes.get('account-119');
  el('diagram').scrollTop=Math.min(last.y-250,api.renderer.contentHeight-api.renderer.height);await el('diagram').fire('scroll');advance(50);
  assert.equal(api.renderer.scrollY,el('diagram').scrollTop);
  const y=last.y-api.renderer.scrollY;
  canvas.fire('pointermove',{clientX:last.x,clientY:y});
  assert.equal(api.getState().hover,'account-119');assert.equal(el('tooltip').hidden,false);
  canvas.fire('click',{clientX:last.x,clientY:y});assert.equal(el('detail-title').textContent,'Extra 117');
  el('close-panel').fire('click');
  el('day-select').value='2030-12-31';el('day-select').fire('change');
  assert.equal(api.getState().index,47846);
  api.seek(47847);assert.equal(el('live-total').textContent,'€1,363');
  assert.equal(api.renderer.balances['account-0'],11300);assert.equal(api.renderer.balances['account-119'],1000);
  el('use-demo').fire('click');assert.equal(api.model.days.length,731);assert.equal(api.renderer.scrollY,0);
  assert.equal(el('diagram').scrollTop,0);
});


test('imported overdrafts render red particles in accounts, moving tails and retained expenses', async () => {
  await importFile(overdraftHistory(-2500, [['2026-01-24', -1255]]), 'overdraft.json');
  assert.equal(el('import-error').hidden, true);
  assert.equal(api.renderer.balances['account-0'], -2500);
  assert.ok(api.renderer.nodes.get('account-0').r > 0);
  assert.equal(api.renderer.nodes.get('account-0').active, true);
  const context = api.renderer.ctx, original = context.fill;
  let reds = 0;
  context.fill = function(...args) {if (this.fillStyle === '#ff5252') reds++; return original.apply(this, args);};
  try {
    api.seek(0); assert.ok(reds > 0, 'Initial debt has red particles');
    reds = 0; api.seek(1); assert.ok(reds > 0, 'Debt and outgoing expense particles are red');
    const travelling = api.renderer.snapshot.particles.filter(p => p.value.segment?.kind === 'expense');
    assert.ok(travelling.length > 0); assert.ok(travelling.every(p => p.track.overdraft));
    const lastArrival = Math.max(...api.renderer.motion.tracks.flatMap(t => t.segments.map(s => s.end)));
    reds = 0; api.seek(lastArrival + .04);
    const spent = api.renderer.snapshot.particles.filter(p => p.value.node === api.model.expenses[0].id);
    assert.ok(spent.length > 0); assert.ok(spent.every(p => p.track.overdraft));
    assert.equal(spent.reduce((n,p) => n+p.value.cents, 0), 1255);
    assert.ok(reds >= spent.length); assert.equal(api.renderer.balances['account-0'], -3755);
    for (const n of api.renderer.nodes.values()) assert.ok(Number.isFinite(n.r));
    fs.writeFileSync('/workspace/scratch/b8cc603f4b5d/accounts-flow-overdraft-qa.png', nativeCanvas.toBuffer('image/png'));
    api.seek(api.model.days.findIndex(d => d.monthStart && d.index > 0));
    assert.equal(api.renderer.spending.total, 0);
    assert.ok(!api.renderer.snapshot.particles.some(p => p.value.node === api.model.expenses[0].id));
    assert.equal(api.renderer.balances['account-0'], -3755);
  } finally {context.fill = original; await el('use-demo').fire('click');}
});
