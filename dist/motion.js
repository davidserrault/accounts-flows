import {UNIT} from './model.js';
import {creditAccount, colourPools} from './debt.js';
import {ease, hash, sampleTrack, waveTiming} from './simulation.js';

export const DEFAULT_SPEED = 1;
export const SECONDS_PER_DAY = .75;
export const PARTICLE_SPEED = .25;
// 1× retains the previous 4× playback timing and quarter-speed particle drift.
// Keep trip durations across days unchanged when relabelling the speed scale.
export const TRAVEL_STRETCH = 16;
const sum = pool => pool.reduce((n,t)=>n+t.cents,0);

export function compileMotion(model) {
  let serial=0;
  const tracks=new Map();
  const token=(cents,overdraft=false)=>({id:`v${serial++}`,cents,overdraft});
  const chunks=cents=>{const pool=[];while(cents>0){const part=Math.min(UNIT,cents);pool.push(token(part));cents-=part;}return pool;};
  const wallets=Object.fromEntries(model.accounts.map(a=>[a.id,chunks(Math.max(0,a.opening))]));
  const debts=Object.fromEntries(model.accounts.map(a=>[a.id,chunks(Math.max(0,-a.opening)).map(t=>({...t,cents:-t.cents,overdraft:true}))]));
  const incomeNodes=new Map(model.incomes.map(n=>[n.name,n.id]));
  const expenseNodes=new Map(model.expenses.map(n=>[n.name,n.id]));
  let spending={};
  const ensure=(t,node,born=0,income=false)=>{
    if(!tracks.has(t.id))tracks.set(t.id,{id:t.id,seed:hash(t.id),start:node,born,income,overdraft:t.overdraft,weights:[{at:born,cents:t.cents}],segments:[],died:null,expenseMonth:null});
    return tracks.get(t.id);
  };
  for(const [node,pool] of Object.entries(wallets))for(const t of pool)ensure(t,node);
  for(const [node,pool] of Object.entries(debts))for(const t of pool)ensure(t,node);
  const ready=track=>Math.max(track.born,track.weights.at(-1).at,track.segments.at(-1)?.end||0);
  const move=(t,from,to,wave,day,kind)=>{
    const track=ensure(t,from,day.index+wave.start);
    const hasPriorEvent=track.segments.length>0||track.weights.length>1;
    const start=Math.max(day.index+wave.start,ready(track)+(hasPriorEvent?.008:0));
    track.segments.push({from,to,start,end:start+wave.duration*TRAVEL_STRETCH,kind,dayIndex:day.index,monthKey:day.monthKey});
    if(kind==='expense')track.expenseMonth=day.monthKey;
    return track.segments.at(-1);
  };
  const ranks=packets=>new Map([...packets].sort((a,b)=>hash(`${a.id}wave`)-hash(`${b.id}wave`)).map((t,i)=>[t.id,i]));
  const withdraw=(flow,day)=>{
    let remaining=flow.cents;
    let consumed=0;
    const pool=wallets[flow.from],packets=[];
    while(remaining>0){
      const t=pool[consumed];
      if(!t){
        const part=Math.min(UNIT,remaining);
        packets.push({outgoing:token(part,true),borrowed:true});remaining-=part;continue;
      }
      const part=Math.min(t.cents,remaining);
      let outgoing=t,parent=null;
      if(part===t.cents)consumed++;
      else {parent=ensure(t,flow.from);t.cents-=part;outgoing=token(part,t.overdraft);}
      packets.push({outgoing,parent,residual:t.cents});remaining-=part;
    }
    if(consumed)pool.splice(0,consumed);
    const ranked=ranks(packets.map(p=>p.outgoing));
    for(const {outgoing,parent,residual,borrowed} of packets){
      const wave=waveTiming(ranked.get(outgoing.id),packets.length,.06,.20,.09,.20);
      if(parent){
        const splitAt=Math.max(day.index+wave.start,ready(parent)+.008);
        parent.weights.push({at:splitAt,cents:residual});ensure(outgoing,flow.from,splitAt);
      }
      const segment=move(outgoing,flow.from,flow.to,wave,day,flow.kind);
      if(borrowed){
        const liability=token(-outgoing.cents,true);
        ensure(liability,flow.from,segment.start);debts[flow.from].push(liability);
      }
      if(flow.kind==='transfer')creditAccount(outgoing,flow.to,wallets,debts,ensure,ready);
      else spending[flow.to].push(outgoing);
    }
  };
  for(const day of model.days){
    if(day.monthStart)spending=Object.fromEntries(model.expenses.map(n=>[n.id,[]]));
    if(!day.entries.length)continue;
    for(const t of day.entries){
      if(t.transferId&&t.cents>0)continue;
      if(t.transferId)withdraw({kind:'transfer',from:t.account,to:t.target,cents:-t.cents},day);
      else if(t.cents<0){
        withdraw({kind:'expense',from:t.account,to:expenseNodes.get(t.category),cents:-t.cents},day);
      } else if(t.cents>0){
        const flow={from:incomeNodes.get(t.label),to:t.account};
        const packets=chunks(t.cents),ranked=ranks(packets);
        for(const packet of packets){
          ensure(packet,flow.from,day.index,true);
          move(packet,flow.from,flow.to,waveTiming(ranked.get(packet.id),packets.length,.06,.20,.09,.20),day,'income');
          creditAccount(packet,flow.to,wallets,debts,ensure,ready);
        }
      }
    }
    // Recombine only when all contributing fractions have arrived. Future
    // departures await this event, preserving both money and particle paths.
    for(const [node,pool] of Object.entries({...wallets,...spending})){
      const account=node in wallets,stored=account?wallets:spending;
      const compacted=[];
      for(const group of colourPools(pool)){
        const fractional=group.filter(t=>t.cents<UNIT);
        if(fractional.length>1){
          const at=fractional.reduce((at,t)=>Math.max(at,ready(ensure(t,node))),day.index+.985)+.008;
          let total=sum(fractional);const full=group.filter(t=>t.cents===UNIT);
          for(const t of fractional){
            const track=ensure(t,node);
            if(total>0){t.cents=Math.min(UNIT,total);total-=t.cents;track.weights.push({at,cents:t.cents});full.push(t);}
            else track.died=at;
          }
          compacted.push(...full);
        }else compacted.push(...group);
      }
      stored[node]=compacted;
      if(sum(stored[node])+(account?sum(debts[node]):0)!==(account?day.closing[node]:day.spendingClosing[node]))throw new Error(`Motion ledger mismatch: ${day.key} ${node}`);
    }
  }
  const list=[...tracks.values()];
  const endAt=list.reduce((end,t)=>Math.max(end,ready(t),t.died||0),model.days.length);
  return {tracks:list,endAt};
}

