import {UNIT} from './model.js';
import {creditAccount, colourPools} from './debt.js';

export const ease = x => {x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x);};
export function hash(value) {
  let h = 2166136261;
  for (const c of String(value)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (h >>> 0) / 4294967296;
}
const copyWallets = wallets => Object.fromEntries(Object.entries(wallets).map(([key, tokens]) => [key, tokens.map(t => ({...t}))]));

// A bell-shaped departure wave: few leaders, a dense middle and sparse tails.
// Travel time increases through the wave, so the leaders arrive faster and the
// last particles settle more slowly. Tokens are ranked independently of money.
export function waveTiming(rank, count, start, spread, fast, slow) {
  const q = (rank + .5) / count;
  const departure = Math.acos(1 - 2 * q) / Math.PI;
  return {start: start + spread * departure, duration: fast + (slow - fast) * Math.pow(q, 1.35)};
}
const waveRanks = tokens => new Map([...tokens].sort((a, b) => hash(`${a.id}wave`) - hash(`${b.id}wave`)).map((t, i) => [t.id, i]));

// Daily frames are compiled on demand, with compact wallet checkpoints and a
// small frame cache. A two-year history never retains hundreds of full scenes.
// Stable token IDs carry money forward; a transfer moves rather than mints it.
export function compileSimulation(model) {
  let serial = 0;
  const token = (cents, overdraft = false) => ({id: `p${serial++}`, cents, overdraft});
  const chunks = cents => {
    const result = [];
    while (cents > 0) {const part = Math.min(UNIT, cents); result.push(token(part)); cents -= part;}
    return result;
  };
  const opening = Object.fromEntries(model.accounts.map(a => [a.id, chunks(Math.max(0, a.opening))]));
  const openingDebts = Object.fromEntries(model.accounts.map(a => [a.id, chunks(Math.max(0, -a.opening)).map(t => ({...t, cents: -t.cents, overdraft: true}))]));
  const incomeNodes = new Map(model.incomes.map(n => [n.name, n.id]));
  const expenseNodes = new Map(model.expenses.map(n => [n.name, n.id]));
  const emptySpending = () => Object.fromEntries(model.expenses.map(n => [n.id, []]));
  const checkpoints = new Map([[0, {wallets: opening, debts: openingDebts, spendingWallets: emptySpending(), serial}]]);
  const cache = new Map();
  const compileDay = (day, source) => {
    serial = source.serial;
    const wallets = copyWallets(source.wallets);
    const debts = copyWallets(source.debts);
    // Account money always carries forward. Spent money is retained in its
    // category for the calendar month and cleared only when a new month begins.
    const spendingWallets = day.monthStart ? emptySpending() : copyWallets(source.spendingWallets);
    const tracks = new Map();
    const ensure = (t, node, born = 0, income = false) => {
      if (!tracks.has(t.id)) tracks.set(t.id, {id: t.id, seed: hash(t.id), start: node, born, income, overdraft: t.overdraft, weights: [{at: born, cents: t.cents}], segments: [], died: null});
      return tracks.get(t.id);
    };
    for (const [node, pool] of Object.entries({...wallets, ...spendingWallets})) for (const t of pool) ensure(t, node);
    for (const [node, pool] of Object.entries(debts)) for (const t of pool) ensure(t, node);
    const ready = track => Math.max(track.born, track.weights.at(-1).at, track.segments.at(-1)?.end || 0);
    const move = (t, from, to, start, duration, kind) => {
      const track = ensure(t, from, start);
      const last = track.segments.at(-1);
      const afterSplit = track.weights.length > 1 ? track.weights.at(-1).at + .002 : 0;
      const begin = Math.max(start, track.born, afterSplit, last ? last.end + .008 : start);
      track.segments.push({from, to, start: begin, end: begin + duration, kind});
      return track.segments.at(-1);
    };
    const withdraw = flow => {
      let remaining = flow.cents;
      let consumed = 0;
      const pool = wallets[flow.from], packets = [];
      while (remaining > 0) {
        // Use opening cash first so funded payments and transfers can depart
        // alongside income. Only the same money's next hop awaits its arrival.
        const t = pool[consumed];
        if (!t) {
          const part = Math.min(UNIT, remaining);
          packets.push({outgoing: token(part, true), borrowed: true});
          remaining -= part; continue;
        }
        const part = Math.min(t.cents, remaining);
        let outgoing = t, parent = null;
        if (part === t.cents) consumed++;
        else {
          parent = ensure(t, flow.from);
          t.cents -= part;
          outgoing = token(part, t.overdraft);
        }
        packets.push({outgoing, parent, residual: t.cents});
        remaining -= part;
      }
      if (consumed) pool.splice(0, consumed);
      const ranks = waveRanks(packets.map(p => p.outgoing));
      for (const {outgoing, parent, residual, borrowed} of packets) {
        const wave = waveTiming(ranks.get(outgoing.id), packets.length, .06, .20, .09, .20);
        if (parent) {
          const splitAt = Math.max(wave.start, (parent.segments.at(-1)?.end ?? 0) + .008, parent.weights.at(-1).at + .002);
          parent.weights.push({at: splitAt, cents: residual});
          ensure(outgoing, flow.from, splitAt);
        }
        const segment = move(outgoing, flow.from, flow.to, wave.start, wave.duration, flow.kind);
        if (borrowed) {
          const liability = token(-outgoing.cents, true);
          ensure(liability, flow.from, segment.start); debts[flow.from].push(liability);
        }
        if (flow.kind === 'transfer') creditAccount(outgoing, flow.to, wallets, debts, ensure, ready);
        else spendingWallets[flow.to].push(outgoing);
      }
    };
    // Recorded order resolves funding dependencies, but every kind of flow
    // shares the same departure window (there are no income/spending stages).
    for (const t of day.entries) {
      if (t.transferId && t.cents > 0) continue;
      if (t.transferId) {
        withdraw({kind: 'transfer', from: t.account, to: t.target, cents: -t.cents});
      } else if (t.cents < 0) {
        withdraw({kind: 'expense', from: t.account, to: expenseNodes.get(t.category), cents: -t.cents});
      } else if (t.cents > 0) {
        const flow = {from: incomeNodes.get(t.label), to: t.account};
        const packets = chunks(t.cents), ranks = waveRanks(packets);
        for (const packet of packets) {
          ensure(packet, flow.from, 0, true);
          const wave = waveTiming(ranks.get(packet.id), packets.length, .06, .20, .09, .20);
          move(packet, flow.from, flow.to, wave.start, wave.duration, 'income');
          creditAccount(packet, flow.to, wallets, debts, ensure, ready);
        }
      }
    }
    const list = [...tracks.values()];
    const lastArrival = list.reduce((at,t) => Math.max(at,t.segments.at(-1)?.end || 0),0);
    if (lastArrival > .90) {
      const factor = .90 / lastArrival;
      for (const track of list) {
        track.born *= factor;
        if (track.died !== null) track.died *= factor;
        for (const weight of track.weights) weight.at *= factor;
        for (const segment of track.segments) {segment.start *= factor; segment.end *= factor;}
      }
    }
    for (const [node, pool] of Object.entries({...wallets, ...spendingWallets})) {
      const account = node in wallets;
      const stored = account ? wallets : spendingWallets;
      const compacted = [];
      for (const group of colourPools(pool)) {
        const fractional = group.filter(t => t.cents < UNIT);
        if (fractional.length > 1) {
          let total = fractional.reduce((n, t) => n + t.cents, 0);
          const full = group.filter(t => t.cents === UNIT);
          for (const t of fractional) {
            const track = ensure(t, node);
            if (total > 0) {
              t.cents = Math.min(UNIT, total);
              total -= t.cents;
              track.weights.push({at: .985, cents: t.cents});
              full.push(t);
            } else track.died = .985;
          }
          compacted.push(...full);
        } else compacted.push(...group);
      }
      stored[node] = compacted;
      const cents = stored[node].reduce((n, t) => n + t.cents, 0) + (account ? debts[node].reduce((n, t) => n + t.cents, 0) : 0);
      if (cents !== (account ? day.closing[node] : day.spendingClosing[node])) throw new Error(`Particle balance mismatch: ${day.key} ${node}`);
    }
    return {tracks: list, endWallets: wallets, endDebts: debts, endSpendingWallets: spendingWallets, serial};
  };
  const getFrame = index => {
    if (cache.has(index)) return cache.get(index);
    let begin = 0, source = checkpoints.get(0);
    for (const [at, checkpoint] of checkpoints) if (at <= index && at >= begin) {begin = at; source = checkpoint;}
    for (const [at, frame] of cache) if (at < index && at + 1 >= begin) {begin = at + 1; source = {wallets: frame.endWallets, debts: frame.endDebts, spendingWallets: frame.endSpendingWallets, serial: frame.serial};}
    let frame;
    for (let i = begin; i <= index; i++) {
      frame = compileDay(model.days[i], source);
      source = {wallets: frame.endWallets, debts: frame.endDebts, spendingWallets: frame.endSpendingWallets, serial: frame.serial};
      if ((i + 1) % 32 === 0) checkpoints.set(i + 1, source);
    }
    cache.set(index, frame);
    if (cache.size > 4) cache.delete(cache.keys().next().value);
    return frame;
  };
  const frames = new Array(model.days.length);
  const isIndex = property => typeof property === 'string' && /^(0|[1-9]\d*)$/.test(property) && Number(property) < frames.length;
  return new Proxy(frames, {
    get: (target, property, receiver) => isIndex(property) ? getFrame(Number(property)) : Reflect.get(target, property, receiver),
    has: (target, property) => isIndex(property) || Reflect.has(target, property)
  });
}

export function sampleTrack(track, progress) {
  if (progress < track.born || (track.died !== null && progress >= track.died)) return null;
  let cents = track.weights[0].cents;
  for (const weight of track.weights) if (progress >= weight.at) cents = weight.cents;
  let node = track.start;
  for (const segment of track.segments) {
    if (progress < segment.start) break;
    if (progress < segment.end) return {cents, segment, u: ease((progress - segment.start) / (segment.end - segment.start)), node: null};
    node = segment.to;
  }
  return {cents, node, segment: null, u: 0};
}

export function liveBalances(model, frame, progress) {
  const result = Object.fromEntries(model.accounts.map(a => [a.id, 0]));
  for (const track of frame.tracks) {
    const value = sampleTrack(track, progress);
    if (!value) continue;
    if (value.node && value.node in result) result[value.node] += value.cents;
    if (value.segment) {
      const s = value.segment;
      if (s.from in result) result[s.from] += value.cents * (1 - value.u);
      if (s.to in result) result[s.to] += value.cents * value.u;
    }
  }
  return result;
}

// Earlier spending remains visible all month; today's spending accrues on arrival.
// A brief settling ramp lets each incoming €10 smoothly expand its cloud. The
// count activates a category on its first actual arrival, including fractions.
export function liveSpending(model, frame, progress) {
  const amounts = Object.fromEntries(model.expenses.map(n => [n.id, 0]));
  const counts = Object.fromEntries(model.expenses.map(n => [n.id, 0]));
  for (const track of frame.tracks) {
    const value = sampleTrack(track, progress);
    if (!value?.node || !(value.node in amounts)) continue;
    const arrival = track.segments.at(-1)?.end;
    if (arrival === undefined) amounts[value.node] += value.cents;
    else {
      const settling = Math.min(.018, .94 - arrival);
      amounts[value.node] += Math.round(value.cents * ease((progress - arrival) / settling));
    }
    counts[value.node]++;
  }
  return {amounts, counts, total: Object.values(amounts).reduce((a, b) => a + b, 0)};
}

export function localPoint(node, seed, time, offset = 0) {
  const angle = seed * Math.PI * 2 * 13.31 + time * (.06 + seed * .08) + offset;
  const distance = Math.sqrt(hash(`${seed}radius`)) * .88;
  const drift = 1 + .045 * Math.sin(time * .62 + seed * 30);
  return {x: node.x + Math.cos(angle + .07 * Math.sin(time * .4 + seed * 12)) * node.r * distance * drift, y: node.y + Math.sin(angle) * node.r * distance * drift};
}

export function bezierPoint(a, b, u, bend, bounds = null) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const length = Math.hypot(dx, dy) || 1;
  const nx = -dy / length, ny = dx / length;
  const c1 = {x: a.x + dx * .32 + nx * bend, y: a.y + dy * .32 + ny * bend};
  const c2 = {x: a.x + dx * .68 + nx * bend, y: a.y + dy * .68 + ny * bend};
  if (bounds) for (const c of [c1, c2]) {
    c.x = Math.max(4, Math.min(bounds.width - 4, c.x));
    c.y = Math.max(4, Math.min(bounds.height - 4, c.y));
  }
  const v = 1 - u;
  return {x: v * v * v * a.x + 3 * v * v * u * c1.x + 3 * v * u * u * c2.x + u * u * u * b.x, y: v * v * v * a.y + 3 * v * v * u * c1.y + 3 * v * u * u * c2.y + u * u * u * b.y};
}
