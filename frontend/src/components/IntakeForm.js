import React, { useRef, useState } from 'react';

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

function IntakeForm({ onSubmit, busy, sampleMatter, onGoToCases }) {
  const [form, setForm] = useState(defaultState);
  const [status, setStatus] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

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
    if (busy || submitting || submittingRef.current) {
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    try {
      const success = await onSubmit(form);
      if (success) {
        setForm(defaultState);
        setStatus({
          tone: 'success',
          message: 'Encrypted intake submitted and assessment completed.',
        });
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const isDisabled = busy || submitting;

  return (
    <form className="intake-form" onSubmit={handleSubmit} noValidate={false}>
      <div className="grid-2">
        <Field label="Client name" id="intake-fullName">
          <input
            id="intake-fullName"
            name="fullName"
            autoComplete="name"
            value={form.fullName}
            onChange={(event) => updateField('fullName', event.target.value)}
            placeholder="Thandi Nkosi"
            required
            disabled={isDisabled}
          />
        </Field>
        <Field label="Email" id="intake-email">
          <input
            id="intake-email"
            name="email"
            type="email"
            autoComplete="email"
            value={form.email}
            onChange={(event) => updateField('email', event.target.value)}
            placeholder="client@example.com"
            required
            disabled={isDisabled}
          />
        </Field>
        <Field label="Phone" id="intake-phone">
          <input
            id="intake-phone"
            name="phone"
            type="tel"
            autoComplete="tel"
            value={form.phone}
            onChange={(event) => updateField('phone', event.target.value)}
            placeholder="+27821234567"
            required
            disabled={isDisabled}
          />
        </Field>
        <Field label="Practice area" id="intake-practiceArea">
          <select
            id="intake-practiceArea"
            name="practiceArea"
            value={form.practiceArea}
            onChange={(event) => updateField('practiceArea', event.target.value)}
            disabled={isDisabled}
          >
            <option>Family Law</option>
            <option>Labour Law</option>
            <option>Conveyancing</option>
            <option>Commercial</option>
            <option>Estate Administration</option>
            <option>Criminal Defence</option>
          </select>
        </Field>
        <Field label="Jurisdiction" id="intake-jurisdiction">
          <input
            id="intake-jurisdiction"
            name="jurisdiction"
            value={form.jurisdiction}
            onChange={(event) =>
              updateField('jurisdiction', event.target.value)
            }
            placeholder="Gauteng Division, Johannesburg"
            disabled={isDisabled}
          />
        </Field>
        <Field label="Urgency" id="intake-urgency">
          <select
            id="intake-urgency"
            name="urgencyHint"
            value={form.urgencyHint}
            onChange={(event) => updateField('urgencyHint', event.target.value)}
            disabled={isDisabled}
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
        id="intake-matterSummary"
        hint="Do not paste ID numbers, bank details, or unnecessary personal data into this box."
      >
        <textarea
          id="intake-matterSummary"
          name="matterSummary"
          rows={6}
          value={form.matterSummary}
          onChange={(event) => updateField('matterSummary', event.target.value)}
          placeholder="Describe the dispute, deadlines, and what outcome the client wants."
          required
          disabled={isDisabled}
        />
      </Field>

      <Field label="Requested outcome" id="intake-requestedOutcome">
        <input
          id="intake-requestedOutcome"
          name="requestedOutcome"
          value={form.requestedOutcome}
          onChange={(event) =>
            updateField('requestedOutcome', event.target.value)
          }
          placeholder="Urgent interdict, settlement draft, summons, estate guidance..."
          disabled={isDisabled}
        />
      </Field>

      <div className="grid-2">
        <Field label="Documents mentioned" id="intake-documents">
          <textarea
            id="intake-documents"
            name="documentsMentioned"
            rows={4}
            value={form.documentsMentioned}
            onChange={(event) =>
              updateField('documentsMentioned', event.target.value)
            }
            placeholder="Notices, contracts, WhatsApp messages, court papers..."
            disabled={isDisabled}
          />
        </Field>
        <Field label="Preferred language" id="intake-language">
          <select
            id="intake-language"
            name="preferredLanguage"
            value={form.preferredLanguage}
            onChange={(event) =>
              updateField('preferredLanguage', event.target.value)
            }
            disabled={isDisabled}
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
        <label className="consent-row" htmlFor="intake-consent-storage">
          <input
            id="intake-consent-storage"
            type="checkbox"
            checked={form.consentToStorage}
            onChange={(event) =>
              updateField('consentToStorage', event.target.checked)
            }
            disabled={isDisabled}
          />
          <span>Consent to encrypted storage of the client record</span>
        </label>
        <label className="consent-row" htmlFor="intake-consent-ai">
          <input
            id="intake-consent-ai"
            type="checkbox"
            checked={form.consentToAi}
            onChange={(event) => updateField('consentToAi', event.target.checked)}
            disabled={isDisabled}
          />
          <span>Consent to server-side AI assessment of the redacted brief</span>
        </label>
      </div>

      <div className="action-row">
        <button
          type="button"
          className="secondary-button"
          onClick={loadSample}
          disabled={isDisabled}
        >
          Load sample matter
        </button>
        <button type="submit" className="primary-button" disabled={isDisabled}>
          {isDisabled ? 'Processing...' : 'Submit and assess'}
        </button>
      </div>

      {status ? (
        <div className={`inline-status inline-${status.tone}`} role="status">
          {status.message}
          {status.tone === 'success' && onGoToCases ? (
            <>
              {' '}
              <button type="button" className="link-button" onClick={onGoToCases}>
                View cases
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}

function Field({ label, hint, id, children }) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      {hint ? <div className="field-hint">{hint}</div> : null}
      {children}
    </div>
  );
}

export default IntakeForm;
