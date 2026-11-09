import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  hasPermission,
  PAYMENT_METHODS,
  type AgingReport,
  type BillingSummary,
  type Disbursement,
  type Invoice,
  type MatterCase,
  type Permission,
  type PaymentMethod,
  type PublicUser,
} from '@ahava88/shared';
import { api, apiErrorMessage } from '../api';

/** R 12 500.00, the same in every browser. */
export const rand = (value: number) => {
  const [whole, cents] = Math.abs(value).toFixed(2).split('.');
  return `${value < 0 ? '-' : ''}R ${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}.${cents}`;
};

const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  issued: 'Issued',
  partially_paid: 'Part paid',
  paid: 'Paid',
  void: 'Void',
};

const METHOD_LABEL: Record<PaymentMethod, string> = {
  eft: 'EFT',
  card: 'Card',
  cash: 'Cash',
  trust_transfer: 'From trust',
  other: 'Other',
};

const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg' }).format(new Date());

interface Props {
  currentUser: PublicUser;
  cases: MatterCase[];
  selectedCaseId?: string | null;
  onChanged?: () => unknown;
}

/** Invoices from work in progress, payments, disbursements, aging and statements. */
function BillingPanel({ currentUser, cases, selectedCaseId, onChanged }: Props) {
  const can = (permission: Permission) => hasPermission(currentUser.role, permission);
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [costs, setCosts] = useState<Disbursement[]>([]);
  const [aging, setAging] = useState<AgingReport | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [caseRef, setCaseRef] = useState(selectedCaseId ?? cases[0]?.id ?? '');
  const [subject, setSubject] = useState('');
  const [cost, setCost] = useState({
    description: '',
    amount: '',
    incurredOn: today(),
    vatable: true,
  });
  const [paying, setPaying] = useState<string | null>(null);
  const [payment, setPayment] = useState({
    amount: '',
    method: 'eft' as PaymentMethod,
    reference: '',
  });

  useEffect(() => {
    if (selectedCaseId) setCaseRef(selectedCaseId);
    else if (!caseRef && cases[0]) setCaseRef(cases[0].id);
  }, [selectedCaseId, cases, caseRef]);

  const load = useCallback(async () => {
    const tasks: Array<Promise<unknown>> = [
      api.get<BillingSummary>('/billing/summary').then(({ data }) => setSummary(data)),
      api.get<Invoice[]>('/billing/invoices').then(({ data }) => setInvoices(data)),
      api
        .get<Disbursement[]>('/billing/disbursements', { params: { status: 'unbilled' } })
        .then(({ data }) => setCosts(data)),
      api.get<AgingReport>('/billing/aging').then(({ data }) => setAging(data)),
    ];
    await Promise.all(tasks);
  }, [currentUser.role]);

  useEffect(() => {
    load().catch((err) => setError(apiErrorMessage(err, 'Billing could not be loaded.')));
  }, [load]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await action();
      await load();
      await onChanged?.();
    } catch (err) {
      setError(apiErrorMessage(err, 'That did not work.'));
    } finally {
      setBusy(false);
    }
  };

  const draftInvoice = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    run(async () => {
      await api.post('/billing/invoices', { caseRef, subject });
      setSubject('');
    });
  };

  const recordCost = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    run(async () => {
      await api.post('/billing/disbursements', { caseRef, ...cost });
      setCost({ description: '', amount: '', incurredOn: today(), vatable: true });
    });
  };

  const pay = (invoice: Invoice) => (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    run(async () => {
      await api.post(`/billing/invoices/${invoice.id}/payments`, payment);
      setPaying(null);
      setPayment({ amount: '', method: 'eft', reference: '' });
    });
  };

  return (
    <div className="billing-panel">
      {error ? <p className="field-hint notice-error">{error}</p> : null}
      {summary ? (
        <div className="mini-grid">
          <div className="stat">
            <span>Outstanding</span>
            <strong>{rand(summary.outstanding ?? 0)}</strong>
          </div>
          <div className="stat">
            <span>Overdue</span>
            <strong>{rand(summary.overdue ?? 0)}</strong>
          </div>
          <div className="stat">
            <span>Unbilled time</span>
            <strong>{rand(summary.wip ?? 0)}</strong>
          </div>
          <div className="stat">
            <span>Unbilled disbursements</span>
            <strong>{rand(summary.unbilledDisbursements ?? 0)}</strong>
          </div>
        </div>
      ) : null}

      {can('billing.write') ? (
        <>
          <select
            aria-label="Matter to bill"
            value={caseRef}
            onChange={(event) => setCaseRef(event.target.value)}
          >
            {cases.map((matter) => (
              <option key={matter.id} value={matter.id}>
                {matter.caseNumber}
                {matter.title ? ` · ${matter.title}` : ''}
              </option>
            ))}
          </select>
          <form className="inline-form" aria-label="Draft an invoice" onSubmit={draftInvoice}>
            <input
              aria-label="Invoice subject"
              placeholder="e.g. Professional services to 31 October"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
            />
            <button className="primary-button" disabled={busy || !caseRef || !subject.trim()}>
              Draft from unbilled work
            </button>
          </form>
          <form className="inline-form" aria-label="Record a disbursement" onSubmit={recordCost}>
            <input
              aria-label="Disbursement"
              placeholder="Disbursement (e.g. sheriff's fee)"
              value={cost.description}
              onChange={(event) => setCost({ ...cost, description: event.target.value })}
            />
            <input
              aria-label="Disbursement amount"
              inputMode="decimal"
              placeholder="Amount excl. VAT"
              value={cost.amount}
              onChange={(event) => setCost({ ...cost, amount: event.target.value })}
            />
            <input
              aria-label="Disbursement date"
              type="date"
              max={today()}
              value={cost.incurredOn}
              onChange={(event) => setCost({ ...cost, incurredOn: event.target.value })}
            />
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={cost.vatable}
                onChange={(event) => setCost({ ...cost, vatable: event.target.checked })}
              />
              VAT
            </label>
            <button
              className="secondary-button"
              disabled={busy || !caseRef || !cost.description.trim() || !cost.amount}
            >
              Add disbursement
            </button>
          </form>
        </>
      ) : null}

      {costs.length ? (
        <p className="field-hint">
          Unbilled disbursements:{' '}
          {costs
            .map((item) => `${item.caseNumber} ${item.description} ${rand(item.amount)}`)
            .join(' · ')}
        </p>
      ) : null}

      <h3>Invoices</h3>
      {invoices.length ? (
        <table className="time-table">
          <thead>
            <tr>
              <th>Number</th>
              <th>Matter</th>
              <th>Subject</th>
              <th>Total</th>
              <th>Owing</th>
              <th>Status</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {invoices.map((invoice) => {
              const open = invoice.status === 'issued' || invoice.status === 'partially_paid';
              const label = invoice.number ?? 'draft';
              return (
                <tr key={invoice.id}>
                  <td>{invoice.number ?? '—'}</td>
                  <td>{invoice.caseNumber}</td>
                  <td>{invoice.subject}</td>
                  <td>{rand(invoice.total)}</td>
                  <td>{open ? rand(invoice.balance) : ''}</td>
                  <td>
                    {STATUS_LABEL[invoice.status] ?? invoice.status}
                    {invoice.sentAt ? ' · sent' : ''}
                  </td>
                  <td className="row-actions">
                    <a
                      href={`/api/billing/invoices/${invoice.id}/pdf`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      PDF
                    </a>
                    {invoice.status === 'draft' && can('billing.write') ? (
                      <>
                        <button
                          type="button"
                          className="link-button"
                          disabled={busy}
                          onClick={() =>
                            run(() => api.post(`/billing/invoices/${invoice.id}/issue`))
                          }
                        >
                          Issue
                        </button>
                        <button
                          type="button"
                          className="link-button"
                          disabled={busy}
                          aria-label={`Delete draft on ${invoice.caseNumber}`}
                          onClick={() => run(() => api.delete(`/billing/invoices/${invoice.id}`))}
                        >
                          Delete
                        </button>
                      </>
                    ) : null}
                    {open && can('billing.write') ? (
                      <>
                        <button
                          type="button"
                          className="link-button"
                          disabled={busy}
                          onClick={() =>
                            run(() => api.post(`/billing/invoices/${invoice.id}/send`, {}))
                          }
                        >
                          Email
                        </button>
                        <button
                          type="button"
                          className="link-button"
                          disabled={busy}
                          onClick={() => {
                            setPaying(invoice.id);
                            setPayment({
                              amount: invoice.balance.toFixed(2),
                              method: 'eft',
                              reference: '',
                            });
                          }}
                        >
                          Payment
                        </button>
                      </>
                    ) : null}
                    {open && can('billing.void') && invoice.paid === 0 ? (
                      <button
                        type="button"
                        className="link-button"
                        disabled={busy}
                        aria-label={`Void ${label}`}
                        onClick={() => run(() => api.post(`/billing/invoices/${invoice.id}/void`))}
                      >
                        Void
                      </button>
                    ) : null}
                    {paying === invoice.id ? (
                      <form
                        className="inline-form"
                        aria-label={`Payment on ${label}`}
                        onSubmit={pay(invoice)}
                      >
                        <input
                          aria-label="Payment amount"
                          inputMode="decimal"
                          value={payment.amount}
                          onChange={(event) =>
                            setPayment({ ...payment, amount: event.target.value })
                          }
                        />
                        <select
                          aria-label="Payment method"
                          value={payment.method}
                          onChange={(event) =>
                            setPayment({ ...payment, method: event.target.value as PaymentMethod })
                          }
                        >
                          {PAYMENT_METHODS.map((method) => (
                            <option key={method} value={method}>
                              {METHOD_LABEL[method]}
                            </option>
                          ))}
                        </select>
                        <input
                          aria-label="Payment reference"
                          placeholder="Reference"
                          value={payment.reference}
                          onChange={(event) =>
                            setPayment({ ...payment, reference: event.target.value })
                          }
                        />
                        <button className="secondary-button" disabled={busy || !payment.amount}>
                          Record
                        </button>
                      </form>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p className="field-hint">No invoices yet.</p>
      )}

      {aging?.clients?.length ? (
        <>
          <h3>Aging (days past due)</h3>
          <table className="time-table">
            <thead>
              <tr>
                <th>Client</th>
                <th>Current</th>
                <th>30</th>
                <th>60</th>
                <th>90</th>
                <th>120+</th>
                <th>Total</th>
                <th aria-label="Statement" />
              </tr>
            </thead>
            <tbody>
              {aging.clients.map((row) => (
                <tr key={row.clientPartyId ?? row.clientLabel}>
                  <td>{row.clientLabel}</td>
                  <td>{rand(row.current)}</td>
                  <td>{rand(row.days30)}</td>
                  <td>{rand(row.days60)}</td>
                  <td>{rand(row.days90)}</td>
                  <td>{rand(row.days120)}</td>
                  <td>
                    <strong>{rand(row.total)}</strong>
                  </td>
                  <td>
                    {row.clientPartyId ? (
                      <a
                        href={`/api/billing/statements/${row.clientPartyId}/pdf`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Statement
                      </a>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}

      {can('users.manage') ? (
        <p className="field-hint">
          Invoice details (VAT number, address, bank account, terms and numbering) are in Account &
          team → Firm settings.
        </p>
      ) : null}
    </div>
  );
}

export default BillingPanel;
