import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  hasPermission,
  TIME_ACTIVITIES,
  TIME_ACTIVITY_LABELS,
  type MatterCase,
  type Permission,
  type PublicUser,
  type StaffRate,
  type TimeActivity,
  type TimeEntry,
  type TimerState,
  type WipSummary,
} from '@ahava88/shared';
import { api, apiErrorMessage } from '../api';

const CLOSED = ['closed', 'resolved', 'completed'];

/** R 12 500.00: grouped with spaces, decimal point, the same in every browser. */
const rand = (value: number) => {
  const [whole, cents] = value.toFixed(2).split('.');
  return `R ${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}.${cents}`;
};
const hours = (units: number) => (units / 10).toFixed(1);

function clock(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map((part) => String(part).padStart(2, '0')).join(':');
}

const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg' }).format(new Date());

interface Props {
  currentUser: PublicUser;
  cases: MatterCase[];
  selectedCaseId?: string | null;
}

/** Time recording: the timer, manual entries, recent time, WIP and rates. */
function TimePanel({ currentUser, cases, selectedCaseId }: Props) {
  const can = (permission: Permission) => hasPermission(currentUser.role, permission);
  const openMatters = cases.filter((matter) => !CLOSED.includes(matter.status));
  const defaultCase =
    openMatters.find((matter) => matter.id === selectedCaseId)?.id ?? openMatters[0]?.id ?? '';

  const [timer, setTimer] = useState<TimerState | null>(null);
  const [tick, setTick] = useState(0);
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [mineOnly, setMineOnly] = useState(can('time.record'));
  const [wip, setWip] = useState<WipSummary | null>(null);
  const [rates, setRates] = useState<StaffRate[]>([]);
  const [rateDrafts, setRateDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [caseRef, setCaseRef] = useState(defaultCase);
  const [activity, setActivity] = useState<TimeActivity>('consultation');
  const [billable, setBillable] = useState(true);
  const [description, setDescription] = useState('');
  const [minutes, setMinutes] = useState('');
  const [workDate, setWorkDate] = useState(today());

  useEffect(() => {
    if (!caseRef && defaultCase) setCaseRef(defaultCase);
  }, [caseRef, defaultCase]);

  const load = useCallback(async () => {
    const tasks: Array<Promise<unknown>> = [
      api
        .get<TimeEntry[]>('/time/entries', { params: mineOnly ? { userId: 'me' } : {} })
        .then(({ data }) => setEntries(data)),
      api.get<WipSummary>('/time/wip').then(({ data }) => setWip(data)),
    ];
    if (hasPermission(currentUser.role, 'time.record')) {
      tasks.push(
        api.get<{ timer: TimerState | null }>('/time/timer').then(({ data }) => {
          setTimer(data.timer);
          setTick(0);
        }),
      );
    }
    if (hasPermission(currentUser.role, 'rates.manage')) {
      tasks.push(api.get<StaffRate[]>('/time/rates').then(({ data }) => setRates(data)));
    }
    await Promise.all(tasks);
  }, [currentUser.role, mineOnly]);

  useEffect(() => {
    load().catch((err) => setError(apiErrorMessage(err, 'Time could not be loaded.')));
  }, [load]);

  useEffect(() => {
    if (!timer?.running) return undefined;
    const handle = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(handle);
  }, [timer?.running]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await action();
      await load();
    } catch (err) {
      setError(apiErrorMessage(err, 'That did not work.'));
    } finally {
      setBusy(false);
    }
  };

  const recordManual = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    run(async () => {
      await api.post('/time/entries', {
        caseRef,
        workDate,
        minutes: Number(minutes),
        activity,
        billable,
        description,
      });
      setMinutes('');
      setDescription('');
    });
  };

  const startTimer = () =>
    run(() =>
      api.post('/time/timer', {
        caseRef,
        activity,
        billable,
        description: description || undefined,
      }),
    );

  const stopTimer = () =>
    run(async () => {
      await api.post('/time/timer/stop', { description: description || undefined });
      setDescription('');
    });

  const seconds = timer ? timer.elapsedSeconds + (timer.running ? tick : 0) : 0;
  const matterOptions = openMatters.map((matter) => (
    <option key={matter.id} value={matter.id}>
      {matter.caseNumber}
      {matter.title ? ` · ${matter.title}` : ''}
    </option>
  ));

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <p className="panel-kicker">Time recording</p>
          <h2>Time &amp; work in progress</h2>
        </div>
      </div>
      {error ? <p className="field-hint notice-error">{error}</p> : null}

      {can('time.record') ? (
        <>
          <div className="time-timer" aria-label="Timer">
            {timer ? (
              <>
                <p>
                  <strong className="time-clock">{clock(seconds)}</strong> on {timer.caseNumber} ·{' '}
                  {TIME_ACTIVITY_LABELS[timer.activity]} · {timer.running ? 'running' : 'paused'}
                </p>
                <div className="inline-form">
                  <input
                    aria-label="Timer description"
                    placeholder={timer.description || 'What did you work on?'}
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                  />
                  {timer.running ? (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy}
                      onClick={() => run(() => api.post('/time/timer/pause'))}
                    >
                      Pause
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy}
                      onClick={() => run(() => api.post('/time/timer/resume'))}
                    >
                      Resume
                    </button>
                  )}
                  <button
                    type="button"
                    className="primary-button"
                    disabled={busy}
                    onClick={stopTimer}
                  >
                    Stop &amp; record
                  </button>
                  <button
                    type="button"
                    className="link-button"
                    disabled={busy}
                    onClick={() => run(() => api.delete('/time/timer'))}
                  >
                    Discard
                  </button>
                </div>
              </>
            ) : null}
          </div>

          <form className="time-form" onSubmit={recordManual} aria-label="Record time">
            <select
              aria-label="Matter"
              value={caseRef}
              onChange={(event) => setCaseRef(event.target.value)}
              required
            >
              {matterOptions}
            </select>
            <select
              aria-label="Activity"
              value={activity}
              onChange={(event) => setActivity(event.target.value as TimeActivity)}
            >
              {TIME_ACTIVITIES.map((value) => (
                <option key={value} value={value}>
                  {TIME_ACTIVITY_LABELS[value]}
                </option>
              ))}
            </select>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={billable}
                onChange={(event) => setBillable(event.target.checked)}
              />
              Billable
            </label>
            {timer ? null : (
              <>
                <input
                  aria-label="Description"
                  placeholder="Work done"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
                <input
                  aria-label="Date"
                  type="date"
                  max={today()}
                  value={workDate}
                  onChange={(event) => setWorkDate(event.target.value)}
                />
                <input
                  aria-label="Minutes"
                  type="number"
                  min={1}
                  max={1440}
                  placeholder="Minutes"
                  value={minutes}
                  onChange={(event) => setMinutes(event.target.value)}
                />
                <button
                  className="secondary-button"
                  disabled={busy || !caseRef || !minutes || !description.trim()}
                >
                  Record
                </button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={busy || !caseRef}
                  onClick={startTimer}
                >
                  Start timer
                </button>
              </>
            )}
          </form>
          <p className="field-hint">Time is recorded in 6-minute units (0.1 h), rounded up.</p>
        </>
      ) : null}

      <div className="time-entries-head">
        <h3>Recent time</h3>
        {can('time.record') ? (
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={mineOnly}
              onChange={(event) => setMineOnly(event.target.checked)}
            />
            Only mine
          </label>
        ) : null}
      </div>
      {entries.length ? (
        <table className="time-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Matter</th>
              <th>Fee earner</th>
              <th>Work</th>
              <th>Hours</th>
              <th>Value</th>
              <th>Status</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const mine = entry.userId === currentUser.id;
              const editable =
                entry.status === 'unbilled' && (can('time.manage') || (mine && can('time.record')));
              return (
                <tr key={entry.id}>
                  <td>{entry.workDate}</td>
                  <td>{entry.caseNumber}</td>
                  <td>{entry.feeEarnerName}</td>
                  <td>
                    {TIME_ACTIVITY_LABELS[entry.activity]}: {entry.description}
                  </td>
                  <td>{hours(entry.units)}</td>
                  <td>{entry.billable ? rand(entry.amount) : 'Non-billable'}</td>
                  <td>{entry.status.replace('_', ' ')}</td>
                  <td>
                    {editable ? (
                      <button
                        type="button"
                        className="link-button"
                        disabled={busy}
                        aria-label={`Delete time on ${entry.caseNumber} (${entry.workDate})`}
                        onClick={() => run(() => api.delete(`/time/entries/${entry.id}`))}
                      >
                        Delete
                      </button>
                    ) : null}
                    {editable && can('time.manage') ? (
                      <button
                        type="button"
                        className="link-button"
                        disabled={busy}
                        onClick={() => run(() => api.post(`/time/entries/${entry.id}/write-off`))}
                      >
                        Write off
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p className="field-hint">No time recorded yet.</p>
      )}

      {wip ? (
        <>
          <h3>
            Work in progress: {hours(wip.units)} h · {rand(wip.value)}
          </h3>
          {wip.matters.length ? (
            <table className="time-table">
              <thead>
                <tr>
                  <th>Matter</th>
                  <th>Hours</th>
                  <th>Value</th>
                  <th>Since</th>
                </tr>
              </thead>
              <tbody>
                {wip.matters.map((row) => (
                  <tr key={row.caseId}>
                    <td>
                      {row.caseNumber}
                      {row.title ? ` · ${row.title}` : ''}
                    </td>
                    <td>{hours(row.units)}</td>
                    <td>{rand(row.value)}</td>
                    <td>{row.oldestWorkDate}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="field-hint">No unbilled time.</p>
          )}
        </>
      ) : null}

      {can('rates.manage') && rates.length ? (
        <>
          <h3>Hourly rates</h3>
          <table className="time-table">
            <tbody>
              {rates.map((rate) => (
                <tr key={rate.userId}>
                  <td>{rate.fullName}</td>
                  <td>{rate.hourlyRate === null ? 'Not set' : rand(rate.hourlyRate)}</td>
                  <td>
                    <form
                      className="inline-form"
                      aria-label={`Rate for ${rate.fullName}`}
                      onSubmit={(event) => {
                        event.preventDefault();
                        const value = rateDrafts[rate.userId] ?? '';
                        run(async () => {
                          await api.put(`/time/rates/${rate.userId}`, {
                            hourlyRate: value.trim() === '' ? null : value,
                          });
                          setRateDrafts((current) => ({ ...current, [rate.userId]: '' }));
                        });
                      }}
                    >
                      <input
                        aria-label={`New rate for ${rate.fullName}`}
                        inputMode="decimal"
                        placeholder="R per hour"
                        value={rateDrafts[rate.userId] ?? ''}
                        onChange={(event) =>
                          setRateDrafts((current) => ({
                            ...current,
                            [rate.userId]: event.target.value,
                          }))
                        }
                      />
                      <button className="secondary-button" disabled={busy}>
                        Save
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="field-hint">
            Leave the rate empty and save to remove it. Agreed rates on a matter take precedence.
          </p>
        </>
      ) : null}
    </div>
  );
}

export default TimePanel;
