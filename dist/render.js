import {money, balanceMoney, dateLabel} from './model.js';
import {localPoint, bezierPoint, ease, hash} from './simulation.js';
import {compileMotion, sampleMotion} from './motion.js';
import {diagramLayout} from './layout.js';

const PARTICLE_SCALE = 1.5;
// Truncate labels instead of letting canvas compress their font below 9 px.
function fitText(context, text, width) {
  if (context.measureText(text).width <= width) return text;
  const letters = Array.from(text);
  let low = 0, high = letters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (context.measureText(letters.slice(0, middle).join('') + '…').width <= width) low = middle;
    else high = middle - 1;
  }
  return letters.slice(0, low).join('') + '…';
}

export class FlowRenderer {
  constructor(canvas, model, frames) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', {alpha: false});
    if (!this.ctx) throw new Error('Canvas rendering is unavailable');
    this.width = 1200;
    this.height = 570;
    this.nodes = new Map();
    this.setModel(model, frames);
  }
  setModel(model, frames, motion = compileMotion(model)) {
    let peak = model.accounts.reduce((peak,a) => Math.max(peak,Math.abs(a.opening)),100);
    const peaks = {accounts: peak, incomes: 0, expenses: 0};
    for (const day of model.activityDays) {
      for (const a of model.accounts) peaks.accounts = Math.max(peaks.accounts, Math.abs(day.opening[a.id]), Math.abs(day.closing[a.id]), day.opening[a.id] + day.received[a.id]);
      for (const n of model.incomes) peaks.incomes = Math.max(peaks.incomes, day.nodeAmounts[n.id]);
      for (const cents of Object.values(day.spendingClosing)) peaks.expenses = Math.max(peaks.expenses, cents);
    }
    peak = Math.max(...Object.values(peaks));
    this.model = model;
    this.frames = frames;
    this.motion = motion;
    this.peak = peak;
    this.columnPeaks = peaks;
    this.nodes = new Map();
    this.incomeAnchors = new Map();
  }
  resize(width, height, ratio = 1, contentHeight = height) {
    this.width = width;
    this.height = height;
    this.contentHeight = contentHeight;
    this.scrollY = Math.max(0, Math.min(this.scrollY || 0, contentHeight - height));
    this.ratio = Math.min(ratio, 2);
    this.canvas.width = Math.round(width * this.ratio);
    this.canvas.height = Math.round(height * this.ratio);
    this.ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    this.scale = Math.min(75, height * .072) / Math.sqrt(this.peak / 100);
    this.columnRadii = Object.fromEntries(Object.entries(this.columnPeaks).map(([kind, cents]) => [kind, Math.sqrt(cents / 100) * this.scale]));
    this.incomeAnchors.clear();
  }
  layout(index, progress) {
    const day = this.model.days[index];
    this.snapshot = sampleMotion(this.model, this.motion, this.motionCursor);
    this.balances = this.snapshot.balances;
    this.spending = this.snapshot.spending;
    const positions = new Map();
    const make = (node, x, y, cents, active = cents !== 0) => {
      const r = Math.sqrt(Math.abs(cents) / 100) * this.scale;
      positions.set(node.id, {...node, x, y, cents, active, r, labelY: y + Math.max(r, 5) + 15});
    };
    const incomes = this.model.monthlyIncomes.get(day.monthKey) || [];
    const incomeRows = new Map(incomes.map((n, i) => [n.id, i]));
    const columns = diagramLayout({...this.model, incomes}, this.height, this.columnRadii);
    this.contentHeight = columns.height;
    this.scrollY = Math.max(0, Math.min(this.scrollY || 0, this.contentHeight - this.height));
    this.model.incomes.forEach(n => make({...n, visible: incomeRows.has(n.id), labelCents: day.incomeClosing[n.id]}, this.width * .15, columns.top + (incomeRows.get(n.id) || 0) * columns.steps.incomes, day.nodeAmounts[n.id], day.incomeClosing[n.id] > 0));
    this.model.accounts.forEach((n, i) => make({...n, kind: 'account'}, this.width * .48, columns.top + i * columns.steps.accounts, this.balances[n.id]));
    this.model.expenses.forEach((n, i) => make(n, this.width * (.715 + (i % 3) * .112), columns.top + Math.floor(i / 3) * columns.steps.expenses, this.spending.amounts[n.id], this.spending.counts[n.id] > 0));
    this.nodes = positions;
    return positions;
  }
  incomeOrigin(id, dayIndex) {
    const key = `${id}:${dayIndex}`;
    if (!this.incomeAnchors.has(key)) {
      const day = this.model.days[dayIndex];
      const sources = this.model.monthlyIncomes.get(day.monthKey) || [];
      const row = sources.findIndex(n => n.id === id);
      const columns = diagramLayout({...this.model, incomes: sources}, this.height, this.columnRadii);
      this.incomeAnchors.set(key, {...this.nodes.get(id), x: this.width * .15, y: columns.top + Math.max(0, row) * columns.steps.incomes,
        r: Math.sqrt((day.nodeAmounts[id] || 0) / 100) * this.scale});
    }
    return this.incomeAnchors.get(key);
  }
  draw(index, progress, time, focus = null, reduced = false, motionCursor = null) {
    const c = this.ctx, w = this.width;
    const day = this.model.days[index];
    this.motionCursor = motionCursor ?? (index + progress >= this.model.days.length ? this.motion.endAt : index + progress);
    const nodes = this.layout(index, progress);
    const h = this.contentHeight, top = this.scrollY || 0, bottom = top + this.height;
    c.fillStyle = '#0b0b0b'; c.fillRect(0, 0, w, this.height);
    c.save();c.translate(0, -top);
    c.lineWidth = .7; c.strokeStyle = '#272725'; c.setLineDash([2, 6]);
    for (const x of [.31, .64]) {c.beginPath(); c.moveTo(w * x, top + 7); c.lineTo(w * x, bottom - 15); c.stroke();}
    c.setLineDash([]);
    const connected = new Set(focus ? [focus] : []);
    for (const flow of [...day.incomeFlows, ...day.transferFlows, ...day.expenseFlows]) if (flow.from === focus || flow.to === focus) {connected.add(flow.from); connected.add(flow.to);}
    const fadeNode = n => !focus || connected.has(n) ? 1 : .19;
    for (const flow of [...day.incomeFlows, ...day.transferFlows, ...day.expenseFlows]) {
      if (!focus || (flow.from !== focus && flow.to !== focus)) continue;
      const a = nodes.get(flow.from), b = nodes.get(flow.to);
      if (!a || !b) continue;
      c.globalAlpha = .32;
      c.strokeStyle = '#d9d9d3'; c.lineWidth = .7;
      c.beginPath();c.moveTo(a.x, a.y);
      const bend = flow.kind === 'transfer' ? -65 : (hash(flow.from + flow.to) - .5) * 90;
      const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy) || 1;
      c.bezierCurveTo(a.x + dx * .32 - dy / length * bend, a.y + dy * .32 + dx / length * bend, a.x + dx * .68 - dy / length * bend, a.y + dy * .68 + dx / length * bend, b.x, b.y);
      c.stroke();
    }
    c.globalAlpha = 1;
    for (const n of nodes.values()) {
      if (n.visible === false) continue;
      if (n.y + n.r < top || n.y - n.r > bottom) continue;
      if (!focus || !connected.has(n.id)) continue;
      c.globalAlpha = fadeNode(n.id);
      if (n.r > 0) {
        c.beginPath(); c.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        c.fillStyle = n.kind === 'account' ? '#121211' : '#0f0f0e';c.fill();
        c.strokeStyle = focus === n.id ? '#d3d3cc' : n.kind === 'account' ? '#494945' : '#3b3b37'; c.lineWidth = .7;c.stroke();
        if (n.kind === 'account') {
          c.globalAlpha = fadeNode(n.id) * .18;
          c.beginPath();c.arc(n.x, n.y, n.r + 4, -.5, -.5 + Math.PI * 1.65);c.strokeStyle = '#7c7c76';c.lineWidth = .45;c.stroke();
        }
      } else {
        c.globalAlpha = fadeNode(n.id) * .36;c.fillStyle = '#7f7f79';c.beginPath();c.arc(n.x, n.y, 1.4, 0, Math.PI * 2);c.fill();
      }
    }
    c.fillStyle = '#ebebe4';
    for (const {track, value} of this.snapshot.particles) {
      c.fillStyle = track.overdraft ? '#ff5252' : '#ebebe4';
      const particleCents = Math.abs(value.cents);
      let alpha = .79, point, from, to;
      if (track.income) alpha *= ease((this.motionCursor - track.born) / .06);
      if (value.segment) {
        from = value.segment.kind === 'income' ? this.incomeOrigin(value.segment.from, value.segment.dayIndex) : nodes.get(value.segment.from);
        to = nodes.get(value.segment.to);
        if (!from || !to) continue;
        const a = localPoint(from, track.seed, time), b = localPoint(to, track.seed, time);
        const bend = (track.seed - .5) * (value.segment.kind === 'transfer' ? 140 : 100);
        point = bezierPoint(a, b, value.u, bend, {width: w, height: h});
        const selected = !focus || value.segment.from === focus || value.segment.to === focus;
        alpha *= selected ? 1 : .15;
        if (!reduced && value.u > .06 && value.u < .97 && point.y >= top - 4 && point.y <= bottom + 4) {
          const tail = bezierPoint(a, b, Math.max(0, value.u - .032), bend, {width: w, height: h});
          c.globalAlpha = alpha * .15;c.beginPath();c.arc(tail.x, tail.y, PARTICLE_SCALE * .7 * Math.sqrt(particleCents / 1000), 0, Math.PI * 2);c.fill();
        }
      } else {
        const n = value.node?.startsWith('income-') ? this.incomeOrigin(value.node, Math.floor(track.born)) : nodes.get(value.node);
        if (!n) continue;
        point = localPoint(n, track.seed, reduced ? 0 : time);
        alpha *= fadeNode(value.node);
        if (n.kind === 'expense' && day.monthEnd) alpha *= 1 - ease((progress - .94) / .06);
      }
      if (point.y < top - 4 || point.y > bottom + 4) continue;
      c.globalAlpha = alpha;
      c.beginPath();c.arc(point.x, point.y, PARTICLE_SCALE * Math.max(.16, 1.05 * Math.sqrt(particleCents / 1000)), 0, Math.PI * 2);c.fill();
    }
    c.textAlign = 'center';c.textBaseline = 'middle';
    for (const n of nodes.values()) {
      if (n.visible === false) continue;
      c.globalAlpha = fadeNode(n.id) * (n.active ? 1 : .38);
      const y = n.y + Math.max(n.r, 5) + 15;
      n.labelY = y;
      if (y + 42 < top || y - 8 > bottom) continue;
      // Backplates keep routes and travelling particles from obscuring labels.
      const labelWidth = n.kind === 'expense' ? Math.min(130, this.width * .112 - 8) : 164;
      c.fillStyle = '#0b0b0b';c.fillRect(n.x - labelWidth / 2, y - 8, labelWidth, n.kind === 'account' ? 42 : 32);
      const negativeBalance = n.kind === 'account' && n.cents < 0;
      c.fillStyle = negativeBalance ? '#ff5252' : n.kind === 'account' ? '#efefe9' : '#c8c8c1';
      c.font = `${n.kind === 'account' ? 12 : n.kind === 'income' ? 12 : 10}px Arial, sans-serif`;
      c.fillText(fitText(c, n.name, labelWidth), n.x, y);
      c.fillStyle = negativeBalance ? '#ff5252' : n.kind === 'income' ? '#ffffff' : n.kind === 'account' ? '#b7b7ae' : '#95958d';
      if (n.kind === 'income' && n.labelCents > 0) c.globalAlpha = 1;
      c.font = `${n.kind === 'account' ? 11 : 10}px "Liberation Mono", monospace`;
      c.fillText(fitText(c, n.kind === 'account' ? balanceMoney(n.cents) : money(n.labelCents ?? n.cents), labelWidth), n.x, y + 16);
      if (n.kind === 'account') {
        c.fillStyle = '#64645e';c.font = '9px Arial, sans-serif';
        const type = n.type === 'checking' ? 'CURRENT' : n.type === 'investment' ? 'INVESTMENT' : 'SAVINGS';
        c.fillText(type, n.x, y + 31);
      }
    }
    c.globalAlpha = 1;
    c.restore();
    this.description = `${dateLabel(day.key)}. Income ${money(day.income, 2)}; spending this month so far ${money(this.spending.total, 2)}; total account balance ${money(Object.values(this.balances).reduce((a, b) => a + b, 0), 2)}.`;
  }
  hitTest(x, y) {
    let found = null, distance = Infinity;
    for (const n of this.nodes.values()) {
      if (n.visible === false) continue;
      const d = Math.hypot(x - n.x, y - n.y);
      const inLabel = Math.abs(x - n.x) < 78 && y >= n.labelY - 9 && y <= n.labelY + (n.kind === 'account' ? 37 : 25);
      if ((d <= Math.max(10, n.r + 5) || inLabel) && d < distance) {found = n;distance = d;}
    }
    return found;
  }
}