export function sampleMotion(model,motion,cursor) {
  const index=Math.min(model.days.length-1,Math.floor(cursor));
  const day=model.days[index],monthKey=day.monthKey;
  const balances=Object.fromEntries(model.accounts.map(a=>[a.id,0]));
  const amounts=Object.fromEntries(model.expenses.map(n=>[n.id,0]));
  const counts=Object.fromEntries(model.expenses.map(n=>[n.id,0]));
  const particles=[];
  for(const track of motion.tracks){
    if(track.expenseMonth && track.expenseMonth!==monthKey && cursor>=track.segments.at(-1).end)continue;
    const value=sampleTrack(track,cursor);if(!value)continue;
    if(value.node in balances)balances[value.node]+=value.cents;
    if(value.segment){
      const {from,to}=value.segment;
      if(from in balances)balances[from]+=value.cents*(1-value.u);
      if(to in balances)balances[to]+=value.cents*value.u;
    }
    if(value.node in amounts){
      if(track.expenseMonth!==monthKey)continue;
      const arrival=track.segments.at(-1).end;
      amounts[value.node]+=Math.round(value.cents*ease((cursor-arrival)/.018));
      counts[value.node]++;
    }
    const last=value.segment||track.segments.at(-1);
    particles.push({track,value,monthKey:last?.monthKey});
  }
  // Floating point addition can leave tiny residuals at genuinely empty nodes.
  for(const id in balances)if(Math.abs(balances[id])<.000001)balances[id]=0;
  return {balances,spending:{amounts,counts,total:Object.values(amounts).reduce((a,b)=>a+b,0)},particles};
}
