// Repayment removes equal amounts of cash and liability only after both have
// reached the account. Expense particles keep their original funding colour.
export function creditAccount(packet, node, wallets, debts, ensure, ready) {
  const cash = ensure(packet, node);
  while (packet.cents > 0 && debts[node].length) {
    const debt = debts[node][0], liability = ensure(debt, node);
    const repaid = Math.min(packet.cents, -debt.cents);
    const at = Math.max(ready(cash), ready(liability)) + .008;
    packet.cents -= repaid;
    debt.cents += repaid;
    if (packet.cents) cash.weights.push({at, cents: packet.cents});
    else cash.died = at;
    if (debt.cents) liability.weights.push({at, cents: debt.cents});
    else {liability.died = at; debts[node].shift();}
  }
  if (packet.cents > 0) wallets[node].push(packet);
}

// Recombining by colour prevents a fractional red payment from being mixed
// into a white particle (or disappearing before the month's expenses reset).
export function colourPools(pool) {
  return [pool.filter(t => !t.overdraft), pool.filter(t => t.overdraft)];
}
