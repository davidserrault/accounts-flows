// Allocate scrollable rows, while keeping the backing canvas viewport-sized.
export function diagramLayout(model, viewportHeight, radii = {}) {
  const rows = Math.ceil(model.expenses.length / 3);
  const radius = Math.max(radii.accounts || 0, radii.incomes || 0, radii.expenses || 0);
  const top = Math.max(64, radius + 28), bottom = radius + 56;
  const steps = {accounts: Math.max(model.accounts.length > 4 ? 160 : 128, 2 * (radii.accounts || 0) + 54),
    incomes: Math.max(140, 2 * (radii.incomes || 0) + 42),
    expenses: Math.max(80, 2 * (radii.expenses || 0) + 40)};
  const extent = (count, step) => Math.ceil(Math.max(viewportHeight, top + Math.max(0, count - 1) * step + bottom));
  const columns = {accounts: extent(model.accounts.length, steps.accounts),
    incomes: extent(model.incomes.length, steps.incomes), expenses: extent(rows, steps.expenses)};
  return {...columns, top, steps, height: Math.max(...Object.values(columns))};
}
export const diagramHeight = (model, viewportHeight) => diagramLayout(model, viewportHeight).height;

// Fill the viewport down to the fixed player; a small minimum keeps short
// screens scrollable rather than creating a zero-height canvas.
export const availableDiagramHeight = (diagramTop, playerTop) => Math.max(120, Math.floor(playerTop - diagramTop - 8));

// Keep both extrema per display pixel so even a brief overdraft survives
// compression. Day-end totals align with the timeline's day boundaries.
export function timelineBalanceChart(model, displayWidth, height = 44) {
  const width = Math.max(1, Math.floor(displayWidth) || 1);
  const length = model.days.length;
  let total = model.stats.opening, minimum = Math.min(0, total), maximum = Math.max(0, total);
  const first = {index: 0, cents: total};
  const bins = new Map();
  let last = first;
  for (const day of model.days) {
    total += day.income - day.expense;
    minimum = Math.min(minimum, total);maximum = Math.max(maximum, total);
    last = {index: day.index + 1, cents: total};
    const pixel = Math.min(width - 1, Math.floor(last.index / length * width));
    const bin = bins.get(pixel);
    if (!bin) bins.set(pixel, {min: last, max: last});
    else {
      if (total < bin.min.cents) bin.min = last;
      if (total > bin.max.cents) bin.max = last;
    }
  }
  const points = [first];
  for (const bin of bins.values()) {
    const extrema = [bin.min, bin.max].sort((a,b) => a.index - b.index);
    for (const point of extrema) if (point.index !== points.at(-1).index) points.push(point);
  }
  if (last.index !== points.at(-1).index) points.push(last);
  const hasNegative = minimum < 0;
  if (minimum === maximum) {minimum = -1;maximum = 1;}
  const y = cents => 3 + (maximum - cents) / (maximum - minimum) * (height - 6);
  const round = value => Number(value.toFixed(3));
  const zeroY = round(y(0));
  const line = points.map((point, i) => `${i ? 'L' : 'M'}${round(point.index / length * width)} ${round(y(point.cents))}`).join('');
  return {width, height, zeroY, points, minimum, maximum, hasNegative, line, area: `${line}L${width} ${zeroY}L0 ${zeroY}Z`};
}
