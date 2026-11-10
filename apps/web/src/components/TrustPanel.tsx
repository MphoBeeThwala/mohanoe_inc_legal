import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  hasPermission,
  type MatterCase,
  type PublicUser,
  type TrustAccount,
  type TrustEntry,
  type TrustLedger,
  type TrustLedgerLine,
  type TrustReconciliation,
} from '@ahava88/shared';
import { api, apiErrorMessage } from '../api';
import { rand } from './BillingPanel';

const money = (cents: number) => rand(cents / 100);
const KIND_LABEL: Record<string, string> = {
  receipt: 'Receipt',
  payment: 'Payment',
  transfer_to_business: 'Fees to business',
  transfer_out: 'Transfer out',
  transfer_in: 'Transfer in',
  opening_balance: 'Opening balance',
  interest: 'Interest',
  reversal: 'Reversal',
};
type Action = 'receipt' | 'payment' | 'transfer' | 'fee';

/** Trust accounting: balances, entries, authorisations and reconciliation. */
function TrustPanel({ currentUser, cases }: { currentUser: PublicUser; cases: MatterCase[] }) {
  const canRecord = hasPermission(currentUser.role, 'trust.record');
  const canAuthorise = hasPermission(currentUser.role, 'trust.authorise');
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [accounts, setAccounts] = useState<TrustAccount[]>([]);
  const [accountId, setAccountId] = useState('');
  const [lines, setLines] = useState<TrustLedgerLine[]>([]);
  const [pending, setPending] = useState<TrustEntry[]>([]);
  const [ledger, setLedger] = useState<TrustLedger | null>(null);
  const [recs, setRecs] = useState<TrustReconciliation[]>([]);
  const [action, setAction] = useState<Action>('receipt');
  const [form, setForm] = useState({
    caseRef: '',
    toCaseRef: '',
    invoiceId: '',
    amount: '',
    reference: '',
    description: '',
  });
  const [rec, setRec] = useState({ periodEnd: '', bankBalance: '' });
  const [newAccount, setNewAccount] = useState({ name: '', bankName: '', accountNumber: '' });
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async (account?: string) => {
    const status = await api.get<{ enabled: boolean }>('/trust/status');
    setEnabled(status.data.enabled);
    if (!status.data.enabled) return;
    const [list, waiting] = await Promise.all([
      api.get<TrustAccount[]>('/trust/accounts'),
      api.get<TrustEntry[]>('/trust/pending'),
    ]);
    setAccounts(list.data);
    setPending(waiting.data);
    const chosen = account || list.data[0]?.id || '';
    setAccountId(chosen);
    if (chosen) {
      const [balances, history] = await Promise.all([
        api.get<TrustLedgerLine[]>(`/trust/accounts/${chosen}/balances`),
        api.get<TrustReconciliation[]>(`/trust/accounts/${chosen}/reconciliations`),
      ]);
      setLines(balances.data);
      setRecs(history.data);
    }
  }, []);

  useEffect(() => {
    load().catch((err) => setError(apiErrorMessage(err, 'Trust accounting could not be loaded.')));
  }, [load]);

  const run = async (fn: () => Promise<string | void>) => {
    setError('');
    setMessage('');
    try {
      const done = await fn();
      if (done) setMessage(done);
      await load(accountId);
    } catch (err) {
      setError(apiErrorMessage(err, 'That did not work.'));
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const path = {
      receipt: '/trust/receipts',
      payment: '/trust/payments',
      transfer: '/trust/transfers',
      fee: '/trust/fee-transfers',
    }[action];
    run(async () => {
      const { data } = await api.post<TrustEntry>(path, {
        accountId,
        caseRef: form.caseRef,
        amount: Number(form.amount),
        reference: form.reference,
        description: form.description,
        ...(action === 'transfer' ? { toCaseRef: form.toCaseRef } : {}),
        ...(action === 'fee' ? { invoiceId: form.invoiceId } : {}),
      });
      setForm({
        caseRef: form.caseRef,
        toCaseRef: '',
        invoiceId: '',
        amount: '',
        reference: '',
        description: '',
      });
      return data.status === 'posted'
        ? 'Receipt posted.'
        : 'Recorded: waiting for a practitioner to authorise it.';
    });
  };

  if (enabled === false) {
    return (
      <section className="panel" aria-label="Trust accounting">
        <h2>Trust accounting</h2>
        <p className="field-hint">
          Trust accounting is not enabled for this firm yet. Platform support can switch it on.
        </p>
      </section>
    );
  }

  const matterOptions = cases.map((c) => (
    <option key={c.id} value={c.id}>
      {c.caseNumber} {c.title ?? ''}
    </option>
  ));

  return (
    <section className="panel trust-panel" aria-label="Trust accounting">
      <div className="panel-head">
        <div>
          <p className="panel-kicker">Legal Practice Act s86</p>
          <h2>Trust accounting</h2>
        </div>
        {accounts.length ? (
          <select
            aria-label="Trust account"
            value={accountId}
            onChange={(e) => run(async () => load(e.target.value))}
          >
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name} (…{account.accountLast4}) — {money(account.balanceCents)}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      {message ? <p className="field-hint notice-success">{message}</p> : null}
      {error ? <p className="field-hint notice-error">{error}</p> : null}

      {!accounts.length && canAuthorise ? (
        <form
          className="research-form"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              await api.post('/trust/accounts', newAccount);
              return 'Trust account added.';
            });
          }}
        >
          <h3>Add the trust bank account</h3>
          <label>
            Name
            <input
              required
              value={newAccount.name}
              onChange={(e) => setNewAccount({ ...newAccount, name: e.target.value })}
            />
          </label>
          <label>
            Bank
            <input
              required
              value={newAccount.bankName}
              onChange={(e) => setNewAccount({ ...newAccount, bankName: e.target.value })}
            />
          </label>
          <label>
            Account number
            <input
              required
              value={newAccount.accountNumber}
              onChange={(e) => setNewAccount({ ...newAccount, accountNumber: e.target.value })}
            />
          </label>
          <button type="submit" className="primary-button">
            Add account
          </button>
        </form>
      ) : null}

      {pending.length ? (
        <div>
          <h3>Waiting for authorisation</h3>
          <ul className="trust-list">
            {pending.map((entry) => (
              <li key={entry.id}>
                <span>
                  {entry.caseNumber} · {KIND_LABEL[entry.kind]} ·{' '}
                  {money(Math.abs(entry.amountCents))} · {entry.description}
                </span>
                {canAuthorise ? (
                  <span className="button-row">
                    <button
                      type="button"
                      className="primary-button"
                      disabled={entry.requestedBy === currentUser.id}
                      title={
                        entry.requestedBy === currentUser.id
                          ? 'Someone else must authorise your request'
                          : undefined
                      }
                      onClick={() =>
                        run(async () => {
                          await api.post(`/trust/entries/${entry.id}/authorise`);
                          return 'Authorised and posted.';
                        })
                      }
                    >
                      Authorise
                    </button>
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => {
                        const reason = window.prompt('Why is it rejected?');
                        if (reason)
                          run(async () => {
                            await api.post(`/trust/entries/${entry.id}/reject`, { reason });
                            return 'Rejected.';
                          });
                      }}
                    >
                      Reject
                    </button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {accountId && canRecord ? (
        <form className="research-form" onSubmit={submit}>
          <h3>Record</h3>
          <div className="button-row" role="radiogroup" aria-label="Entry type">
            {(['receipt', 'payment', 'transfer', 'fee'] as Action[]).map((kind) => (
              <label key={kind} className="inline-check">
                <input
                  type="radio"
                  name="trust-action"
                  checked={action === kind}
                  onChange={() => setAction(kind)}
                />
                {
                  {
                    receipt: 'Receipt',
                    payment: 'Payment',
                    transfer: 'Transfer between matters',
                    fee: 'Fees to business',
                  }[kind]
                }
              </label>
            ))}
          </div>
          <label>
            {action === 'transfer' ? 'From matter' : 'Matter'}
            <select
              required
              value={form.caseRef}
              onChange={(e) => setForm({ ...form, caseRef: e.target.value })}
            >
              <option value="">Choose…</option>
              {matterOptions}
            </select>
          </label>
          {action === 'transfer' ? (
            <label>
              To matter
              <select
                required
                value={form.toCaseRef}
                onChange={(e) => setForm({ ...form, toCaseRef: e.target.value })}
              >
                <option value="">Choose…</option>
                {matterOptions}
              </select>
            </label>
          ) : null}
          {action === 'fee' ? (
            <label>
              Invoice (issued, on this matter)
              <input
                required
                placeholder="Invoice id"
                value={form.invoiceId}
                onChange={(e) => setForm({ ...form, invoiceId: e.target.value })}
              />
            </label>
          ) : null}
          <label>
            Amount (R)
            <input
              required
              type="number"
              min="0.01"
              step="0.01"
              value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
            />
          </label>
          <label>
            Bank reference
            <input
              value={form.reference}
              onChange={(e) => setForm({ ...form, reference: e.target.value })}
            />
          </label>
          {action !== 'fee' ? (
            <label>
              What it is for
              <input
                required
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </label>
          ) : null}
          <button type="submit" className="primary-button">
            {action === 'receipt' ? 'Post receipt' : 'Request (needs authorisation)'}
          </button>
        </form>
      ) : null}

      {accountId ? (
        <div>
          <h3>Client ledgers</h3>
          {lines.length ? (
            <table className="subscription-payments">
              <thead>
                <tr>
                  <th>Matter</th>
                  <th>Balance</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.caseId}>
                    <td>{line.caseNumber}</td>
                    <td>{money(line.balanceCents)}</td>
                    <td>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() =>
                          run(async () => {
                            setLedger(
                              (
                                await api.get<TrustLedger>(
                                  `/trust/accounts/${accountId}/ledger?matter=${line.caseId}`,
                                )
                              ).data,
                            );
                          })
                        }
                      >
                        Ledger
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="field-hint">No matter holds money in this account.</p>
          )}
        </div>
      ) : null}

      {ledger ? (
        <div>
          <h3>
            Ledger {ledger.caseNumber}: {money(ledger.balanceCents)}
          </h3>
          <table className="subscription-payments">
            <thead>
              <tr>
                <th>Date</th>
                <th>Entry</th>
                <th>Amount</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {ledger.entries.map((entry) => (
                <tr key={entry.id}>
                  <td>{entry.entryDate}</td>
                  <td>
                    {KIND_LABEL[entry.kind]}: {entry.description}
                    {entry.invoiceNumber ? ` (${entry.invoiceNumber})` : ''}
                  </td>
                  <td>{money(entry.amountCents)}</td>
                  <td>
                    {entry.reversedBy ? 'reversed' : entry.status}
                    {entry.clearedOn ? ` · cleared ${entry.clearedOn}` : ''}
                  </td>
                  <td>
                    {canRecord &&
                    entry.status === 'posted' &&
                    !entry.reversedBy &&
                    !entry.groupId &&
                    entry.kind !== 'reversal' &&
                    entry.kind !== 'transfer_to_business' ? (
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => {
                          const reason = window.prompt('Why is it being reversed?');
                          if (reason)
                            run(async () => {
                              await api.post(`/trust/entries/${entry.id}/reverse`, { reason });
                              return 'Reversal requested.';
                            });
                        }}
                      >
                        Reverse
                      </button>
                    ) : null}
                    {canRecord &&
                    entry.status === 'posted' &&
                    !entry.clearedOn &&
                    !entry.groupId ? (
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => {
                          const clearedOn = window.prompt(
                            'Date on the bank statement (YYYY-MM-DD)',
                          );
                          if (clearedOn)
                            run(async () => {
                              await api.post('/trust/clear', { entryIds: [entry.id], clearedOn });
                              return 'Marked as cleared.';
                            });
                        }}
                      >
                        Cleared
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {accountId ? (
        <div>
          <h3>Reconciliation</h3>
          {canRecord ? (
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                run(async () => {
                  const { data } = await api.post<TrustReconciliation>(
                    `/trust/accounts/${accountId}/reconciliations`,
                    {
                      periodEnd: rec.periodEnd,
                      bankBalance: Number(rec.bankBalance),
                    },
                  );
                  return data.balanced
                    ? 'Reconciliation balances.'
                    : 'Reconciliation prepared: there is a difference to explain.';
                });
              }}
            >
              <label>
                Statement date
                <input
                  type="date"
                  required
                  value={rec.periodEnd}
                  onChange={(e) => setRec({ ...rec, periodEnd: e.target.value })}
                />
              </label>
              <label>
                Closing bank balance (R)
                <input
                  type="number"
                  step="0.01"
                  required
                  value={rec.bankBalance}
                  onChange={(e) => setRec({ ...rec, bankBalance: e.target.value })}
                />
              </label>
              <button type="submit" className="secondary-button">
                Reconcile
              </button>
            </form>
          ) : null}
          <ul className="trust-list">
            {recs.map((r) => (
              <li key={r.id}>
                <span>
                  {r.periodEnd}: bank {money(r.bankBalanceCents)} · cash book{' '}
                  {money(r.cashbookCents)} · ledgers {money(r.ledgerTotalCents)} · uncleared +
                  {money(r.unclearedReceiptsCents)} / −{money(r.unclearedPaymentsCents)} ·{' '}
                  <strong>
                    {r.balanced
                      ? 'balanced'
                      : `difference ${money(r.differenceCents)}${r.debitLedgers ? `, ${r.debitLedgers} ledgers in debit` : ''}`}
                  </strong>
                  {r.signedOffAt ? ' · signed off' : ''}
                </span>
                {canAuthorise && !r.signedOffAt ? (
                  <button
                    type="button"
                    className="link-button"
                    disabled={r.preparedBy === currentUser.id}
                    onClick={() => {
                      const notes = r.balanced
                        ? ''
                        : (window.prompt('Explain the difference') ?? '');
                      run(async () => {
                        await api.post(`/trust/reconciliations/${r.id}/sign-off`, { notes });
                        return 'Signed off.';
                      });
                    }}
                  >
                    Sign off
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          {canAuthorise ? (
            <a
              className="link-button"
              href={`/api/trust/accounts/${accountId}/cashbook.csv?from=2000-01-01&to=2100-12-31`}
            >
              Download cash book (CSV) for the auditor
            </a>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export default TrustPanel;
