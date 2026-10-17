// The rare payments are deliberately larger than the frequent payments.
export function frequencyFixture() {
  const accounts = ['a', 'b', 'c'].map(id => ({id, name: `Account ${id}`, type: 'checking', bank: 'Test Bank', opening: 0, closing: 0}));
  const balances = {a: 0, b: 0, c: 0}, transactions = [];
  const add = (date, account, cents, label, category = label) => {
    const before = balances[account]; balances[account] += cents;
    transactions.push({id: transactions.length + 1, date, account, cents, before, after: balances[account], label, category});
  };
  add('2026-01-31', 'a', 100000, 'Annual bonus');
  for (const day of [2, 3, 4]) add(`2026-02-0${day}`, 'b', 1000, 'Regular income');
  add('2026-02-05', 'b', -1000, 'Rare payment', 'Rare category');
  for (const day of [6, 7, 8]) add(`2026-02-0${day}`, 'b', -100, 'Frequent payment', 'Frequent category');
  for (const a of accounts) a.closing = balances[a.id];
  return {meta: {start: '2026-01-31', end: '2026-03-01', subject: 'Test'}, accounts, transactions};
}
