export function overdraftHistory(opening = 1500, entries = [
  ['2026-01-24', -3500], ['2026-01-25', -525], ['2026-01-26', 1000],
  ['2026-01-26', 4000], ['2026-01-26', -1230]
]) {
  let balance = opening;
  const data = entries.map(([date, amountMinor], i) => {
    const balanceBeforeMinor = balance; balance += amountMinor;
    return {id: i + 1, accountKey: 'checking', accountId: 1, date, amountMinor,
      balanceBeforeMinor, balanceAfterMinor: balance, text: amountMinor > 0 ? 'Salary' : 'Payment',
      parsedData: {categoryLabel: amountMinor > 0 ? 'Income' : 'Shopping'}};
  });
  return {format: 'personia.account-history', version: 1,
    meta: {currency: 'EUR', startDate: '2026-01-24', endDate: '2026-02-02', persona: {name: 'Overdraft example'}},
    included: {accounts: [{key: 'checking', id: 1, name: 'Current account', type: 'checking', openingBalanceMinor: opening, closingBalanceMinor: balance}]}, data};
}
