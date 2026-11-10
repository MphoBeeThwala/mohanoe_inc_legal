import { useCallback, useEffect, useState, type ChangeEvent } from 'react';
import {
  type CourtRollWatchers,
  COURT_DIVISIONS,
  hasPermission,
  type CourtRollMatch,
  type CourtRollUploadResult,
  type PublicUser,
} from '@ahava88/shared';
import { api, apiErrorMessage } from '../api';
import { saDateTime } from '../lib/dates';

const courtName = (code: string) =>
  COURT_DIVISIONS.find((division) => division.code === code)?.name ?? code;

const MAX_BYTES = 10 * 1024 * 1024;

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

interface Props {
  currentUser: PublicUser;
  onChanged?: () => unknown;
}

/**
 * Matters found on published court rolls (checked twice a week) or on a roll
 * uploaded here. Nothing goes on the calendar until someone accepts it.
 */
function CourtRollPanel({ currentUser, onChanged }: Props) {
  const canWrite = hasPermission(currentUser.role, 'calendar.write');
  const [matches, setMatches] = useState<CourtRollMatch[]>([]);
  const [division, setDivision] = useState<string>(COURT_DIVISIONS[0].code);
  const [dates, setDates] = useState<Record<string, { date: string; time: string }>>({});
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const canChooseWatchers = hasPermission(currentUser.role, 'users.manage');
  const [watchers, setWatchers] = useState<string[]>([]);
  const [staff, setStaff] = useState<
    Array<{ id: string; fullName: string; role: string; isActive: boolean }>
  >([]);

  const load = useCallback(async () => {
    const { data } = await api.get<CourtRollMatch[]>('/court-rolls/matches');
    setMatches(data);
    if (canChooseWatchers) {
      const [chosen, people] = await Promise.all([
        api.get<CourtRollWatchers>('/court-rolls/watchers'),
        api.get<Array<{ id: string; fullName: string; role: string; isActive: boolean }>>('/users'),
      ]);
      setWatchers(chosen.data.userIds);
      setStaff(people.data.filter((person) => person.isActive && person.role !== 'support'));
    }
  }, [canChooseWatchers]);

  useEffect(() => {
    load().catch((err) => setError(apiErrorMessage(err, 'Court rolls could not be loaded.')));
  }, [load]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    setMessage('');
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

  const upload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setError('The roll must be 10 MB or smaller.');
      return;
    }
    run(async () => {
      const { data } = await api.post<CourtRollUploadResult>('/court-rolls/upload', {
        division,
        fileName: file.name,
        contentType: file.type || 'application/octet-stream',
        contentBase64: await readBase64(file),
      });
      setMessage(
        `Read ${data.hearings} listing(s); ${data.matches.length} of your matters are on this roll.`,
      );
    });
  };

  const accept = (match: CourtRollMatch) => {
    const chosen = dates[match.id];
    run(() =>
      api.post(`/court-rolls/matches/${match.id}/accept`, {
        ...(match.hearingDate ? {} : { startsAt: saDateTime(chosen!.date, chosen!.time) }),
      }),
    );
  };

  return (
    <div className="court-roll-panel">
      <h3>Court rolls</h3>
      <p className="field-hint">
        Published rolls are checked twice a week and matched by court and case number. Rolls change,
        so nothing goes on the calendar until you accept it.
      </p>
      {error ? <p className="field-hint notice-error">{error}</p> : null}
      {message ? <p className="field-hint">{message}</p> : null}

      {matches.length ? (
        <ul className="agenda-list">
          {matches.map((match) => (
            <li key={match.id} className={`agenda-item roll-${match.status}`}>
              <span className="agenda-time">{match.hearingTime ?? ''}</span>
              <span>
                <strong>{match.caseNumber}</strong>
                {match.courtCaseNumber ? ` (${match.courtCaseNumber})` : ''} ·{' '}
                {match.hearingDate ?? 'date not on the roll'} · {courtName(match.division)}
                {match.courtroom ? `, court ${match.courtroom}` : ''}
                {match.section ? ` · ${match.section}` : ''}
                {match.judge ? ` · before ${match.judge}` : ''}
                <div className="muted">
                  {match.status === 'removed'
                    ? 'Not on the amended roll: check with the registrar. '
                    : ''}
                  {match.onCalendar ? 'Already on the calendar. ' : ''}
                  {match.documentUrl ? (
                    <a href={match.documentUrl} target="_blank" rel="noreferrer">
                      {match.documentTitle}
                    </a>
                  ) : (
                    match.documentTitle
                  )}
                </div>
              </span>
              {canWrite && match.status === 'new' ? (
                <span className="row-actions">
                  {match.hearingDate ? null : (
                    <>
                      <input
                        aria-label={`Hearing date for ${match.caseNumber}`}
                        type="date"
                        value={dates[match.id]?.date ?? ''}
                        onChange={(event) =>
                          setDates({
                            ...dates,
                            [match.id]: {
                              time: dates[match.id]?.time ?? '10:00',
                              date: event.target.value,
                            },
                          })
                        }
                      />
                      <input
                        aria-label={`Hearing time for ${match.caseNumber}`}
                        type="time"
                        value={dates[match.id]?.time ?? '10:00'}
                        onChange={(event) =>
                          setDates({
                            ...dates,
                            [match.id]: {
                              date: dates[match.id]?.date ?? '',
                              time: event.target.value,
                            },
                          })
                        }
                      />
                    </>
                  )}
                  <button
                    type="button"
                    className="link-button"
                    disabled={busy || (!match.hearingDate && !dates[match.id]?.date)}
                    aria-label={`Add ${match.caseNumber} hearing to the calendar`}
                    onClick={() => accept(match)}
                  >
                    Add to calendar
                  </button>
                  <button
                    type="button"
                    className="link-button"
                    disabled={busy}
                    aria-label={`Dismiss ${match.caseNumber} listing`}
                    onClick={() => run(() => api.post(`/court-rolls/matches/${match.id}/dismiss`))}
                  >
                    Dismiss
                  </button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="field-hint">No new court roll listings for your matters.</p>
      )}

      {canChooseWatchers ? (
        <fieldset className="plan-options" aria-label="Court roll notices">
          <legend>
            Also tell these people about every court roll listing, change and reminder
          </legend>
          <p className="field-hint">
            The matter&apos;s team (including the responsible attorney) is always told. Add the
            office manager or anyone else who keeps the diary. Restricted matters only go to people
            on them.
          </p>
          {staff.map((person) => (
            <label key={person.id} className="inline-check">
              <input
                type="checkbox"
                checked={watchers.includes(person.id)}
                onChange={(event) => {
                  const next = event.target.checked
                    ? [...watchers, person.id]
                    : watchers.filter((id) => id !== person.id);
                  run(async () => {
                    await api.put('/court-rolls/watchers', { userIds: next });
                    setMessage('Saved: they will get court roll notices.');
                  });
                }}
              />
              {person.fullName}
            </label>
          ))}
        </fieldset>
      ) : null}

      {canWrite ? (
        <form
          className="time-form"
          aria-label="Upload a court roll"
          onSubmit={(e) => e.preventDefault()}
        >
          <select
            aria-label="Roll court"
            value={division}
            onChange={(event) => setDivision(event.target.value)}
          >
            {COURT_DIVISIONS.map((court) => (
              <option key={court.code} value={court.code}>
                {court.name}
              </option>
            ))}
          </select>
          <label className="secondary-button">
            Upload a roll (PDF or Word)
            <input
              type="file"
              accept=".pdf,.docx,.html,.htm,.txt,application/pdf"
              aria-label="Roll file"
              className="visually-hidden"
              disabled={busy}
              onChange={upload}
            />
          </label>
        </form>
      ) : null}
    </div>
  );
}

export default CourtRollPanel;
