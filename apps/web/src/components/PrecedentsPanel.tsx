import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { ApprovedSource, Precedent } from '@ahava88/shared';
import { api, apiErrorMessage } from '../api';

function PrecedentCard({
  precedent,
  canApprove,
  onChange,
  onRemove,
}: {
  precedent: Precedent;
  canApprove: boolean;
  onChange: (next: Precedent) => void;
  onRemove: () => void;
}) {
  const [text, setText] = useState(precedent.text);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const review = precedent.status === 'review';
  const edited = text.trim() !== precedent.text.trim();
  const run = async (action: () => Promise<void>) => {
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
  return (
    <article className="research-brief">
      <header>
        <strong>{precedent.title}</strong>
        <span className={`status-pill status-${review ? 'trialing' : 'active'}`}>
          {review ? 'In review' : 'Approved'}
        </span>
      </header>
      {review && precedent.warnings.length ? (
        <p className="field-hint notice-warn">
          Check these: they may be names: <strong>{precedent.warnings.join(', ')}</strong>
        </p>
      ) : null}
      <label>
        De-identified text research will search
        <textarea
          rows={8}
          value={text}
          readOnly={!review}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      {error ? <p className="field-hint notice-error">{error}</p> : null}
      <div className="button-row">
        {review ? (
          <button
            type="button"
            className="secondary-button"
            disabled={busy || !edited}
            onClick={() =>
              run(async () => {
                const { data } = await api.patch<Precedent>(`/precedents/${precedent.id}`, {
                  text,
                });
                onChange(data);
              })
            }
          >
            Save edits
          </button>
        ) : null}
        {review && canApprove ? (
          <button
            type="button"
            className="primary-button"
            disabled={busy || edited}
            onClick={() =>
              run(async () => {
                const { data } = await api.post<Precedent>(`/precedents/${precedent.id}/approve`);
                onChange(data);
              })
            }
          >
            Approve for research
          </button>
        ) : null}
        {canApprove ? (
          <button
            type="button"
            className="link-button"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await api.delete(`/precedents/${precedent.id}`);
                onRemove();
              })
            }
          >
            Remove
          </button>
        ) : null}
      </div>
    </article>
  );
}

/** The firm's precedents as a research source, and the approved public sources. */
function PrecedentsPanel({ canApprove }: { canApprove: boolean }) {
  const [precedents, setPrecedents] = useState<Precedent[]>([]);
  const [sources, setSources] = useState<ApprovedSource[]>([]);
  const [form, setForm] = useState({ title: '', practiceArea: '', text: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [list, approved] = await Promise.all([
      api.get<Precedent[]>('/precedents'),
      api.get<ApprovedSource[]>('/research-sources'),
    ]);
    setPrecedents(list.data);
    setSources(approved.data);
  }, []);
  useEffect(() => {
    load().catch((err) => setError(apiErrorMessage(err, 'Research sources could not be loaded.')));
  }, [load]);

  const upload = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { data } = await api.post<Precedent>('/precedents', form);
      setPrecedents((list) => [data, ...list]);
      setForm({ title: '', practiceArea: '', text: '' });
    } catch (err) {
      setError(apiErrorMessage(err, 'The precedent could not be added.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel research-panel" aria-label="Research sources">
      <div className="panel-head">
        <div>
          <p className="panel-kicker">AI research</p>
          <h2>Research sources</h2>
        </div>
      </div>
      <h3>Approved sources</h3>
      {sources.length ? (
        <ul className="research-sources">
          {sources.map((source) => (
            <li key={source.code}>
              <strong>{source.name}</strong> ({source.documents} documents)
              <div className="field-hint">Used under: {source.licence}</div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="field-hint">
          No public sources are approved yet; research uses firm precedents only.
        </p>
      )}
      <h3>Firm precedents</h3>
      <p className="field-hint">
        Paste an opinion, heads of argument or memo. ID numbers, contact details, addresses and
        titled names are removed; check the result, and an attorney approves it before research can
        use it.
      </p>
      <form className="research-form" onSubmit={upload}>
        <label>
          Title
          <input
            required
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
        </label>
        <label>
          Practice area
          <input
            value={form.practiceArea}
            onChange={(e) => setForm({ ...form, practiceArea: e.target.value })}
          />
        </label>
        <label>
          Text
          <textarea
            rows={6}
            required
            value={form.text}
            onChange={(e) => setForm({ ...form, text: e.target.value })}
          />
        </label>
        <button type="submit" className="primary-button" disabled={busy}>
          Add precedent
        </button>
      </form>
      {error ? <p className="field-hint notice-error">{error}</p> : null}
      {precedents.map((precedent) => (
        <PrecedentCard
          key={precedent.id}
          precedent={precedent}
          canApprove={canApprove}
          onChange={(next) =>
            setPrecedents((list) => list.map((p) => (p.id === next.id ? next : p)))
          }
          onRemove={() => setPrecedents((list) => list.filter((p) => p.id !== precedent.id))}
        />
      ))}
    </section>
  );
}

export default PrecedentsPanel;
