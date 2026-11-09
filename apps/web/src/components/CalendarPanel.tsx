import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  CALENDAR_EVENT_LABELS,
  CALENDAR_EVENT_TYPES,
  hasPermission,
  PRESCRIPTION_RULES,
  type CalendarEvent,
  type CalendarEventType,
  type MatterCase,
  type Prescription,
  type PublicUser,
} from '@ahava88/shared';
import { api, apiErrorMessage } from '../api';

const ZONE = 'Africa/Johannesburg';

export const localDate = (value: Date = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(value);

/** A date and time entered in South Africa (UTC+2, no DST) as an ISO string. */
export const saDateTime = (date: string, time: string) => `${date}T${time || '00:00'}:00+02:00`;

const dayHeading = (value: string) =>
  new Intl.DateTimeFormat('en-ZA', {
    timeZone: ZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(value));

const timeOf = (value: string) =>
  new Intl.DateTimeFormat('en-ZA', { timeZone: ZONE, hour: '2-digit', minute: '2-digit' }).format(
    new Date(value),
  );

const ruleLabel = (code: string) =>
  PRESCRIPTION_RULES.find((rule) => rule.code === code)?.label ?? code;

interface Props {
  currentUser: PublicUser;
  cases: MatterCase[];
  selectedCaseId?: string | null;
  onChanged?: () => unknown;
}

/** The firm's agenda, running prescriptions, and adding events. */
function CalendarPanel({ currentUser, cases, selectedCaseId, onChanged }: Props) {
  const canWrite = hasPermission(currentUser.role, 'calendar.write');
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [periods, setPeriods] = useState<Prescription[]>([]);
  const [mine, setMine] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    caseId: selectedCaseId ?? cases[0]?.id ?? '',
    eventType: 'court_date' as CalendarEventType,
    title: '',
    date: localDate(),
    time: '09:00',
    allDay: false,
    location: '',
  });

  useEffect(() => {
    setForm((current) =>
      current.caseId ? current : { ...current, caseId: selectedCaseId ?? cases[0]?.id ?? '' },
    );
  }, [selectedCaseId, cases]);

  const load = useCallback(async () => {
    const to = localDate(new Date(Date.now() + 90 * 86_400_000));
    const [list, running] = await Promise.all([
      api.get<CalendarEvent[]>('/calendar', {
        params: { from: localDate(), to, ...(mine ? { mine: '1' } : {}) },
      }),
      api.get<Prescription[]>('/calendar/prescriptions'),
    ]);
    setEvents(list.data);
    setPeriods(running.data.filter((period) => period.status === 'running'));
  }, [mine]);

  useEffect(() => {
    load().catch((err) => setError(apiErrorMessage(err, 'The calendar could not be loaded.')));
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

  const add = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    run(async () => {
      await api.post('/calendar', {
        caseId: form.caseId,
        eventType: form.eventType,
        title: form.title,
        startsAt: form.allDay ? form.date : saDateTime(form.date, form.time),
        allDay: form.allDay,
        location: form.location,
      });
      setForm((current) => ({ ...current, title: '', location: '' }));
    });
  };

  const byDay = useMemo(() => {
    const groups = new Map<string, CalendarEvent[]>();
    for (const item of events) {
      const day = localDate(new Date(item.startsAt));
      groups.set(day, [...(groups.get(day) ?? []), item]);
    }
    return [...groups.entries()];
  }, [events]);

  return (
    <div className="calendar-panel">
      {error ? <p className="field-hint notice-error">{error}</p> : null}

      {canWrite ? (
        <form className="time-form" aria-label="Add an event" onSubmit={add}>
          <select
            aria-label="Matter"
            value={form.caseId}
            onChange={(event) => setForm({ ...form, caseId: event.target.value })}
          >
            {cases.map((matter) => (
              <option key={matter.id} value={matter.id}>
                {matter.caseNumber}
                {matter.title ? ` · ${matter.title}` : ''}
              </option>
            ))}
          </select>
          <select
            aria-label="Event type"
            value={form.eventType}
            onChange={(event) =>
              setForm({ ...form, eventType: event.target.value as CalendarEventType })
            }
          >
            {CALENDAR_EVENT_TYPES.filter((type) => type !== 'prescription').map((type) => (
              <option key={type} value={type}>
                {CALENDAR_EVENT_LABELS[type]}
              </option>
            ))}
          </select>
          <input
            aria-label="Event title"
            placeholder="e.g. Opposed motion, Court 4A"
            value={form.title}
            onChange={(event) => setForm({ ...form, title: event.target.value })}
          />
          <input
            aria-label="Event date"
            type="date"
            value={form.date}
            onChange={(event) => setForm({ ...form, date: event.target.value })}
          />
          {form.allDay ? null : (
            <input
              aria-label="Event time"
              type="time"
              value={form.time}
              onChange={(event) => setForm({ ...form, time: event.target.value })}
            />
          )}
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={form.allDay}
              onChange={(event) => setForm({ ...form, allDay: event.target.checked })}
            />
            All day
          </label>
          <input
            aria-label="Event location"
            placeholder="Court, room or link"
            value={form.location}
            onChange={(event) => setForm({ ...form, location: event.target.value })}
          />
          <button className="primary-button" disabled={busy || !form.caseId || !form.title.trim()}>
            Add event
          </button>
        </form>
      ) : null}

      <div className="time-entries-head">
        <h3>Next 90 days</h3>
        <div className="row-actions">
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={mine}
              onChange={(event) => setMine(event.target.checked)}
            />
            Assigned to me
          </label>
          <a href={`/api/calendar/ics${mine ? '?mine=1' : ''}`}>Download for Outlook (.ics)</a>
        </div>
      </div>
      {byDay.length ? (
        byDay.map(([day, items]) => (
          <div key={day} className="agenda-day">
            <h4>{dayHeading(items[0]!.startsAt)}</h4>
            <ul className="agenda-list">
              {items.map((item) => (
                <li key={item.id} className={`agenda-item agenda-${item.eventType}`}>
                  <span className="agenda-time">
                    {item.allDay ? 'All day' : timeOf(item.startsAt)}
                  </span>
                  <span>
                    <strong>
                      {CALENDAR_EVENT_LABELS[item.eventType as CalendarEventType] ?? 'Event'}
                    </strong>{' '}
                    · {item.caseNumber} · {item.title}
                    {item.location ? ` · ${item.location}` : ''}
                    {item.assigneeName ? ` · ${item.assigneeName}` : ''}
                    {item.source === 'court_roll' ? ' · from court roll' : ''}
                  </span>
                  {canWrite ? (
                    <span className="row-actions">
                      <button
                        type="button"
                        className="link-button"
                        disabled={busy}
                        onClick={() =>
                          run(() => api.patch(`/calendar/${item.id}`, { status: 'done' }))
                        }
                      >
                        Done
                      </button>
                      {item.source !== 'prescription' ? (
                        <button
                          type="button"
                          className="link-button"
                          disabled={busy}
                          aria-label={`Cancel ${item.title}`}
                          onClick={() =>
                            run(() => api.patch(`/calendar/${item.id}`, { status: 'cancelled' }))
                          }
                        >
                          Cancel
                        </button>
                      ) : null}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ))
      ) : (
        <p className="field-hint">Nothing scheduled in the next 90 days.</p>
      )}

      <h3>Running prescriptions</h3>
      {periods.length ? (
        <table className="time-table">
          <thead>
            <tr>
              <th>Matter</th>
              <th>Period</th>
              <th>Last day</th>
              <th>Days left</th>
            </tr>
          </thead>
          <tbody>
            {periods.map((period) => (
              <tr
                key={period.id}
                className={period.lapsed || period.daysLeft <= 30 ? 'urgent' : ''}
              >
                <td>{period.caseNumber}</td>
                <td>{ruleLabel(period.rule)}</td>
                <td>{period.lastDay}</td>
                <td>{period.lapsed ? 'Lapsed' : period.daysLeft}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="field-hint">No running prescriptions. Add them on a matter.</p>
      )}
    </div>
  );
}

export default CalendarPanel;
