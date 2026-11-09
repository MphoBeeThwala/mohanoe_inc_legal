import { useEffect, useState, type FormEvent } from 'react';
import type { AuditTrailVerification, FirmSettings } from '@ahava88/shared';
import { api, apiErrorMessage } from '../api';
import DismissibleNotice, { type Notice } from './DismissibleNotice';

/** Administrators: retention period and audit-trail verification. */
function RecordsPanel() {
  const [settings, setSettings] = useState<FirmSettings | null>(null);
  const [years, setYears] = useState('');
  const [verification, setVerification] = useState<AuditTrailVerification | null>(null);
  const [notice, setNotice] = useState<Notice>({ tone: 'info', message: '' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<FirmSettings>('/firm/settings')
      .then(({ data }) => {
        setSettings(data);
        setYears(String(Math.round((data.retentionDays / 365) * 10) / 10));
      })
      .catch(() => undefined);
  }, []);

  const saveRetention = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    try {
      const { data } = await api.patch<FirmSettings>('/firm/settings', {
        retentionDays: Math.round(Number(years) * 365),
      });
      setSettings(data);
      setNotice({ tone: 'success', message: 'Retention period saved.' });
    } catch (error) {
      setNotice({ tone: 'error', message: apiErrorMessage(error, 'Could not save.') });
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setBusy(true);
    try {
      const { data } = await api.get<AuditTrailVerification>('/audit/verify');
      setVerification(data);
    } catch (error) {
      setNotice({ tone: 'error', message: apiErrorMessage(error, 'Verification failed.') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <p className="panel-kicker">Records</p>
      <h2>Retention and audit trail</h2>
      <DismissibleNotice
        tone={notice.tone}
        message={notice.message}
        onDismiss={() => setNotice({ tone: 'info', message: '' })}
      />

      <form className="inline-form" onSubmit={saveRetention} aria-label="Retention period">
        <label className="checkbox-row" htmlFor="retention-years">
          Keep closed matters for
        </label>
        <input
          id="retention-years"
          type="number"
          min={1}
          max={100}
          step={0.5}
          value={years}
          onChange={(event) => setYears(event.target.value)}
          required
        />
        <span className="checkbox-row">years</span>
        <button className="secondary-button" disabled={busy || !settings}>
          Save
        </button>
      </form>
      <p className="field-hint">
        {settings?.retentionIsDefault ? 'Platform default. ' : ''}After this period, the retention
        sweep permanently deletes closed matters and everything attached to them.
      </p>

      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={Boolean(settings?.ficaEnforced)}
          disabled={busy || !settings}
          onChange={async (event) => {
            setBusy(true);
            try {
              const { data } = await api.patch<FirmSettings>('/firm/settings', {
                ficaEnforced: event.target.checked,
              });
              setSettings(data);
            } catch (error) {
              setNotice({ tone: 'error', message: apiErrorMessage(error, 'Could not save.') });
            } finally {
              setBusy(false);
            }
          }}
        />
        Open new matters only for FICA-verified clients
      </label>

      <div className="action-row">
        <button type="button" className="secondary-button" disabled={busy} onClick={verify}>
          Verify audit trail
        </button>
      </div>
      {verification ? (
        <div
          className={`notice ${verification.trustworthy ? 'notice-success' : 'notice-error'}`}
          role="status"
        >
          {verification.trustworthy
            ? `Intact: ${verification.count} events, ${verification.anchors.checked} anchor(s) checked${
                verification.anchors.lastAnchoredAt
                  ? `, last anchored ${new Date(verification.anchors.lastAnchoredAt).toLocaleString()}`
                  : ''
              }.`
            : 'The audit trail does not verify. Contact platform support.'}
          {!verification.valid ? (
            <div className="field-hint">
              The hash chain breaks at event {verification.brokenAt}.
            </div>
          ) : null}
          {verification.anchors.problems.map((problem) => (
            <div key={problem} className="field-hint">
              {problem}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default RecordsPanel;
