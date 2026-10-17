export const UNIT = 1000; // One full particle is €10, in integer cents.

const sum = (items, value = x => x) => items.reduce((a, x) => a + value(x), 0);
const slug = text => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const dayKeys = (start, end) => {
  const result = [];
  const d = new Date(`${start}T00:00:00Z`);
  const endAt = Date.parse(`${end}T00:00:00Z`);
  while (d.getTime() <= endAt) {
    result.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return result;
};

function aggregate(items, key, factory) {
  const grouped = new Map();
  for (const item of items) {
    const id = key(item);
    if (!grouped.has(id)) grouped.set(id, {...factory(item), cents: 0, count: 0, transactions: []});
    const group = grouped.get(id);
    group.cents += Math.abs(item.cents);
    group.count++;
    group.transactions.push(item);
  }
  return [...grouped.values()];
}

const orderedTransactions = transactions => [...transactions].sort((a, b) => a.date.localeCompare(b.date) || Number(a.id) - Number(b.id));
const byFrequency = (a, b) => b.count - a.count || a.name.localeCompare(b.name);
export function validateLedger(data, transactions = orderedTransactions(data.transactions)) {
  const accounts = data.accounts;
  const accountMap = new Map(accounts.map(a => [a.id, a]));
  const pairs = new Map();
  const balances = Object.fromEntries(accounts.map(a => [a.id, a.opening]));
  for (const t of transactions) {
    if (!accountMap.has(t.account) || !Number.isSafeInteger(t.cents)) throw new Error('Invalid transaction');
    if (balances[t.account] !== t.before || t.after !== t.before + t.cents) throw new Error(`Balance mismatch: ${t.id}`);
    balances[t.account] = t.after;
    if (t.transferId) {
      if (!pairs.has(t.transferId)) pairs.set(t.transferId, []);
      pairs.get(t.transferId).push(t);
    }
  }
  for (const [id, pair] of pairs) {
    const debit = pair.find(t => t.cents < 0);
    const credit = pair.find(t => t.cents > 0);
    if (pair.length !== 2 || !debit || !credit || debit.cents + credit.cents !== 0 || debit.target !== credit.account || credit.target !== debit.account || debit.date !== credit.date) {
      throw new Error(`Unmatched internal transfer: ${id}`);
    }
  }
  for (const a of accounts) if (balances[a.id] !== a.closing) throw new Error(`Closing balance mismatch: ${a.id}`);
  const net = sum(transactions.filter(t => !t.transferId), t => t.cents);
  if (sum(accounts, a => a.opening) + net !== sum(accounts, a => a.closing)) throw new Error('Total reconciliation failed');
  return pairs.size;
}

export function buildModel(data) {
  const accounts = data.accounts.map(a => ({...a, node: a.id}));
  const accountMap = new Map(accounts.map(a => [a.id, a]));
  const transactions = orderedTransactions(data.transactions);
  const transferCount = validateLedger(data, transactions);
  const accountCounts = new Map(accounts.map(a => [a.id, 0]));
  for (const t of transactions) accountCounts.set(t.account, accountCounts.get(t.account) + 1);
  for (const account of accounts) account.count = accountCounts.get(account.id);
  accounts.sort(byFrequency);
  const incomeEntries = transactions.filter(t => !t.transferId && t.cents > 0);
  const expenseEntries = transactions.filter(t => !t.transferId && t.cents < 0);
  const incomes = aggregate(incomeEntries, t => t.label, t => ({id: `income-${slug(t.label)}`, name: t.label, kind: 'income'})).sort(byFrequency);
  const expenses = aggregate(expenseEntries, t => t.category, t => ({id: `expense-${slug(t.category)}`, name: t.category, kind: 'expense'})).sort(byFrequency);
  // Imported labels can share an ASCII slug (or have no Latin characters).
  // Keep node IDs distinct without changing the built-in dataset's IDs.
  for (const nodes of [incomes, expenses]) {
    const used = new Set();
    for (const node of nodes) {
      const base = node.id;
      let suffix = 2;
      while (used.has(node.id)) node.id = `${base}-${suffix++}`;
      used.add(node.id);
    }
  }
  const incomeId = new Map(incomes.map(n => [n.name, n.id]));
  const expenseId = new Map(expenses.map(n => [n.name, n.id]));
  const incomeByName = new Map(incomes.map(n => [n.name, n]));
  const monthSources = new Map();
  for (const t of incomeEntries) {
    const month = t.date.slice(0, 7);
    if (!monthSources.has(month)) monthSources.set(month, new Set());
    monthSources.get(month).add(incomeByName.get(t.label));
  }
  const monthlyIncomes = new Map([...monthSources].map(([month, sources]) => [month, [...sources].sort(byFrequency)]));
  let rolling = Object.fromEntries(accounts.map(a => [a.id, a.opening]));
  const entriesByDay = new Map();
  for (const t of transactions) {
    if (!entriesByDay.has(t.date)) entriesByDay.set(t.date, []);
    entriesByDay.get(t.date).push(t);
  }
  let spending = Object.fromEntries(expenses.map(n => [n.id, 0]));
  let incomeAmounts = Object.fromEntries(incomes.map(n => [n.id, 0]));
  const zeroAccounts = Object.fromEntries(accounts.map(a => [a.id, 0]));
  const zeroNodes = Object.fromEntries([...incomes, ...expenses].map(n => [n.id, 0]));
  const empty = [];
  let monthKey = null, monthStartIndex = 0;
  const days = dayKeys(data.meta.start, data.meta.end).map((key, index) => {
    const monthStart = key.slice(0, 7) !== monthKey;
    if (monthStart) {
      monthKey = key.slice(0, 7);
      monthStartIndex = index;
      spending = Object.fromEntries(expenses.map(n => [n.id, 0]));
      incomeAmounts = Object.fromEntries(incomes.map(n => [n.id, 0]));
    }
    const spendingOpening = spending;
    const incomeOpening = incomeAmounts;
    const tomorrow = new Date(`${key}T00:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const monthEnd = tomorrow.toISOString().slice(0, 7) !== monthKey;
    const entries = entriesByDay.get(key) || empty;
    const opening = rolling;
    const incomeFlows = entries.length ? aggregate(entries.filter(t => !t.transferId && t.cents > 0), t => `${t.label}|${t.account}`, t => ({kind: 'income', from: incomeId.get(t.label), to: t.account})) : empty;
    const expenseFlows = entries.length ? aggregate(entries.filter(t => !t.transferId && t.cents < 0), t => `${t.account}|${t.category}`, t => ({kind: 'expense', from: t.account, to: expenseId.get(t.category)})) : empty;
    const transferFlows = entries.length ? entries.filter(t => t.transferId && t.cents < 0).map(t => ({kind: 'transfer', from: t.account, to: t.target, cents: -t.cents, count: 1, id: t.transferId, transactions: [t]})) : empty;
    if (entries.length) rolling = {...rolling};
    for (const t of entries) rolling[t.account] += t.cents;
    const closing = rolling;
    const nodeAmounts = entries.length ? {...zeroNodes} : zeroNodes;
    if (incomeFlows.length) incomeAmounts = {...incomeAmounts};
    for (const f of incomeFlows) {
      nodeAmounts[f.from] += f.cents;
      incomeAmounts[f.from] += f.cents;
    }
    const incomeClosing = incomeAmounts;
    if (expenseFlows.length) spending = {...spending};
    for (const f of expenseFlows) {
      nodeAmounts[f.to] += f.cents;
      spending[f.to] += f.cents;
    }
    const spendingClosing = spending;
    const received = entries.length ? {...zeroAccounts} : zeroAccounts;
    const paid = entries.length ? {...zeroAccounts} : zeroAccounts;
    for (const t of entries) {
      if (t.cents > 0) received[t.account] += t.cents;
      else paid[t.account] -= t.cents;
    }
    return {key, index, monthKey, monthStartIndex, monthStart, monthEnd, incomeOpening, incomeClosing, spendingOpening, spendingClosing, entries, opening, closing, received, paid, nodeAmounts, incomeFlows, expenseFlows, transferFlows, income: sum(incomeFlows, f => f.cents), expense: sum(expenseFlows, f => f.cents), transferred: sum(transferFlows, f => f.cents)};
  });
  const income = sum(incomeEntries, t => t.cents);
  const expense = -sum(expenseEntries, t => t.cents);
  const opening = sum(accounts, a => a.opening);
  const closing = sum(accounts, a => a.closing);
  const monthCount = new Set(days.map(day => day.monthKey)).size;
  if (opening + income - expense !== closing) throw new Error('Total reconciliation failed');
  return {
    meta: data.meta, accounts, accountMap, transactions, incomes, monthlyIncomes, expenses, days, activityDays: days.filter(d => d.entries.length),
    nodes: [...incomes, ...accounts.map(a => ({...a, kind: 'account'})), ...expenses],
    stats: {income, expense, opening, closing, net: income - expense, transactionCount: transactions.length, incomeCount: incomeEntries.length, expenseCount: expenseEntries.length, transferCount, dayCount: days.length, monthCount, monthlyIncome: income / monthCount, monthlyExpense: expense ? expense / monthCount : 0, dailyIncome: income / days.length, dailyExpense: expense / days.length, averageCredit: incomeEntries.length ? income / incomeEntries.length : 0, averagePayment: expenseEntries.length ? expense / expenseEntries.length : 0}
  };
}

export function cursorState(cursor, length) {
  const value = Math.max(0, Math.min(length, Number(cursor) || 0));
  const index = Math.min(length - 1, Math.floor(value));
  return {index, progress: value === length ? 1 : value - index, cursor: value};
}

const moneyFormats = new Map();
export const money = (cents, decimals = 0) => {
  if (!moneyFormats.has(decimals)) moneyFormats.set(decimals, new Intl.NumberFormat('en-IE', {style: 'currency', currency: 'EUR', maximumFractionDigits: decimals, minimumFractionDigits: decimals}));
  return moneyFormats.get(decimals).format(cents / 100);
};
export const balanceMoney = cents => cents > 0 && cents < 1 ? '< €0.01' : money(cents, 2);
export const dateLabel = value => new Date(`${value}T00:00:00Z`).toLocaleDateString('en-GB', {day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'});
