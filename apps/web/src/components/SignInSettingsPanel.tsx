import { useEffect, useState, type FormEvent } from 'react';
import type { FirmSettings } from '@ahava88/shared';
import { api, apiErrorMessage } from '../api';
import DismissibleNotice, { type Notice } from './DismissibleNotice';

/** Administrators: the firm's own Microsoft 365 sign-in. */
function SignInSettingsPanel() {
  const [settings, setSettings] = useState<FirmSettings['microsoft'] | null>(null);
  const [form, setForm] = useState({ tenantId: '', domains: '', enforced: false });
  const [notice, setNotice] = useState<Notice>({ tone: 'info', message: '' });
  const [busy, setBusy] = useState(false);

  const apply = (microsoft: FirmSettings['microsoft']) => {
    setSettings(microsoft);
    setForm({
      tenantId: microsoft.tenantId ?? '',
      domains: microsoft.domains.join(', '),
      enforced: microsoft.enforced,
    });
  };

  useEffect(() => {
    api
      .get<FirmSettings>('/firm/settings')
      .then(({ data }) => apply(data.microsoft))
      .catch(() => undefined);
  }, []);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    try {
      const { data } = await api.patch<FirmSettings>('/firm/settings', {
        microsoft: {
          tenantId: form.tenantId.trim() || null,
          domains: form.domains
            .split(/[\s,]+/)
            .map((value) => value.trim())
            .filter(Boolean),
          enforced: form.enforced,
        },
      });
      apply(data.microsoft);
      setNotice({ tone: 'success', message: 'Sign-in settings saved.' });
    } catch (error) {
      setNotice({ tone: 'error', message: apiErrorMessage(error, 'Could not save.') });
    } finally {
      setBusy(false);
    }
  };

  if (!settings) {
    return null;
  }

  return (
    <div className="panel">
      <p className="panel-kicker">Sign-in</p>
      <h2>Microsoft 365</h2>
      <DismissibleNotice
        tone={notice.tone}
        message={notice.message}
        onDismiss={() => setNotice({ tone: 'info', message: '' })}
      />
      {!settings.available ? (
        <p className="field-hint">
          Microsoft 365 sign-in is not enabled on this platform yet. Contact platform support.
        </p>
      ) : (
        <>
          <p className="field-hint">
            Let staff sign in with their work Microsoft accounts. Your Microsoft 365 administrator
            first approves the app for your organisation
            {settings.adminConsentUrl ? (
              <>
                {' '}
                (
                <a href={settings.adminConsentUrl} target="_blank" rel="noreferrer">
                  approval link
                </a>
                )
              </>
            ) : null}
            . Existing staff are matched by their work address on the domains below; new people
            still need an invitation. Enforce MFA with Conditional Access in Microsoft Entra.
          </p>
          <form className="stack-form" onSubmit={save} aria-label="Microsoft 365 sign-in">
            <input
              placeholder="Directory (tenant) ID"
              aria-label="Directory (tenant) ID"
              value={form.tenantId}
              onChange={(event) =>
                setForm((current) => ({ ...current, tenantId: event.target.value }))
              }
            />
            <input
              placeholder="Work email domains, e.g. nkosilaw.co.za"
              aria-label="Work email domains"
              value={form.domains}
              onChange={(event) =>
                setForm((current) => ({ ...current, domains: event.target.value }))
              }
            />
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={form.enforced}
                onChange={(event) =>
                  setForm((current) => ({ ...current, enforced: event.target.checked }))
                }
              />
              Require Microsoft 365 sign-in (administrators keep a password for emergencies)
            </label>
            <button className="secondary-button" disabled={busy}>
              Save
            </button>
          </form>
        </>
      )}
    </div>
  );
}

export default SignInSettingsPanel;
