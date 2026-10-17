// Small synthetic export in the exact format of the original PersonAI file.
export function historyFixture() {
  const account = (key, id, name, type, opening, closing) => ({key, id, name, type, bank:'Example Bank', currency:'EUR', currencyDigits:2, holders:[{name:'Alex'}], openingBalance:opening/100, openingBalanceMinor:opening, closingBalance:closing/100, closingBalanceMinor:closing});
  const operation = (id, accountKey, accountId, day, cents, before, text, categoryLabel, transfer) => ({id, accountKey, accountId, date:`${day}T00:00:00`, currency:'EUR', amount:cents/100, amountMinor:cents, balanceBefore:before/100, balanceBeforeMinor:before, balanceAfter:(before+cents)/100, balanceAfterMinor:before+cents, text, parsedData:{categoryLabel, simulationKind:transfer?'internal-transfer':cents>0?'income':'expense', ...(transfer?{transferId:'transfer_1'}:{})}, ...(transfer?{counterparty:{accountKey:transfer.key,accountId:transfer.id},counterpartyAccountIdentifier:String(transfer.id)}:{})});
  return {
    format:'personia.account-history', version:1,
    meta:{persona:{name:'Alex'},currency:'EUR',currencyDigits:2,startDate:'2026-01-31',endDate:'2026-02-01',transactionOrder:'reverse-chronological',count:4},
    included:{accounts:[account('checking_alex',7,'Everyday account','checking',10000,10500),account('saving_alex',9,'Rainy day','savings',5000,7000)],merchants:[]},
    data:[
      operation(4,'checking_alex',7,'2026-02-01',3000,7500,'Salary','Salary'),
      operation(3,'saving_alex',9,'2026-01-31',2000,5000,'Transfer received','Transfers',{key:'checking_alex',id:7}),
      operation(2,'checking_alex',7,'2026-01-31',-2000,9500,'Transfer sent','Transfers',{key:'saving_alex',id:9}),
      operation(1,'checking_alex',7,'2026-01-31',-500,10000,'Coffee','Restaurants')
    ]
  };
}
