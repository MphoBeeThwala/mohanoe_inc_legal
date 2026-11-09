import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  hasPermission,
  type ConflictCheck,
  type MatterCase,
  type PartyKind,
  type PartyRecord,
  type PartySummary,
  type PublicUser,
} from '@ahava88/shared';
import { api, apiErrorMessage } from '../api';
import DismissibleNotice, { type Notice } from './DismissibleNotice';

interface ClientsPanelProps {
  currentUser: PublicUser;
  onMatterOpened: (matter: MatterCase) => void;
}

const ROLE_NAMES: Record<string, string> = {
  client: 'Client',
  opposing: 'Opposing party',
  opposing_attorney: 'Opposing attorney',
  related: 'Related person',
  witness: 'Witness',
};

const looksLikeOrganisation = (name: string) =>
  /\b(pty|ltd|limited|inc|cc|npc|soc|trust|bank|municipality|department|holdings|group)\b/i.test(
    name,
  );

const emptySubject = {
  name: '',
  kind: 'individual' as PartyKind,
  idNumber: '',
  email: '',
  phone: '',
};

/** The client register, conflict checks, and opening clients and matters. */
function ClientsPanel({ currentUser, onMatterOpened }: ClientsPanelProps) {
  const can = (permission: Parameters<typeof hasPermission>[1]) =>
    hasPermission(currentUser.role, permission);
  const [query, setQuery] = useState('');
  const [list, setList] = useState<PartySummary[]>([]);
  const [selected, setSelected] = useState<PartyRecord | null>(null);
  const [mode, setMode] = useState<'list' | 'check'>('list');
  const [subject, setSubject] = useState(emptySubject);
  const [others, setOthers] = useState('');
  const [purpose, setPurpose] = useState('');
  const [result, setResult] = useState<ConflictCheck | null>(null);
  const [notes, setNotes] = useState('');
  const [client, setClient] = useState<PartyRecord | null>(null);
  const [matter, setMatter] = useState({ title: '', practiceArea: '' });
  const [notice, setNotice] = useState<Notice>({ tone: 'info', message: '' });
  const [busy, setBusy] = useState(false);

  const search = useCallback(async (q: string) => {
    const { data } = await api.get<PartySummary[]>('/clients', { params: q ? { q } : {} });
    setList(data);
  }, []);

  useEffect(() => {
    search('').catch(() => undefined);
  }, [search]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      setNotice({ tone: 'error', message: apiErrorMessage(error, 'That did not work.') });
    } finally {
      setBusy(false);
    }
  };

  const otherParties = () =>
    others
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

  const startCheck = (forClient?: PartyRecord) => {
    setMode('check');
    setResult(null);
    setNotes('');
    setPurpose('');
    setOthers('');
    setClient(forClient ?? null);
    setSubject(
      forClient
        ? {
            name: forClient.details.name,
            kind: forClient.kind,
            idNumber: forClient.details.idNumber ?? forClient.details.registrationNumber ?? '',
            email: forClient.details.email ?? '',
            phone: forClient.details.phone ?? '',
          }
        : emptySubject,
    );
  };

  const submitCheck = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    run(async () => {
      const id = subject.idNumber.trim();
      const subjects = [
        {
          name: subject.name,
          kind: subject.kind,
          ...(subject.kind === 'entity' ? { registrationNumber: id } : { idNumber: id }),
          email: subject.email,
          phone: subject.phone,
        },
        ...otherParties().map((name) => ({ name })),
      ];
      const { data } = await api.post<ConflictCheck>('/conflicts', { subjects, purpose });
      setResult(data);
    });
  };

  const decide = (decision: 'clear' | 'conflict' | 'waived') =>
    run(async () => {
      if (!result) return;
      const { data } = await api.post<ConflictCheck>(`/conflicts/${result.id}/decision`, {
        decision,
        notes: notes || undefined,
      });
      setResult(data);
      if (decision !== 'conflict' && !client) {
        const id = subject.idNumber.trim();
        const created = await api.post<PartyRecord>('/clients', {
          kind: subject.kind,
          conflictCheckId: data.id,
          details: {
            name: subject.name,
            ...(subject.kind === 'entity' ? { registrationNumber: id } : { idNumber: id }),
            email: subject.email,
            phone: subject.phone,
          },
        });
        setClient(created.data);
        setNotice({ tone: 'success', message: `Client ${created.data.partyNumber} opened.` });
        await search(query);
      }
    });

  const openMatter = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    run(async () => {
      if (!client || !result) return;
      const { data } = await api.post<MatterCase>('/cases', {
        clientId: client.id,
        conflictCheckId: result.id,
        title: matter.title,
        practiceArea: matter.practiceArea,
      });
      // The other parties named in the conflict check go onto the matter.
      for (const name of otherParties()) {
        await api.post(`/cases/${data.id}/parties`, {
          role: 'opposing',
          party: { kind: looksLikeOrganisation(name) ? 'entity' : 'individual', details: { name } },
        });
      }
      setNotice({ tone: 'success', message: `Matter ${data.caseNumber} opened.` });
      setMatter({ title: '', practiceArea: '' });
      setMode('list');
      onMatterOpened(data);
    });
  };

  const field = (name: keyof typeof emptySubject, placeholder: string, required = false) => (
    <input
      aria-label={placeholder}
      placeholder={placeholder}
      value={subject[name]}
      required={required}
      onChange={(event) => setSubject((current) => ({ ...current, [name]: event.target.value }))}
    />
  );

  const decided = result && result.decision !== 'pending';

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <p className="panel-kicker">Clients</p>
          <h2>Client register and conflict checks</h2>
        </div>
        {mode === 'list' && can('conflicts.check') && can('clients.write') ? (
          <button type="button" className="primary-button" onClick={() => startCheck()}>
            New client
          </button>
        ) : null}
        {mode === 'check' ? (
          <button type="button" className="secondary-button" onClick={() => setMode('list')}>
            Back to clients
          </button>
        ) : null}
      </div>
      <DismissibleNotice
        tone={notice.tone}
        message={notice.message}
        onDismiss={() => setNotice({ tone: 'info', message: '' })}
      />

      {mode === 'list' ? (
        <>
          <form
            className="inline-form"
            aria-label="Search clients"
            onSubmit={(event) => {
              event.preventDefault();
              run(() => search(query));
            }}
          >
            <input
              aria-label="Search by name, ID or registration number, email or phone"
              placeholder="Name, ID / registration number, email or phone"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <button className="secondary-button" disabled={busy}>
              Search
            </button>
          </form>
          <div className="mini-list">
            {list.map((item) => (
              <button
                key={item.id}
                type="button"
                className="mini-item list-button"
                onClick={() =>
                  run(async () =>
                    setSelected((await api.get<PartyRecord>(`/clients/${item.id}`)).data),
                  )
                }
              >
                <span>
                  <strong>{item.name}</strong> · {item.partyNumber}
                </span>
                <span className="muted">
                  {item.kind === 'entity' ? 'Organisation' : 'Individual'}
                </span>
              </button>
            ))}
            {!list.length ? <p className="field-hint">No clients found.</p> : null}
          </div>
          {selected ? (
            <div className="panel nested-panel">
              <h3>
                {selected.name} · {selected.partyNumber}
              </h3>
              <p className="field-hint">
                {[
                  selected.details.idNumber,
                  selected.details.registrationNumber,
                  selected.details.email,
                  selected.details.phone,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
              <h4>Matters</h4>
              <ul className="field-hint">
                {selected.matters.map((m) => (
                  <li key={`${m.caseId}-${m.role}`}>
                    {m.caseNumber} {m.title ? `· ${m.title}` : ''} · {ROLE_NAMES[m.role] ?? m.role}
                  </li>
                ))}
                {!selected.matters.length ? <li>None you can see.</li> : null}
              </ul>
              {can('conflicts.check') && can('matters.write') ? (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => startCheck(selected)}
                >
                  New matter for this client
                </button>
              ) : null}
            </div>
          ) : null}
        </>
      ) : (
        <>
          <form className="stack-form" onSubmit={submitCheck} aria-label="Conflict check">
            <h3>1. Conflict check</h3>
            <select
              aria-label="Client type"
              value={subject.kind}
              disabled={Boolean(client)}
              onChange={(event) =>
                setSubject((current) => ({ ...current, kind: event.target.value as PartyKind }))
              }
            >
              <option value="individual">Individual</option>
              <option value="entity">Organisation</option>
            </select>
            {field('name', subject.kind === 'entity' ? 'Registered name' : 'Full name', true)}
            {field(
              'idNumber',
              subject.kind === 'entity' ? 'Registration number' : 'ID or passport number',
            )}
            {field('email', 'Email')}
            {field('phone', 'Phone')}
            <textarea
              aria-label="Other parties"
              rows={3}
              placeholder="Other parties (opposing parties, their attorneys), one per line"
              value={others}
              onChange={(event) => setOthers(event.target.value)}
            />
            <input
              aria-label="Proposed matter"
              placeholder="Proposed matter, e.g. Unfair dismissal claim (no names)"
              value={purpose}
              onChange={(event) => setPurpose(event.target.value)}
              required
            />
            <button className="primary-button" disabled={busy || Boolean(result)}>
              Run conflict check
            </button>
          </form>

          {result ? (
            <div className="panel nested-panel">
              <h3>
                {result.strongMatches || result.possibleMatches
                  ? `${result.strongMatches} strong and ${result.possibleMatches} possible match(es)`
                  : 'No matches in the register'}
              </h3>
              <ul className="conflict-list">
                {result.matches.map((match) => (
                  <li
                    key={`${match.subject}-${match.party.id}`}
                    className={`conflict-${match.strength}`}
                  >
                    <strong>{result.subjects[match.subject]?.name}</strong> matches{' '}
                    <strong>{match.party.name}</strong> ({match.party.partyNumber}
                    {match.party.isClient ? ', a client' : ''}): {match.strength}, on{' '}
                    {match.reasons.join(', ').replace(/_/g, ' ')}.
                    {match.matters.length ? (
                      <div className="field-hint">
                        {match.matters
                          .map((m) => `${m.caseNumber} (${ROLE_NAMES[m.role] ?? m.role})`)
                          .join('; ')}
                      </div>
                    ) : null}
                    {match.hiddenMatters ? (
                      <div className="field-hint">
                        Also on {match.hiddenMatters} matter(s) you can't see: ask an administrator.
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
              {!decided ? (
                <>
                  <textarea
                    aria-label="Decision notes"
                    rows={2}
                    placeholder={
                      result.strongMatches
                        ? 'Why the matches are not conflicts, or how consent was obtained (required)'
                        : 'Notes (optional)'
                    }
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
                  />
                  <div className="action-row">
                    <button
                      type="button"
                      className="primary-button"
                      disabled={busy}
                      onClick={() => decide('clear')}
                    >
                      No conflict: proceed
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy}
                      onClick={() => decide('conflict')}
                    >
                      Conflict: decline
                    </button>
                    {can('conflicts.waive') ? (
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={busy}
                        onClick={() => decide('waived')}
                      >
                        Waive (informed consent)
                      </button>
                    ) : null}
                  </div>
                </>
              ) : (
                <p className="field-hint">
                  Decision: <strong>{result.decision}</strong>
                  {result.decidedBy ? ` by ${result.decidedBy}` : ''}. Kept in the firm's conflict
                  register.
                </p>
              )}
            </div>
          ) : null}

          {client && decided && result?.decision !== 'conflict' && can('matters.write') ? (
            <form className="stack-form" onSubmit={openMatter} aria-label="Open matter">
              <h3>2. Open a matter for {client.name}</h3>
              <input
                aria-label="Matter title"
                placeholder="Matter title, e.g. Unfair dismissal claim"
                value={matter.title}
                onChange={(event) =>
                  setMatter((current) => ({ ...current, title: event.target.value }))
                }
                required
              />
              <input
                aria-label="Practice area"
                placeholder="Practice area"
                value={matter.practiceArea}
                onChange={(event) =>
                  setMatter((current) => ({ ...current, practiceArea: event.target.value }))
                }
                required
              />
              <button className="primary-button" disabled={busy}>
                Open matter
              </button>
            </form>
          ) : null}
        </>
      )}
    </div>
  );
}

export default ClientsPanel;
