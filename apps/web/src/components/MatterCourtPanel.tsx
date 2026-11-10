import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  type CourtOnlineStatus,
  COURT_DIVISIONS,
  PRESCRIPTION_RULES,
  type MatterCase,
  type Prescription,
  type PrescriptionRuleCode,
} from '@ahava88/shared';
import { api, apiErrorMessage } from '../api';
import { localDate } from '../lib/dates';

interface Props {
  matter: MatterCase;
  canEditMatter: boolean;
  canEditCalendar: boolean;
  onChanged?: () => unknown;
}

const STATUS_LABEL = { running: 'Running', interrupted: 'Interrupted', closed: 'Closed' } as const;

/** A matter's court and case number, and its prescription periods. */
function MatterCourtPanel({ matter, canEditMatter, canEditCalendar, onChanged }: Props) {
  const [court, setCourt] = useState({
    courtDivision: matter.courtDivision ?? '',
    courtCaseNumber: matter.courtCaseNumber ?? '',
    courtOnlineReference: matter.courtOnlineReference ?? '',
  });
  const [online, setOnline] = useState<CourtOnlineStatus | null>(null);
  const [periods, setPeriods] = useState<Prescription[]>([]);
  const [form, setForm] = useState({
    rule: 'general_3y' as PrescriptionRuleCode,
    startsOn: '',
    lastDay: '',
    notes: '',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data } = await api.get<Prescription[]>('/calendar/prescriptions', {
      params: { caseId: matter.id },
    });
    setPeriods(data);
    setOnline((await api.get<CourtOnlineStatus>(`/cases/${matter.id}/court-online`)).data);
  }, [matter.id]);

  useEffect(() => {
    load().catch((err) => setError(apiErrorMessage(err, 'Prescriptions could not be loaded.')));
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

  const saveCourt = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    run(() =>
      api.put(`/cases/${matter.id}/court`, {
        courtDivision: court.courtDivision || null,
        courtCaseNumber: court.courtCaseNumber.trim() || null,
        courtOnlineReference: court.courtOnlineReference.trim() || null,
      }),
    );
  };

  const addPeriod = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    run(async () => {
      await api.post('/calendar/prescriptions', {
        caseRef: matter.id,
        rule: form.rule,
        startsOn: form.startsOn,
        ...(form.rule === 'custom' ? { lastDay: form.lastDay } : {}),
        notes: form.notes || undefined,
      });
      setForm({ rule: 'general_3y', startsOn: '', lastDay: '', notes: '' });
    });
  };

  const rule = PRESCRIPTION_RULES.find((candidate) => candidate.code === form.rule)!;

  return (
    <section className="panel" aria-label="Court and prescription">
      <div className="panel-head">
        <div>
          <p className="panel-kicker">Court and prescription</p>
          <h2>Court details and limitation periods</h2>
        </div>
      </div>
      {error ? <p className="field-hint notice-error">{error}</p> : null}

      {canEditMatter ? (
        <form className="time-form" aria-label="Court details" onSubmit={saveCourt}>
          <select
            aria-label="Court"
            value={court.courtDivision}
            onChange={(event) => setCourt({ ...court, courtDivision: event.target.value })}
          >
            <option value="">Not in court yet</option>
            {COURT_DIVISIONS.map((division) => (
              <option key={division.code} value={division.code}>
                {division.name}
              </option>
            ))}
          </select>
          <input
            aria-label="Court case number"
            placeholder="Case number, e.g. 12345/2025"
            value={court.courtCaseNumber}
            onChange={(event) => setCourt({ ...court, courtCaseNumber: event.target.value })}
          />
          <input
            aria-label="Court Online case number"
            placeholder="Court Online number, if different"
            value={court.courtOnlineReference}
            onChange={(event) => setCourt({ ...court, courtOnlineReference: event.target.value })}
          />
          <button className="secondary-button" disabled={busy}>
            Save court details
          </button>
        </form>
      ) : (
        <p>
          {COURT_DIVISIONS.find((division) => division.code === matter.courtDivision)?.name ??
            'Not in court yet'}
          {matter.courtCaseNumber ? ` · case ${matter.courtCaseNumber}` : ''}
          {matter.courtOnlineReference ? ` · Court Online ${matter.courtOnlineReference}` : ''}
        </p>
      )}
      {online?.court ? (
        <p className="field-hint notice-info">
          This court uses Court Online (since {online.court.since}): file and manage the matter
          there, and check the division&apos;s current directives.{' '}
          <a href={online.url} target="_blank" rel="noreferrer">
            Open Court Online
          </a>
          <br />
          <span className="field-hint">Source: {online.court.source}</span>
        </p>
      ) : null}

      {periods.length ? (
        <table className="time-table">
          <thead>
            <tr>
              <th>Period</th>
              <th>From</th>
              <th>Last day</th>
              <th>Status</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {periods.map((period) => (
              <tr
                key={period.id}
                className={
                  period.status === 'running' && (period.lapsed || period.daysLeft <= 30)
                    ? 'urgent'
                    : ''
                }
              >
                <td>
                  {PRESCRIPTION_RULES.find((candidate) => candidate.code === period.rule)?.label}
                  {period.notes ? <div className="muted">{period.notes}</div> : null}
                </td>
                <td>{period.startsOn}</td>
                <td>{period.lastDay}</td>
                <td>
                  {period.status === 'running'
                    ? period.lapsed
                      ? 'Lapsed'
                      : `${period.daysLeft} days left`
                    : STATUS_LABEL[period.status]}
                </td>
                <td className="row-actions">
                  {canEditCalendar && period.status === 'running' ? (
                    <>
                      <button
                        type="button"
                        className="link-button"
                        disabled={busy}
                        onClick={() =>
                          run(() =>
                            api.patch(`/calendar/prescriptions/${period.id}`, {
                              status: 'interrupted',
                            }),
                          )
                        }
                      >
                        Interrupted
                      </button>
                      <button
                        type="button"
                        className="link-button"
                        disabled={busy}
                        onClick={() =>
                          run(() =>
                            api.patch(`/calendar/prescriptions/${period.id}`, { status: 'closed' }),
                          )
                        }
                      >
                        Close
                      </button>
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="field-hint">No prescription periods recorded.</p>
      )}

      {canEditCalendar ? (
        <form className="time-form" aria-label="Add a prescription" onSubmit={addPeriod}>
          <select
            aria-label="Prescription rule"
            value={form.rule}
            onChange={(event) =>
              setForm({ ...form, rule: event.target.value as PrescriptionRuleCode })
            }
          >
            {PRESCRIPTION_RULES.map((candidate) => (
              <option key={candidate.code} value={candidate.code}>
                {candidate.label}
              </option>
            ))}
          </select>
          <input
            aria-label="Period runs from"
            type="date"
            max={localDate()}
            value={form.startsOn}
            onChange={(event) => setForm({ ...form, startsOn: event.target.value })}
          />
          {form.rule === 'custom' ? (
            <input
              aria-label="Last day"
              type="date"
              value={form.lastDay}
              onChange={(event) => setForm({ ...form, lastDay: event.target.value })}
            />
          ) : null}
          <input
            aria-label="Prescription notes"
            placeholder="Notes (e.g. how the date was worked out)"
            value={form.notes}
            onChange={(event) => setForm({ ...form, notes: event.target.value })}
          />
          <button
            className="secondary-button"
            disabled={busy || !form.startsOn || (form.rule === 'custom' && !form.lastDay)}
          >
            Add prescription
          </button>
        </form>
      ) : null}
      <p className="field-hint">
        {rule.source ? `${rule.source}. ` : ''}The last day is calculated as the day before the
        anniversary. Confirm the period and when it started to run, including any delay or
        interruption; reminders go out 90, 30 and 7 days and a day before.
      </p>
    </section>
  );
}

export default MatterCourtPanel;
