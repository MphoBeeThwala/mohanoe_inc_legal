import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { SupportGrant } from '@ahava88/shared';
import { api, apiErrorMessage } from '../api';
import DismissibleNotice, { type Notice } from './DismissibleNotice';

/** Firm administrators: allow platform support in, for a limited time. */
function SupportAccessPanel({ platformName }: { platformName: string }) {
  const [grants, setGrants] = useState<SupportGrant[]>([]);
  const [form, setForm] = useState({ hours: '4', reason: '' });
  const [notice, setNotice] = useState<Notice>({ tone: 'info', message: '' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data } = await api.get<SupportGrant[]>('/support/grants');
    setGrants(data);
  }, []);

  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);

  const grant = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api.post('/support/grants', { hours: Number(form.hours), reason: form.reason });
      setForm({ hours: '4', reason: '' });
      setNotice({
        tone: 'success',
        message: 'Support can now sign in, read-only, until the grant ends.',
      });
      await load();
    } catch (error) {
      setNotice({ tone: 'error', message: apiErrorMessage(error, 'Could not grant access.') });
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    setBusy(true);
    try {
      await api.delete(`/support/grants/${id}`);
      setNotice({
        tone: 'success',
        message: 'Support access ended. Any support session was signed out.',
      });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const active = grants.filter((item) => item.status === 'active');

  return (
    <div className="panel">
      <p className="panel-kicker">Platform support</p>
      <h2>Support access</h2>
      <DismissibleNotice
        tone={notice.tone}
        message={notice.message}
        onDismiss={() => setNotice({ tone: 'info', message: '' })}
      />
      <p className="field-hint">
        {platformName} support can only see your workspace while you allow it. Access is read-only,
        excludes restricted matters and ethical walls, ends automatically, and every page they open
        is recorded in your audit trail.
      </p>
      {active.length ? (
        <div className="mini-list">
          {active.map((item) => (
            <div key={item.id} className="mini-item">
              <div>
                <strong>Active until {new Date(item.expiresAt).toLocaleString()}</strong>
                <div className="field-hint">
                  {item.reason}
                  {item.grantedBy ? ` · granted by ${item.grantedBy}` : ''}
                </div>
              </div>
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => revoke(item.id)}
              >
                End access now
              </button>
            </div>
          ))}
        </div>
      ) : (
        <form className="inline-form" onSubmit={grant} aria-label="Allow support access">
          <select
            aria-label="Duration"
            value={form.hours}
            onChange={(event) => setForm((current) => ({ ...current, hours: event.target.value }))}
          >
            <option value="1">1 hour</option>
            <option value="4">4 hours</option>
            <option value="24">24 hours</option>
            <option value="72">3 days</option>
          </select>
          <input
            placeholder="Reason or ticket number"
            value={form.reason}
            onChange={(event) => setForm((current) => ({ ...current, reason: event.target.value }))}
            minLength={3}
            required
          />
          <button className="secondary-button" disabled={busy}>
            Allow support access
          </button>
        </form>
      )}
      {grants.length > active.length ? (
        <details>
          <summary>Previous grants</summary>
          <ul className="field-hint">
            {grants
              .filter((item) => item.status !== 'active')
              .map((item) => (
                <li key={item.id}>
                  {new Date(item.createdAt).toLocaleDateString()} · {item.reason} · {item.status}
                </li>
              ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

export default SupportAccessPanel;
