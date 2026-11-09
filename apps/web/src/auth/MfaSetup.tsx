import { useEffect, useState, type FormEvent } from 'react';
import type { MfaEnrollment, MfaEnrollmentResult, PublicUser } from '@ahava88/shared';
import { api, apiErrorMessage } from '../api';
import Field from '../components/Field';

interface MfaSetupProps {
  challengeToken: string;
  onDone: (user: PublicUser) => void;
  onError: (message: string) => void;
}

/** Connect an authenticator app, confirm a code, then show the recovery codes once. */
function MfaSetup({ challengeToken, onDone, onError }: MfaSetupProps) {
  const [enrollment, setEnrollment] = useState<MfaEnrollment | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<MfaEnrollmentResult | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api
      .post<MfaEnrollment>('/auth/mfa/enroll/start', { challengeToken })
      .then(({ data }) => setEnrollment(data))
      .catch((error: unknown) => onError(apiErrorMessage(error, 'Could not start set-up.')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [challengeToken]);

  const confirm = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    try {
      const { data } = await api.post<MfaEnrollmentResult>('/auth/mfa/enroll/confirm', {
        challengeToken,
        code,
      });
      setResult(data);
    } catch (error) {
      onError(apiErrorMessage(error, 'That code did not work.'));
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <div className="mfa-setup">
        <h2>Save your recovery codes</h2>
        <p className="field-hint">
          Each code signs you in once if you lose your phone. Store them somewhere safe, such as a
          password manager. They will not be shown again.
        </p>
        <ul className="recovery-codes" aria-label="Recovery codes">
          {result.recoveryCodes.map((value) => (
            <li key={value}>
              <code>{value}</code>
            </li>
          ))}
        </ul>
        <label className="checkbox-row">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />I
          have saved my recovery codes
        </label>
        <div className="action-row">
          <button
            type="button"
            className="primary-button"
            disabled={!saved}
            onClick={() => onDone(result.user)}
          >
            Open the workspace
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mfa-setup">
      <h2>Set up two-factor sign-in</h2>
      <p className="field-hint">
        Scan this code with an authenticator app (Microsoft Authenticator, Google Authenticator or
        similar), then enter the 6-digit code it shows.
      </p>
      {enrollment ? (
        <>
          <img
            className="mfa-qr"
            src={enrollment.qrCodeDataUrl}
            alt="Authenticator set-up QR code"
          />
          <details>
            <summary>Can't scan? Enter this key instead</summary>
            <code className="mfa-secret">{enrollment.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
          </details>
        </>
      ) : (
        <p aria-busy="true">Preparing…</p>
      )}
      <form className="auth-form" onSubmit={confirm}>
        <Field label="6-digit code" id="mfa-setup-code">
          <input
            id="mfa-setup-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
            required
          />
        </Field>
        <div className="action-row">
          <button type="submit" className="primary-button" disabled={busy || !enrollment}>
            {busy ? 'Checking…' : 'Confirm'}
          </button>
        </div>
      </form>
    </div>
  );
}

export default MfaSetup;
