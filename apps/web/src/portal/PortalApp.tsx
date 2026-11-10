import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type {
  PortalDocument,
  PortalEnrolment,
  PortalInvoice,
  PortalMatter,
  PortalMe,
  PortalMessage,
} from '@ahava88/shared';
import { api, apiErrorMessage } from '../api';
import '../App.css';

const money = (cents: number) =>
  `R ${(cents / 100).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (value: string | null) =>
  value
    ? new Date(value).toLocaleDateString('en-ZA', {
        timeZone: 'Africa/Johannesburg',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      })
    : '';

function CodeForm({
  label,
  onSubmit,
}: {
  label: string;
  onSubmit: (code: string) => Promise<void>;
}) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    try {
      await onSubmit(code);
    } catch (err) {
      setError(apiErrorMessage(err, 'That did not work.'));
      setCode('');
    }
  };
  return (
    <form className="auth-form" onSubmit={submit}>
      <label>
        {label}
        <input
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{6}"
          maxLength={6}
          required
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
        />
      </label>
      {error ? <p className="field-hint notice-error">{error}</p> : null}
      <button type="submit" className="primary-button">
        Continue
      </button>
    </form>
  );
}

function Enrol({ token, onDone }: { token: string; onDone: (me: PortalMe) => void }) {
  const [enrolment, setEnrolment] = useState<PortalEnrolment | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api
      .post<PortalEnrolment>('/portal/invite/start', { token })
      .then(({ data }) => setEnrolment(data))
      .catch((err) =>
        setError(apiErrorMessage(err, 'This link has expired. Ask the firm for a new one.')),
      );
  }, [token]);
  if (error) return <p className="notice notice-error">{error}</p>;
  if (!enrolment) return <p aria-busy="true">Preparing…</p>;
  return (
    <div className="portal-card">
      <h2>Welcome{enrolment.name ? `, ${enrolment.name}` : ''}</h2>
      <p className="field-hint">
        Scan this code with an authenticator app (Microsoft Authenticator, Google Authenticator or
        similar). You will need the app each time you sign in.
      </p>
      <img className="mfa-qr" src={enrolment.qrCodeDataUrl} alt="Authenticator set-up QR code" />
      <details>
        <summary>Can&apos;t scan? Enter this key instead</summary>
        <code className="mfa-secret">{enrolment.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
      </details>
      <CodeForm
        label="6-digit code from the app"
        onSubmit={async (code) =>
          onDone((await api.post<PortalMe>('/portal/invite/complete', { token, code })).data)
        }
      />
    </div>
  );
}

function SignIn({ token, onDone }: { token: string | null; onDone: (me: PortalMe) => void }) {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  if (token) {
    return (
      <div className="portal-card">
        <h2>Sign in</h2>
        <CodeForm
          label="6-digit code from your authenticator app"
          onSubmit={async (code) =>
            onDone((await api.post<PortalMe>('/portal/sign-in/complete', { token, code })).data)
          }
        />
      </div>
    );
  }
  return (
    <div className="portal-card">
      <h2>Client portal</h2>
      {sent ? (
        <p className="notice notice-info">
          If that address has portal access, we have emailed a sign-in link. It works once, for 15
          minutes.
        </p>
      ) : (
        <form
          className="auth-form"
          onSubmit={async (e) => {
            e.preventDefault();
            await api.post('/portal/sign-in', { email });
            setSent(true);
          }}
        >
          <label>
            Email address
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <button type="submit" className="primary-button">
            Email me a sign-in link
          </button>
        </form>
      )}
    </div>
  );
}

function Messages({ matter }: { matter: PortalMatter }) {
  const [messages, setMessages] = useState<PortalMessage[]>([]);
  const [body, setBody] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    api
      .get<PortalMessage[]>(`/portal/matters/${matter.id}/messages`)
      .then(({ data }) => setMessages(data));
  }, [matter.id]);
  return (
    <div className="portal-messages">
      {messages.map((m) => (
        <p key={m.id} className={`portal-message portal-message-${m.from}`}>
          <strong>{m.senderName}</strong> <span className="field-hint">{day(m.sentAt)}</span>
          <br />
          {m.body}
        </p>
      ))}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            setMessages(
              (await api.post<PortalMessage[]>(`/portal/matters/${matter.id}/messages`, { body }))
                .data,
            );
            setBody('');
          } catch (err) {
            setError(apiErrorMessage(err, 'The message could not be sent.'));
          }
        }}
      >
        <label>
          Message to your attorney
          <textarea rows={3} required value={body} onChange={(e) => setBody(e.target.value)} />
        </label>
        {error ? <p className="field-hint notice-error">{error}</p> : null}
        <button type="submit" className="primary-button">
          Send
        </button>
      </form>
    </div>
  );
}

const FICA_LABEL: Record<string, string> = {
  id_document: 'Identity document',
  proof_of_address: 'Proof of address',
  company_registration: 'Company registration',
};

function Fica() {
  const [fica, setFica] = useState<{
    status: string;
    missing: string[];
    uploaded: Array<{ docType: string; uploadedAt: string }>;
  } | null>(null);
  const [docType, setDocType] = useState('id_document');
  const [error, setError] = useState('');
  const load = useCallback(() => api.get('/portal/fica').then(({ data }) => setFica(data)), []);
  useEffect(() => {
    load();
  }, [load]);
  const upload = async (file: File) => {
    setError('');
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    try {
      setFica(
        (
          await api.post('/portal/fica', {
            docType,
            fileName: file.name,
            contentType: file.type,
            dataBase64: data,
          })
        ).data,
      );
    } catch (err) {
      setError(apiErrorMessage(err, 'The file could not be uploaded.'));
    }
  };
  if (!fica) return null;
  return (
    <section className="portal-card">
      <h3>Identity documents (FICA)</h3>
      <p>
        {fica.status === 'verified'
          ? 'Your identity has been verified.'
          : fica.missing.length
            ? `Still needed: ${fica.missing.map((m) => FICA_LABEL[m] ?? m).join(', ')}.`
            : 'Thank you: the firm will check your documents.'}
      </p>
      {fica.status !== 'verified' ? (
        <div className="button-row">
          <select
            aria-label="Document type"
            value={docType}
            onChange={(e) => setDocType(e.target.value)}
          >
            {Object.entries(FICA_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <input
            type="file"
            aria-label="Upload a PDF, JPEG or PNG"
            accept="application/pdf,image/jpeg,image/png"
            onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
          />
        </div>
      ) : null}
      {error ? <p className="field-hint notice-error">{error}</p> : null}
    </section>
  );
}

function Home({ me, onSignOut }: { me: PortalMe; onSignOut: () => void }) {
  const [matters, setMatters] = useState<PortalMatter[]>([]);
  const [documents, setDocuments] = useState<PortalDocument[]>([]);
  const [invoices, setInvoices] = useState<PortalInvoice[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [reading, setReading] = useState<{ title: string; body: string } | null>(null);
  useEffect(() => {
    Promise.all([
      api.get<PortalMatter[]>('/portal/matters'),
      api.get<PortalDocument[]>('/portal/documents'),
      api.get<PortalInvoice[]>('/portal/invoices'),
    ]).then(([m, d, i]) => {
      setMatters(m.data);
      setDocuments(d.data);
      setInvoices(i.data);
    });
  }, []);
  return (
    <div className="portal-home">
      <header className="portal-header">
        <div>
          <p className="panel-kicker">{me.firmName}</p>
          <h1>Hello, {me.name}</h1>
        </div>
        <button type="button" className="secondary-button" onClick={onSignOut}>
          Sign out
        </button>
      </header>

      <section>
        <h2>Your matters</h2>
        {matters.map((matter) => (
          <article key={matter.id} className="portal-card">
            <h3>
              {matter.title} <span className="field-hint">{matter.caseNumber}</span>
            </h3>
            {matter.update ? (
              <p>
                {matter.update} <span className="field-hint">({day(matter.updatedAt)})</span>
              </p>
            ) : (
              <p className="field-hint">No update yet.</p>
            )}
            {matter.trustBalanceCents !== null ? (
              <p>Held in trust for this matter: {money(matter.trustBalanceCents)}</p>
            ) : null}
            <button
              type="button"
              className="link-button"
              onClick={() => setOpen(open === matter.id ? null : matter.id)}
            >
              Messages{matter.unreadMessages ? ` (${matter.unreadMessages} new)` : ''}
            </button>
            {open === matter.id ? <Messages matter={matter} /> : null}
          </article>
        ))}
      </section>

      <section>
        <h2>Documents</h2>
        {documents.length ? (
          <ul className="trust-list">
            {documents.map((doc) => (
              <li key={doc.id}>
                <span>
                  {doc.title}{' '}
                  <span className="field-hint">
                    {doc.caseNumber} · {day(doc.sharedAt)}
                  </span>
                </span>
                <button
                  type="button"
                  className="link-button"
                  onClick={async () =>
                    setReading((await api.get(`/portal/documents/${doc.id}`)).data)
                  }
                >
                  Read
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="field-hint">No documents have been shared with you yet.</p>
        )}
        {reading ? (
          <article className="portal-card">
            <h3>{reading.title}</h3>
            <p className="research-passage">{reading.body}</p>
            <button type="button" className="link-button" onClick={() => setReading(null)}>
              Close
            </button>
          </article>
        ) : null}
      </section>

      <section>
        <h2>Invoices</h2>
        {invoices.length ? (
          <table className="subscription-payments">
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Date</th>
                <th>Amount</th>
                <th>Paid</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.id}>
                  <td>{inv.invoiceNumber}</td>
                  <td>{inv.issuedOn ?? ''}</td>
                  <td>{money(inv.totalCents)}</td>
                  <td>{money(inv.paidCents)}</td>
                  <td>{inv.status === 'paid' ? 'Paid' : inv.paidCents ? 'Part paid' : 'Due'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="field-hint">No invoices.</p>
        )}
      </section>

      <Fica />
    </div>
  );
}

/** The client portal (/portal): its own sign-in, its own session. */
function PortalApp() {
  const params = new URLSearchParams(window.location.search);
  const invite = params.get('invite');
  const signInToken = params.get('signin');
  const [me, setMe] = useState<PortalMe | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (invite || signInToken) {
      setChecked(true);
      return;
    }
    api
      .get<PortalMe>('/portal/me')
      .then(({ data }) => setMe(data))
      .catch(() => setMe(null))
      .finally(() => setChecked(true));
  }, [invite, signInToken]);

  const signedIn = (next: PortalMe) => {
    window.history.replaceState(null, '', '/portal');
    setMe(next);
  };

  if (!checked) return <p aria-busy="true">Loading…</p>;
  return (
    <main className="portal-app">
      {me ? (
        <Home
          me={me}
          onSignOut={async () => {
            await api.post('/portal/sign-out');
            setMe(null);
          }}
        />
      ) : invite ? (
        <Enrol token={invite} onDone={signedIn} />
      ) : (
        <SignIn token={signInToken} onDone={signedIn} />
      )}
    </main>
  );
}

export default PortalApp;
