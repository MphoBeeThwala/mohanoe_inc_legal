import React, { useState } from 'react';

const defaultState = {
  fullName: '',
  email: '',
  phone: '',
  practiceArea: 'Family Law',
  jurisdiction: 'Gauteng Division, Johannesburg',
  urgencyHint: 'medium',
  matterSummary: '',
  requestedOutcome: '',
  documentsMentioned: '',
  preferredLanguage: 'English',
  consentToStorage: true,
  consentToAi: true,
};

function IntakeForm({ onSubmit, busy, sampleMatter }) {
  const [form, setForm] = useState(defaultState);
  const [status, setStatus] = useState(null);

  const updateField = (name, value) => {
    setForm((current) => ({ ...current, [name]: value }));
  };

  const loadSample = () => {
    setForm({ ...defaultState, ...sampleMatter });
    setStatus({
      tone: 'info',
      message: 'Sample matter loaded. Review the redaction note before sending.',
    });
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    const success = await onSubmit(form);
    if (success) {
      setForm(defaultState);
      setStatus({
        tone: 'success',
        message: 'Encrypted intake submitted and assessment completed.',
      });
    }
  };

  return (
    <form className="intake-form" onSubmit={handleSubmit}>
      <div className="grid-2">
        <Field label="Client name">
          <input
            value={form.fullName}
            onChange={(event) => updateField('fullName', event.target.value)}
            placeholder="Thandi Nkosi"
            required
          />
        </Field>
        <Field label="Email">
          <input
            type="email"
            value={form.email}
            onChange={(event) => updateField('email', event.target.value)}
            placeholder="client@example.com"
            required
          />
        </Field>
        <Field label="Phone">
          <input
            value={form.phone}
            onChange={(event) => updateField('phone', event.target.value)}
            placeholder="+27821234567"
            required
          />
        </Field>
        <Field label="Practice area">
          <select
            value={form.practiceArea}
            onChange={(event) => updateField('practiceArea', event.target.value)}
          >
            <option>Family Law</option>
            <option>Labour Law</option>
            <option>Conveyancing</option>
            <option>Commercial</option>
            <option>Estate Administration</option>
            <option>Criminal Defence</option>
          </select>
        </Field>
        <Field label="Jurisdiction">
          <input
            value={form.jurisdiction}
            onChange={(event) =>
              updateField('jurisdiction', event.target.value)
            }
            placeholder="Gauteng Division, Johannesburg"
          />
        </Field>
        <Field label="Urgency">
          <select
            value={form.urgencyHint}
            onChange={(event) => updateField('urgencyHint', event.target.value)}
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
          </select>
        </Field>
      </div>

      <Field
        label="Matter summary"
        hint="Do not paste ID numbers, bank details, or unnecessary personal data into this box."
      >
        <textarea
          rows={6}
          value={form.matterSummary}
          onChange={(event) => updateField('matterSummary', event.target.value)}
          placeholder="Describe the dispute, deadlines, and what outcome the client wants."
          required
        />
      </Field>

      <Field label="Requested outcome">
        <input
          value={form.requestedOutcome}
          onChange={(event) =>
            updateField('requestedOutcome', event.target.value)
          }
          placeholder="Urgent interdict, settlement draft, summons, estate guidance..."
        />
      </Field>

      <div className="grid-2">
        <Field label="Documents mentioned">
          <textarea
            rows={4}
            value={form.documentsMentioned}
            onChange={(event) =>
              updateField('documentsMentioned', event.target.value)
            }
            placeholder="Notices, contracts, WhatsApp messages, court papers..."
          />
        </Field>
        <Field label="Preferred language">
          <select
            value={form.preferredLanguage}
            onChange={(event) =>
              updateField('preferredLanguage', event.target.value)
            }
          >
            <option>English</option>
            <option>isiZulu</option>
            <option>isiXhosa</option>
            <option>Sesotho</option>
            <option>Afrikaans</option>
          </select>
        </Field>
      </div>

      <div className="consent-stack">
        <label className="consent-row">
          <input
            type="checkbox"
            checked={form.consentToStorage}
            onChange={(event) =>
              updateField('consentToStorage', event.target.checked)
            }
          />
          <span>Consent to encrypted storage of the client record</span>
        </label>
        <label className="consent-row">
          <input
            type="checkbox"
            checked={form.consentToAi}
            onChange={(event) => updateField('consentToAi', event.target.checked)}
          />
          <span>Consent to server-side AI assessment of the redacted brief</span>
        </label>
      </div>

      <div className="action-row">
        <button type="button" className="secondary-button" onClick={loadSample}>
          Load sample matter
        </button>
        <button type="submit" className="primary-button" disabled={busy}>
          {busy ? 'Processing...' : 'Submit and assess'}
        </button>
      </div>

      {status ? (
        <div className={`inline-status inline-${status.tone}`}>
          {status.message}
        </div>
      ) : null}
    </form>
  );
}

function Field({ label, hint, children }) {
  return (
    <label className="field">
      <div className="field-label">{label}</div>
      {hint ? <div className="field-hint">{hint}</div> : null}
      {children}
    </label>
  );
}

export default IntakeForm;
