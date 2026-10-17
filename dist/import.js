import {validateLedger} from './model.js';

const fail = message => {throw new Error(message);};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const name = (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback;
const validId = value => (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) && Number.isSafeInteger(Number(value)) && Number(value) >= 0;
function date(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(value)) fail(`${field} must be an ISO date.`);
  const key = value.slice(0, 10), parsed = new Date(`${key}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== key) fail(`${field} is not a valid date.`);
  return key;
}
function minor(record, minorKey, majorKey, field) {
  const value = record[minorKey] ?? (typeof record[majorKey] === 'number' ? Math.round(record[majorKey] * 100) : undefined);
  if (!Number.isSafeInteger(value)) fail(`${field} must be a monetary amount in euros or integer cents.`);
  if (record[minorKey] !== undefined && record[majorKey] !== undefined && (typeof record[majorKey] !== 'number' || Math.round(record[majorKey] * 100) !== value)) fail(`${field} has inconsistent euro and cent values.`);
  return value;
}

export function parseHistory(source) {
  let raw;
  try {raw = JSON.parse(source.replace(/^\uFEFF/, ''));} catch {fail('This file is not valid JSON. Choose a PersonAI account-history export.');}
  if (!object(raw) || raw.format !== 'personia.account-history' || raw.version !== 1 || !Array.isArray(raw.data) || !Array.isArray(raw.included?.accounts) || !object(raw.meta)) fail('Unsupported format. Choose a PersonAI account-history JSON export (version 1).');
  if (!raw.included.accounts.length) fail('The file does not contain any accounts.');
  if (raw.meta.currency !== 'EUR' || (raw.meta.currencyDigits ?? 2) !== 2) fail('Only EUR account histories are supported.');
  const start = date(raw.meta.startDate, 'Start date'), end = date(raw.meta.endDate, 'End date');
  if (start > end) fail('The start date must be before the end date.');
  const byKey = new Map(), byId = new Map();
  const accounts = raw.included.accounts.map((a, i) => {
    if (!object(a) || typeof a.key !== 'string' || !a.key || !validId(a.id) || byKey.has(a.key) || byId.has(String(Number(a.id)))) fail('Every account must have a unique key and ID.');
    if ((a.currency ?? 'EUR') !== 'EUR' || (a.currencyDigits ?? 2) !== 2) fail('All accounts must use EUR.');
    const opening = minor(a, 'openingBalanceMinor', 'openingBalance', `Initial balance for account ${a.key}`);
    const closing = minor(a, 'closingBalanceMinor', 'closingBalance', `Closing balance for account ${a.key}`);
    const id = `account-${i}`;byKey.set(a.key, id);byId.set(String(Number(a.id)), id);
    return {id, name: name(a.name, `Account ${i + 1}`), originalName: name(a.name, `Account ${i + 1}`), type: name(a.type, 'checking'), bank: name(a.bank, 'Bank'), opening, closing};
  });
  function resolveAccount(key, id) {
    const fromKey = byKey.get(key), fromId = validId(id) ? byId.get(String(Number(id))) : undefined;
    if ((key !== undefined && !fromKey) || (id !== undefined && !fromId) || (fromKey && fromId && fromKey !== fromId)) return undefined;
    return fromKey ?? fromId;
  }
  const ids = new Set();
  const transactions = raw.data.map(t => {
    if (!object(t) || !validId(t.id) || ids.has(String(Number(t.id)))) fail('Every operation must have a unique numeric ID.');
    ids.add(String(Number(t.id)));
    const account = resolveAccount(t.accountKey, t.accountId);
    if (!account) fail(`Operation ${t.id} refers to an unknown or inconsistent account.`);
    if ((t.currency ?? 'EUR') !== 'EUR') fail(`Operation ${t.id} must use EUR.`);
    const cents = minor(t, 'amountMinor', 'amount', `Amount for operation ${t.id}`);
    const before = minor(t, 'balanceBeforeMinor', 'balanceBefore', `Previous balance for operation ${t.id}`);
    const after = minor(t, 'balanceAfterMinor', 'balanceAfter', `New balance for operation ${t.id}`);
    const key = date(t.date, `Date for operation ${t.id}`);
    if (key < start || key > end) fail(`Operation ${t.id} is outside the history period.`);
    const transferId = t.parsedData?.transferId;
    if (t.parsedData?.simulationKind === 'internal-transfer' && !transferId) fail(`Internal transfer ${t.id} is missing its transfer ID.`);
    let target;
    if (transferId) {
      if (!validId(transferId) && (typeof transferId !== 'string' || !transferId.trim())) fail(`Internal transfer ${t.id} has an invalid transfer ID.`);
      target = resolveAccount(t.counterparty?.accountKey, t.counterparty?.accountId ?? t.counterpartyAccountIdentifier);
      if (!target || target === account) fail(`Internal transfer ${t.id} is missing its other account. Export all related accounts.`);
    }
    return {id: String(Number(t.id)), account, cents, date: key, label: name(t.text, name(t.parsedData?.originalText, 'Operation')), category: name(t.parsedData?.categoryLabel, cents > 0 ? 'Income' : 'Other spending'), before, after, ...(transferId ? {transferId: String(transferId), target} : {})};
  });
  const holder = name(raw.meta.persona?.name, name(raw.included.accounts[0].holders?.[0]?.name, 'Imported history'));
  const data = {meta: {subject: holder, synthetic: raw.meta.synthetic === true, start, end, currency: 'EUR'}, accounts, transactions};
  try {validateLedger(data);} catch (error) {
    if (/Unmatched internal transfer/.test(error.message)) fail('An internal transfer is incomplete or inconsistent. Export all related accounts for the same period.');
    if (/Balance mismatch|Closing balance mismatch|reconciliation/.test(error.message)) fail(`Account balances do not reconcile with the operations (${error.message}).`);
    fail(error.message);
  }
  return data;
}
