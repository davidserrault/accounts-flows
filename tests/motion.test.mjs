import test from 'node:test';
import assert from 'node:assert/strict';
import {DATA} from '../dist/data.js';
import {buildModel,balanceMoney} from '../dist/model.js';
import {sampleTrack} from '../dist/simulation.js';
import {compileMotion,sampleMotion,DEFAULT_SPEED,SECONDS_PER_DAY,PARTICLE_SPEED,TRAVEL_STRETCH} from '../dist/motion.js';
const model=buildModel(DATA),motion=compileMotion(model);

test('cross-day motion starts at every recorded initial balance and finishes at every recorded final balance',()=>{
  assert.deepEqual(sampleMotion(model,motion,0).balances,Object.fromEntries(model.accounts.map(a=>[a.id,a.opening])));
  assert.deepEqual(sampleMotion(model,motion,motion.endAt).balances,Object.fromEntries(model.accounts.map(a=>[a.id,a.closing])));
  assert.equal(sampleMotion(model,motion,0).balances['account-0'],60000);
});
test('renamed 1× keeps the previous calendar and particle timing',()=>{
  assert.equal(DEFAULT_SPEED,1);assert.equal(SECONDS_PER_DAY/DEFAULT_SPEED,.75);assert.equal(PARTICLE_SPEED,.25);assert.equal(TRAVEL_STRETCH,16);
  const segment=motion.tracks.flatMap(t=>t.segments).find(s=>s.kind==='income');
  const duration=(segment.end-segment.start)*SECONDS_PER_DAY/DEFAULT_SPEED;
  const oldDuration=(segment.end-segment.start)/TRAVEL_STRETCH*3;
  assert.ok(Math.abs(duration/oldDuration-4)<.000001);
  assert.ok(segment.end>segment.dayIndex+1,'The trip continues after the next day begins');
  assert.ok(sampleMotion(model,motion,segment.dayIndex+1).particles.some(p=>p.value.segment===segment));
});
test('a particle completes its previous trip before being sent onward or recombined',()=>{
  for(const t of motion.tracks){
    let end=t.born;
    for(const s of t.segments){assert.ok(s.start>=end);assert.ok(s.end>s.start);end=s.end;}
    assert.ok(t.weights.every(w=>w.cents>0&&w.cents<=1000));
    for(let i=1;i<t.weights.length;i++)assert.ok(t.weights[i].at>=t.weights[i-1].at);
    if(t.died!==null)assert.ok(t.died>=end);
  }
});
test('money is conserved continuously through delayed trips, fractional splits and recombination',()=>{
  const checkpoints=new Set([0,motion.endAt]);
  for(let cursor=0;cursor<=motion.endAt;cursor+=.5)checkpoints.add(cursor);
  for(const t of motion.tracks)for(const w of t.weights.slice(1))for(const delta of [-.000001,0,.000001])checkpoints.add(w.at+delta);
  for(const cursor of checkpoints){
    const expected=model.stats.opening+model.days.filter(d=>d.index<=cursor).reduce((n,d)=>n+d.income,0);
    const total=motion.tracks.reduce((n,t)=>n+(sampleTrack(t,cursor)?.cents||0),0);
    assert.equal(total,expected,`Mass at ${cursor}`);
    assert.ok(Object.values(sampleMotion(model,motion,cursor).balances).every(v=>Number.isFinite(v)&&v>=0));
  }
});
test('a small positive account balance is displayed as money, never rounded to zero',()=>{
  assert.equal(balanceMoney(60000),'€600.00');
  assert.equal(balanceMoney(29),'€0.29');
  assert.equal(balanceMoney(.01),'< €0.01');
  assert.equal(balanceMoney(0),'€0.00');
});
test('account balances and retained paths do not reset when the day or month changes',()=>{
  for(const day of model.days.filter(d=>d.monthStart&&d.index>0)){
    const before=sampleMotion(model,motion,day.index-.000001).balances;
    const after=sampleMotion(model,motion,day.index).balances;
    for(const a of model.accounts)assert.ok(Math.abs(before[a.id]-after[a.id])<1,`${day.key} ${a.name}`);
    assert.equal(sampleMotion(model,motion,day.index).spending.total,0,'Only spending resets');
  }
});
