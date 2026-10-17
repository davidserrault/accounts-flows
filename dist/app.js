import {DATA} from './data.js';
import {buildModel, cursorState, money, balanceMoney, dateLabel} from './model.js';
import {compileSimulation} from './simulation.js';
import {DEFAULT_SPEED, SECONDS_PER_DAY, PARTICLE_SPEED} from './motion.js';
import {parseHistory} from './import.js';
import {availableDiagramHeight, timelineBalanceChart} from './layout.js';
import {FlowRenderer} from './render.js';

const $ = id => document.getElementById(id);
const text = (id, value) => {$(id).textContent = value;};
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let model = buildModel(DATA);
let frames = compileSimulation(model);
const canvas = $('flow-canvas');
const renderer = new FlowRenderer(canvas, model, frames);
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const state = {cursor: 0, motionCursor: 0, playing: false, speed: DEFAULT_SPEED, loop: false, time: 0, hover: null, selected: null, shown: 10, last: null, dirty: true, lastUI: -1000};
let lastFocus = null;
let importSequence = 0;
const finished = () => state.cursor === model.days.length && state.motionCursor >= renderer.motion.endAt;

function refreshDataset() {
  text('person-name', model.meta.subject);
  text('stat-accounts', model.accounts.length);
  text('stat-transactions', model.stats.transactionCount.toLocaleString('en-GB'));
  text('stat-income', money(model.stats.monthlyIncome));
  text('stat-expense', money(model.stats.monthlyExpense));
  for (const id of ['stat-income', 'stat-expense']) $(id).setAttribute('title', `Average over ${model.stats.monthCount} calendar months (including partial months)`);
  const days = model.days.length;
  const years = Math.round(days / 365.25 * 10) / 10;
  $('stat-history').innerHTML = days >= 365 ? `${years} <span class="unit-word">${years === 1 ? 'year' : 'years'}</span>` : `${days} <span class="unit-word">${days === 1 ? 'day' : 'days'}</span>`;
  $('stat-averages').innerHTML = `${money(model.stats.averageCredit)}<span class="average-slash"> / </span>${money(model.stats.averagePayment)}`;
  $('day-select').min = model.meta.start;
  $('day-select').max = model.meta.end;
  $('timeline').max = days;
  $('timeline-labels').innerHTML = [0, .2, .4, .6, .8, 1].map(position => {
    const day = model.days[Math.min(days - 1, Math.round(position * days))];
    const label = new Date(`${day.key}T00:00:00Z`).toLocaleDateString('en-GB', {month: 'short', year: 'numeric', timeZone: 'UTC'}).toUpperCase();
    return `<span style="left:${position * 100}%">${label}</span>`;
  }).join('');
}
function refreshTimeline() {
  const {width, height, zeroY, hasNegative, line, area} = timelineBalanceChart(model, $('timeline-chart').getBoundingClientRect().width);
  const positiveHeight = hasNegative ? zeroY : height, negativeHeight = hasNegative ? height - zeroY : 0;
  $('timeline-chart').innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="timeline-positive"><rect width="${width}" height="${positiveHeight}"/></clipPath><clipPath id="timeline-negative"><rect y="${zeroY}" width="${width}" height="${negativeHeight}"/></clipPath></defs><path class="timeline-zero" d="M0 ${zeroY}H${width}"/><g clip-path="url(#timeline-positive)" class="timeline-positive"><path class="timeline-area" d="${area}"/><path class="timeline-curve" d="${line}"/></g><g clip-path="url(#timeline-negative)" class="timeline-negative"><path class="timeline-area" d="${area}"/><path class="timeline-curve" d="${line}"/></g></svg>`;
}
function loadDataset(data) {
  const nextModel = buildModel(data);
  const nextFrames = compileSimulation(nextModel);
  // Compile before replacing anything, so a rejected import keeps the current view.
  renderer.setModel(nextModel, nextFrames);
  if (state.selected) closePanel();
  model = nextModel;frames = nextFrames;
  Object.assign(state, {cursor: 0, motionCursor: 0, playing: false, time: 0, hover: null, selected: null, shown: 10, last: null, dirty: true, lastUI: -1000});
  $('tooltip').hidden = true;
  canvas.style.cursor = 'default';
  $('diagram').scrollTop = 0;
  renderer.scrollY = 0;
  refreshDataset();resize();
}

function current() {return cursorState(state.cursor, model.days.length);}
function draw() {
  const {index, progress} = current();
  if (state.hover?.startsWith('income-') && !(model.monthlyIncomes.get(model.days[index].monthKey) || []).some(n => n.id === state.hover)) {
    state.hover = null;
    $('tooltip').hidden = true;
  }
  renderer.draw(index, progress, state.time, state.hover, reduceMotion.matches, state.motionCursor);
  const contentHeight = `${renderer.contentHeight}px`;
  if ($('diagram-space').style.height !== contentHeight) $('diagram-space').style.height = contentHeight;
  $('diagram').style.setProperty('--diagram-scroll', `${renderer.scrollY}px`);
  state.dirty = false;
}
function syncUI() {
  const {index, progress} = current(), m = model.days[index];
  $('play-text').textContent = state.playing ? 'Pause' : finished() ? 'Replay' : 'Play';
  $('play').setAttribute('aria-label', state.playing ? 'Pause animation' : finished() ? 'Replay animation' : 'Play animation');
  $('play').setAttribute('title', $('play').getAttribute('aria-label'));
  $('play-icon').innerHTML = `<use href="#i-${state.playing ? 'pause' : 'play'}"/>`;
  $('day-select').value = m.key;
  $('speed').value = state.speed;
  text('observed-period', `${index + 1} / ${model.days.length} days`);
  text('day-income', money(Object.values(m.incomeClosing).reduce((a, b) => a + b, 0)));
  text('day-expense', money(renderer.spending.total));
  text('live-total', money(Object.values(renderer.balances || m.opening).reduce((a, b) => a + b, 0)));
  $('timeline').value = state.cursor;
  $('timeline').style.setProperty('--progress', `${state.cursor / model.days.length * 100}%`);
  $('timeline').setAttribute('aria-valuetext', `${dateLabel(m.key)}, ${Math.round(progress * 100)}% through day`);
  canvas.setAttribute('aria-label', `${renderer.description || ''} Select a circle for transaction details.`);
  if (state.hover && !$('tooltip').hidden) {
    const node = renderer.nodes.get(state.hover);
    if (node) $('tooltip').innerHTML = tooltipContents(node);
  }
  if (state.selected) renderPanel();
}
function seek(value, pause = true) {
  state.cursor = cursorState(value, model.days.length).cursor;
  state.motionCursor = state.cursor === model.days.length ? renderer.motion.endAt : state.cursor;
  if (pause) state.playing = false;
  state.hover = null;
  $('tooltip').hidden = true;
  state.dirty = true;
  draw();syncUI();
}
function play() {
  if (finished()) {state.cursor = 0; state.motionCursor = 0;}
  state.playing = true;state.last = null;state.dirty = true;
  syncUI();
}
function pause() {state.playing = false;state.dirty = true;syncUI();}
function togglePlay() {state.playing ? pause() : play();}
function importFeedback(message, error = false) {
  $('import-feedback').hidden = !message;
  $('import-status').hidden = error || !message;
  $('import-error').hidden = !error;
  text(error ? 'import-error' : 'import-status', message);
}
$('import-file').addEventListener('click', () => $('history-file').click());
$('history-file').addEventListener('change', async e => {
  const file = e.target.files?.[0];
  if (!file) return;
  const sequence = ++importSequence;
  $('import-file').disabled = true;
  $('import-file').setAttribute('aria-busy', 'true');
  importFeedback(`Reading ${file.name}…`);
  try {
    const source = await file.text();
    if (sequence !== importSequence) return;
    const data = parseHistory(source);
    loadDataset(data);
    $('use-demo').hidden = false;
    importFeedback(`${file.name} · ${model.accounts.length} accounts · ${model.incomes.length} income sources · ${model.days.length.toLocaleString('en-GB')} days · ${model.stats.transactionCount.toLocaleString('en-GB')} operations loaded`);
  } catch (error) {
    if (sequence === importSequence) importFeedback(error.message || 'This file could not be read. Try another JSON export.', true);
  } finally {
    if (sequence === importSequence) {
      $('import-file').disabled = false;
      $('import-file').setAttribute('aria-busy', 'false');
      e.target.value = '';
    }
  }
});
$('use-demo').addEventListener('click', () => {
  ++importSequence;
  loadDataset(DATA);
  $('use-demo').hidden = true;
  $('import-file').disabled = false;
  $('import-file').setAttribute('aria-busy', 'false');
  $('history-file').value = '';
  importFeedback('Demo history restored.');
});
function stepDay(direction) {
  const {index} = current();
  const target = direction > 0 ? Math.min(model.days.length, index + 1) : Math.max(0, index - 1);
  seek(target);
}
function animate(now) {
  const dt = state.last === null ? 0 : Math.max(0, Math.min(.2, (now - state.last) / 1000));
  state.last = now;
  if (state.playing) {
    state.motionCursor += dt * state.speed / SECONDS_PER_DAY;
    state.cursor = Math.min(model.days.length, state.motionCursor);
    state.time += dt * (state.speed / DEFAULT_SPEED) * PARTICLE_SPEED;
    // Let the last particles arrive even after the calendar reaches its end.
    if (state.motionCursor >= renderer.motion.endAt) {
      if (state.loop) {state.cursor = 0; state.motionCursor = 0;}
      else {state.cursor = model.days.length;state.motionCursor = renderer.motion.endAt;state.playing = false;}
    }
    state.dirty = true;
  }
  const drew = state.dirty;
  if (drew) {draw();}
  if (drew && (now - state.lastUI >= 75 || !state.playing)) {syncUI();state.lastUI = now;}
  requestAnimationFrame(animate);
}

$('play').addEventListener('click', togglePlay);
$('timeline').addEventListener('input', e => seek(e.target.value));
$('timeline').addEventListener('keydown', e => {
  if (e.key === 'PageUp' || e.key === 'PageDown') {e.preventDefault();stepDay(e.key === 'PageDown' ? 1 : -1);}
});
$('day-select').addEventListener('change', e => {
  const index = (Date.parse(e.target.value) - Date.parse(model.meta.start)) / 86400000;
  if (Number.isInteger(index) && model.days[index]?.key === e.target.value) seek(index);
  else syncUI();
});
$('speed').addEventListener('change', e => {state.speed = Number(e.target.value);syncUI();});
$('loop').addEventListener('click', () => {state.loop = !state.loop;$('loop').setAttribute('aria-pressed', String(state.loop));});

function pointerNode(event) {
  const rect = canvas.getBoundingClientRect();
  return {node: renderer.hitTest((event.clientX - rect.left) * renderer.width / rect.width, (event.clientY - rect.top) * renderer.height / rect.height + renderer.scrollY), x: event.clientX - rect.left, y: event.clientY - rect.top};
}
function tooltipContents(node) {
  const m = model.days[current().index];
  const detail = node.kind === 'account' ? `Closing balance: ${money(m.closing[node.id], 2)}` : 'Month to date total · select for transactions';
  const negativeClass = node.kind === 'account' && node.cents < 0 ? 'negative-balance' : '';
  return `<strong class="${negativeClass}">${escape(node.name)}</strong><div class="tooltip-value ${negativeClass}">${node.kind === 'account' ? balanceMoney(node.cents) : money(node.labelCents ?? node.cents, 2)}</div><small>${escape(detail)}</small>`;
}
canvas.addEventListener('pointermove', e => {
  if (e.pointerType === 'touch') return;
  const {node, x, y} = pointerNode(e);
  state.hover = node?.id || null;state.dirty = true;
  canvas.style.cursor = node ? 'pointer' : 'default';
  const tip = $('tooltip');
  tip.hidden = !node;
  if (node) {
    tip.innerHTML = tooltipContents(node);
    tip.style.left = `${Math.max(8, Math.min(renderer.width - 240, x + 15))}px`;
    tip.style.top = `${renderer.scrollY + Math.max(8, Math.min(renderer.height - 90, y - 85))}px`;
  }
});
canvas.addEventListener('pointerleave', () => {state.hover = null;state.dirty = true;$('tooltip').hidden = true;canvas.style.cursor = 'default';});
let pointerStart = null;
canvas.addEventListener('pointerdown', e => {pointerStart = {x: e.clientX, y: e.clientY};});
canvas.addEventListener('click', e => {
  if (pointerStart && Math.hypot(e.clientX - pointerStart.x, e.clientY - pointerStart.y) > 8) return;
  const {node} = pointerNode(e);if (node) openPanel(node.id);
});

function panelEntries(node, day) {
  if (node.kind === 'account') return day.entries.filter(t => t.account === node.id);
  if (node.kind === 'income') return model.days.slice(day.monthStartIndex, day.index + 1).flatMap(d => d.incomeFlows.filter(f => f.from === node.id).flatMap(f => f.transactions));
  return model.days.slice(day.monthStartIndex, day.index + 1).flatMap(d => d.expenseFlows.filter(f => f.to === node.id).flatMap(f => f.transactions));
}
function renderPanel() {
  const node = model.nodes.find(n => n.id === state.selected);
  if (!node) return;
  const {index} = current(), day = model.days[index];
  const entries = panelEntries(node, day).sort((a, b) => b.date.localeCompare(a.date) || Number(b.id) - Number(a.id));
  text('detail-kind', node.kind === 'account' ? 'ACCOUNT' : node.kind === 'income' ? 'INCOME SOURCE' : 'SPENDING CATEGORY');
  text('detail-title', node.name);
  text('detail-period', node.kind === 'account' ? dateLabel(day.key) : `${dateLabel(model.days[day.monthStartIndex].key)} — ${dateLabel(day.key)}`);
  const cents = node.kind === 'account' ? renderer.balances[node.id] : node.kind === 'expense' ? renderer.spending.amounts[node.id] : day.incomeClosing[node.id];
  const negativeBalance = node.kind === 'account' && cents < 0;
  $('detail-title').classList.toggle('negative-balance', negativeBalance);
  const label = node.kind === 'account' ? 'Rolling balance at this point in the animation' : node.kind === 'income' ? 'Received so far this month' : 'Spent so far this month';
  const row = (label, value) => `<div class="detail-metric-row"><span>${label}</span><strong>${value}</strong></div>`;
  const details = node.kind === 'account'
    ? row('Initial balance', money(node.opening, 2)) + row('Start of day balance', money(day.opening[node.id], 2)) + row('Received (including transfers)', money(day.received[node.id], 2)) + row('Paid (including transfers)', money(day.paid[node.id], 2)) + row('Closing balance', money(day.closing[node.id], 2)) + row('Account type', node.type === 'checking' ? 'Current account' : node.type === 'investment' ? 'Investment' : 'Savings') + row('Bank', escape(node.bank))
    : node.kind === 'expense'
      ? row('Spent before today', money(day.spendingOpening[node.id], 2)) + row("Today's total", money(day.nodeAmounts[node.id], 2)) + row('Month to date total', money(day.spendingClosing[node.id], 2)) + row('Transactions', entries.length) + row('Share of spending so far', `${((cents / renderer.spending.total || 0) * 100).toFixed(1)}%`)
      : row('Received before today', money(day.incomeOpening[node.id], 2)) + row("Today's total", money(day.nodeAmounts[node.id], 2)) + row('Month to date total', money(cents, 2)) + row('Transactions', entries.length) + row('Share of income so far', `${((cents / (Object.values(day.incomeClosing).reduce((a, b) => a + b, 0)) || 0) * 100).toFixed(1)}%`);
  $('detail-metrics').innerHTML = `<p class="detail-main-value${negativeBalance ? ' negative-balance' : ''}">${node.kind === 'account' ? balanceMoney(cents) : money(cents, 2)}</p><p class="detail-main-label">${label}</p>${details}`;
  const transactionMarkup = entries.slice(0, state.shown).map(t => {
    const account = model.accountMap.get(t.account);
    const target = model.accountMap.get(t.target);
    const label = t.transferId ? `${t.cents < 0 ? 'To' : 'From'} ${target?.name || 'another account'}` : t.label;
    return `<div class="transaction"><strong>${escape(label)}</strong><span class="transaction-amount">${t.cents < 0 ? '−' : '+'}${money(Math.abs(t.cents), 2)}</span><small class="transaction-meta">${dateLabel(t.date)} · ${escape(account.name)}${t.transferId ? ' · internal transfer' : ''}${node.kind === 'account' ? `<br>Balance: ${money(t.before, 2)} → ${money(t.after, 2)}` : ''}</small></div>`;
  }).join('');
  const period = node.kind === 'account' ? 'today' : 'this month to date';
  $('detail-transactions').innerHTML = `<span class="detail-subheading">${entries.length} ${entries.length === 1 ? 'transaction' : 'transactions'} ${period}</span>${transactionMarkup || `<p class="no-activity">No activity ${period}.</p>`}`;
  $('more-transactions').hidden = entries.length <= state.shown;
  text('more-transactions', `Show more (${Math.max(0, entries.length - state.shown)} remaining)`);
}
function openPanel(id) {
  lastFocus = document.activeElement;
  pause();state.selected = id;state.shown = 10;state.hover = null;
  $('tooltip').hidden = true;$('detail-panel').hidden = false;$('panel-scrim').hidden = false;
  document.body.style.overflow = 'hidden';
  draw();renderPanel();$('close-panel').focus();
}
function closePanel() {
  state.selected = null;$('detail-panel').hidden = true;$('panel-scrim').hidden = true;
  document.body.style.overflow = '';state.dirty = true;
  (lastFocus || canvas).focus();
}
$('close-panel').addEventListener('click', closePanel);
$('panel-scrim').addEventListener('click', closePanel);
$('more-transactions').addEventListener('click', () => {state.shown += 10;renderPanel();});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && state.selected) {closePanel();return;}
  if (state.selected && e.key === 'Tab') {
    const first = $('close-panel'), last = $('more-transactions').hidden ? first : $('more-transactions');
    if (e.shiftKey && document.activeElement === first) {e.preventDefault();last.focus();}
    else if (!e.shiftKey && document.activeElement === last) {e.preventDefault();first.focus();}
    return;
  }
  if (state.selected || /INPUT|SELECT|TEXTAREA|BUTTON/.test(e.target.tagName)) return;
  if (e.code === 'Space') {e.preventDefault();togglePlay();}
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {e.preventDefault();stepDay(e.key === 'ArrowRight' ? 1 : -1);}
});
document.addEventListener('visibilitychange', () => {if (document.hidden && state.playing) pause();state.last = null;});
function resize() {
  let rect = $('diagram').getBoundingClientRect();
  if (Number.isFinite(window.innerHeight)) {
    const viewport = $('diagram-viewport');
    const scrollbar = Math.max(0, (viewport.offsetHeight || 0) - (viewport.clientHeight || 0));
    const height = availableDiagramHeight(rect.top, $('transport').getBoundingClientRect().top - scrollbar);
    if ($('diagram').style.height !== `${height}px`) $('diagram').style.height = `${height}px`;
    rect = $('diagram').getBoundingClientRect();
  }
  canvas.style.height = `${rect.height}px`;
  $('diagram').style.setProperty('--diagram-height', `${rect.height}px`);
  renderer.resize($('diagram').clientWidth || rect.width, rect.height, window.devicePixelRatio || 1);
  $('diagram').style.setProperty('--diagram-scroll', `${renderer.scrollY}px`);
  refreshTimeline();
  state.dirty = true;draw();syncUI();
}
const mobileSummary = window.matchMedia('(max-width: 680px)');
function setSummaryExpanded(expanded) {
  const visible = !mobileSummary.matches || expanded;
  $('summary-content').hidden = !visible;
  $('summary-toggle').setAttribute('aria-expanded', String(visible));
  $('summary-toggle').innerHTML = `${visible ? 'Hide' : 'Show'} <span aria-hidden="true">${visible ? '−' : '+'}</span>`;
  resize();
}
$('summary-toggle').addEventListener('click', () => setSummaryExpanded($('summary-content').hidden));
mobileSummary.addEventListener('change', () => setSummaryExpanded(false));
setSummaryExpanded(false);
$('diagram').addEventListener('scroll', () => {
  renderer.scrollY = Math.max(0, Math.min($('diagram').scrollTop, renderer.contentHeight - renderer.height));
  $('diagram').style.setProperty('--diagram-scroll', `${renderer.scrollY}px`);
  state.hover = null;$('tooltip').hidden = true;
  state.dirty = true;
});
new ResizeObserver(resize).observe($('diagram'));
const sizeDock = () => {
  document.documentElement.style.setProperty('--transport-height', `${$('transport').getBoundingClientRect().height}px`);
  resize();
};
new ResizeObserver(sizeDock).observe($('transport'));
sizeDock();
new ResizeObserver(resize).observe($('masthead'));
new ResizeObserver(resize).observe($('overview'));
window.addEventListener('resize', resize);
new ResizeObserver(refreshTimeline).observe($('timeline-chart'));
reduceMotion.addEventListener('change', () => {state.dirty = true;});
refreshDataset();
resize();
requestAnimationFrame(animate);

// Small inspection interface for reproducible calculation and interaction QA.
window.AccountsFlow = {get model() {return model;}, get frames() {return frames;}, renderer, seek, play, pause, inspect: openPanel, getState: () => ({...state, ...current()})};
