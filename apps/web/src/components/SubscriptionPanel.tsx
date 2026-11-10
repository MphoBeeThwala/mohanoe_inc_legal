import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  subscriptionPriceCents,
  type PlatformInvoice,
  type SubscriptionCheckout,
  type SubscriptionInterval,
  type SubscriptionPlan,
  type SubscriptionStatus,
} from '@ahava88/shared';
import { api, apiErrorMessage } from '../api';
import { rand } from './BillingPanel';

const money = (cents: number) => rand(cents / 100);
const day = (value: string | null) =>
  value
    ? new Date(value).toLocaleDateString('en-ZA', {
        timeZone: 'Africa/Johannesburg',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      })
    : '';

const STATE_LABEL: Record<SubscriptionStatus['effectiveStatus'], string> = {
  trialing: 'Trial',
  active: 'Active',
  past_due: 'Payment overdue',
  cancelled: 'Cancelled',
  suspended: 'Read-only (unpaid)',
  complimentary: 'Complimentary',
};

/** Sends the browser to PayFast with the signed form (PayFast takes the payment details). */
export function submitToPayFast(checkout: SubscriptionCheckout): void {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = checkout.action;
  for (const [name, value] of checkout.fields) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
}

/** The firm's subscription: status, choosing a plan, seats, cancelling (administrators). */
function SubscriptionPanel({
  onCheckout = submitToPayFast,
}: {
  onCheckout?: (checkout: SubscriptionCheckout) => void;
}) {
  const [status, setStatus] = useState<SubscriptionStatus | null>(null);
  const [plans, setPlans] = useState<SubscriptionPlan[]>([]);
  const [planCode, setPlanCode] = useState('');
  const [interval, setInterval] = useState<SubscriptionInterval>('monthly');
  const [seats, setSeats] = useState(1);
  const [seatChange, setSeatChange] = useState(1);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [invoices, setInvoices] = useState<PlatformInvoice[]>([]);

  const load = useCallback(async () => {
    const [current, available] = await Promise.all([
      api.get<SubscriptionStatus>('/subscription'),
      api.get<SubscriptionPlan[]>('/subscription/plans'),
    ]);
    setStatus(current.data);
    setPlans(available.data);
    // Invoices are a nicety here: a failure must not hide the subscription.
    api
      .get<PlatformInvoice[]>('/subscription/invoices')
      .then(({ data }) => setInvoices(data))
      .catch(() => setInvoices([]));
    setPlanCode((code) => code || current.data.planCode || available.data[0]?.code || '');
    // New subscriptions start at the seats already in use (a trial's allowance isn't a choice).
    setSeats(
      Math.max(current.data.seatsUsed, current.data.planCode ? (current.data.seats ?? 1) : 1, 1),
    );
    setSeatChange(current.data.seats ?? current.data.seatsUsed);
  }, []);

  useEffect(() => {
    load().catch((err) => setError(apiErrorMessage(err, 'The subscription could not be loaded.')));
  }, [load]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (err) {
      setError(apiErrorMessage(err, 'That did not work.'));
    } finally {
      setBusy(false);
    }
  };

  if (!status) {
    return (
      <section className="panel subscription-panel" aria-label="Subscription">
        <h2>Subscription</h2>
        {error ? <p className="field-hint notice-error">{error}</p> : <p>Loading…</p>}
      </section>
    );
  }

  const plan = plans.find((item) => item.code === planCode);
  const total = plan ? subscriptionPriceCents(plan, interval, seats, status.vatRate) : 0;
  const hasAgreement = status.state === 'active' || status.state === 'past_due';
  const vatLabel = status.vatRate > 0 ? `incl. ${Math.round(status.vatRate * 100)}% VAT` : '';

  const subscribe = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    run(async () => {
      const { data } = await api.post<SubscriptionCheckout>('/subscription/checkout', {
        planCode,
        interval,
        seats,
      });
      onCheckout(data);
    });
  };

  const updateSeats = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    run(async () => {
      setStatus(
        (await api.patch<SubscriptionStatus>('/subscription/seats', { seats: seatChange })).data,
      );
    });
  };

  const cancel = () => {
    if (
      !window.confirm('Cancel the subscription? Access continues until the end of the paid period.')
    ) {
      return;
    }
    run(async () => {
      setStatus((await api.post<SubscriptionStatus>('/subscription/cancel')).data);
    });
  };

  return (
    <section id="subscription" className="panel subscription-panel" aria-label="Subscription">
      <div className="panel-head">
        <div>
          <p className="panel-kicker">Firm</p>
          <h2>Subscription</h2>
        </div>
        <span className={`status-pill status-${status.effectiveStatus}`}>
          {STATE_LABEL[status.effectiveStatus]}
        </span>
      </div>
      {error ? <p className="field-hint notice-error">{error}</p> : null}

      <dl className="subscription-facts">
        {status.planName ? (
          <>
            <dt>Plan</dt>
            <dd>
              {status.planName}
              {status.interval
                ? ` · billed ${status.interval === 'annual' ? 'yearly' : 'monthly'}`
                : ''}
            </dd>
          </>
        ) : null}
        <dt>Seats</dt>
        <dd>
          {status.seatsUsed} in use{status.seats !== null ? ` of ${status.seats}` : ''}
        </dd>
        {status.paidThrough ? (
          <>
            <dt>{status.effectiveStatus === 'trialing' ? 'Trial ends' : 'Paid until'}</dt>
            <dd>{day(status.paidThrough)}</dd>
          </>
        ) : null}
        {status.recurringAmountCents !== null && hasAgreement ? (
          <>
            <dt>Each period</dt>
            <dd>
              {money(status.recurringAmountCents)} {vatLabel}
            </dd>
          </>
        ) : null}
      </dl>
      {status.pendingCheckout && !hasAgreement ? (
        <p className="field-hint notice-info">
          A payment was started. It shows here as soon as PayFast confirms it (usually within a
          minute).
        </p>
      ) : null}

      {hasAgreement ? (
        <form className="inline-form" onSubmit={updateSeats}>
          <label>
            Seats
            <input
              type="number"
              min={Math.max(status.seatsUsed, 1)}
              value={seatChange}
              onChange={(event) => setSeatChange(Number(event.target.value))}
            />
          </label>
          <button type="submit" className="secondary-button" disabled={busy}>
            Change seats
          </button>
          <p className="field-hint">
            New seats can be used at once; the new amount is charged from the next billing date.
          </p>
          <button type="button" className="link-button" onClick={cancel} disabled={busy}>
            Cancel subscription
          </button>
        </form>
      ) : !status.onlinePayments ? (
        <p className="field-hint">
          Online payment is not available yet. Please contact platform support to subscribe.
        </p>
      ) : plans.length === 0 ? (
        <p className="field-hint">No plans are available yet. Please contact platform support.</p>
      ) : (
        <form className="subscribe-form" onSubmit={subscribe}>
          <fieldset className="plan-options">
            <legend>Plan</legend>
            {plans.map((item) => (
              <label key={item.code} className="plan-option">
                <input
                  type="radio"
                  name="plan"
                  value={item.code}
                  checked={planCode === item.code}
                  onChange={() => setPlanCode(item.code)}
                />
                <strong>{item.name}</strong>
                <span>
                  {money(item.monthlySeatPriceCents)} per seat a month, or{' '}
                  {money(item.annualSeatPriceCents)} a year (excl. VAT)
                </span>
                {item.description ? <span className="field-hint">{item.description}</span> : null}
              </label>
            ))}
          </fieldset>
          <label>
            Billing
            <select
              value={interval}
              onChange={(event) => setInterval(event.target.value as SubscriptionInterval)}
            >
              <option value="monthly">Monthly</option>
              <option value="annual">Yearly</option>
            </select>
          </label>
          <label>
            Seats
            <input
              type="number"
              min={Math.max(status.seatsUsed, plan?.minSeats ?? 1)}
              max={plan?.maxSeats ?? undefined}
              value={seats}
              onChange={(event) => setSeats(Number(event.target.value))}
            />
          </label>
          <p className="subscription-total">
            {money(total)} {interval === 'annual' ? 'a year' : 'a month'} {vatLabel}
          </p>
          <button type="submit" className="primary-button" disabled={busy || !plan}>
            Continue to PayFast
          </button>
          <p className="field-hint">
            You are charged today and then {interval === 'annual' ? 'every year' : 'every month'}{' '}
            until you cancel.{' '}
            {status.effectiveStatus === 'trialing' ? 'Subscribing ends the trial. ' : ''}
            PayFast handles the card or EFT details.
          </p>
        </form>
      )}

      {status.payments.length ? (
        <table className="subscription-payments">
          <caption>Payments</caption>
          <thead>
            <tr>
              <th>Date</th>
              <th>Amount</th>
              <th>Reference</th>
            </tr>
          </thead>
          <tbody>
            {status.payments.map((payment) => (
              <tr key={payment.id}>
                <td>{day(payment.paidAt)}</td>
                <td>
                  {money(payment.amountCents)}
                  {payment.status !== 'complete' ? ` (${payment.status})` : ''}
                </td>
                <td>{payment.reference}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {invoices.length ? (
        <table className="subscription-payments">
          <caption>Invoices</caption>
          <thead>
            <tr>
              <th>Invoice</th>
              <th>Date</th>
              <th>Total</th>
              <th>VAT</th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((invoice) => (
              <tr key={invoice.id}>
                <td>
                  <a
                    href={`/api/subscription/invoices/${invoice.id}/pdf`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {invoice.taxInvoice ? 'Tax invoice' : 'Invoice'} {invoice.number}
                  </a>
                </td>
                <td>{day(invoice.issuedAt)}</td>
                <td>{money(invoice.totalCents)}</td>
                <td>{invoice.taxInvoice ? money(invoice.vatCents) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

export default SubscriptionPanel;
