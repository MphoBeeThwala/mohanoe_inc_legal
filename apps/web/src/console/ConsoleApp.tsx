// The platform operators' console. Served on the console host only (the API
// answers 404 anywhere else). Shows firm metadata and counts, never client data.
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type {
  ConsoleTicket,
  ConsoleTicketSummary,
  HelpArticle,
  ConsolePlatformInvoice,
  ConsoleAuditEntry,
  ConsoleFirm,
  ConsoleFirmInput,
  ConsoleOperator,
} from '@ahava88/shared';
import { api, apiErrorMessage, apiStatus } from '../api';
import { HelpText } from '../components/HelpPanel';
import '../App.css';

interface Plan {
  code: string;
  name: string;
  monthlySeatPriceCents: number;
  annualSeatPriceCents: number;
  isActive: boolean;
}
interface Source {
  code: string;
  name: string;
  kind: string;
  licence: string;
  status: string;
  approvedBy: string;
}
interface CourtOnlineCourt {
  division: string;
  since: string;
  source: string;
}

const rand = (cents: number) =>
  `R ${(cents / 100).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (value: string | null) =>
  value
    ? new Date(value).toLocaleString('en-ZA', {
        timeZone: 'Africa/Johannesburg',
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : '—';

function SignIn({ onDone }: { onDone: (me: ConsoleOperator) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    try {
      const { data } = await api.post<ConsoleOperator>('/platform/sign-in', {
        email,
        password,
        code,
      });
      onDone(data);
    } catch (err) {
      setError(apiErrorMessage(err, 'Those details did not work.'));
      setCode('');
    }
  };
  return (
    <form className="auth-form" onSubmit={submit} aria-label="Operator sign-in">
      <h1>Platform console</h1>
      <label>
        Email
        <input
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>
      <label>
        Password
        <input
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      <label>
        Authenticator code
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
        Sign in
      </button>
    </form>
  );
}

function NewFirm({ onCreated }: { onCreated: () => void }) {
  const empty: ConsoleFirmInput = {
    slug: '',
    legalName: '',
    tradingName: '',
    domains: [],
    adminEmail: '',
    adminName: '',
  };
  const [form, setForm] = useState(empty);
  const [domains, setDomains] = useState('');
  const [message, setMessage] = useState('');
  const set = (key: keyof ConsoleFirmInput) => (e: { target: { value: string } }) =>
    setForm({ ...form, [key]: e.target.value });
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage('');
    try {
      await api.post('/platform/firms', {
        ...form,
        tradingName: form.tradingName || undefined,
        domains: domains
          .split(/[\s,]+/)
          .map((d) => d.trim())
          .filter(Boolean),
      });
      setMessage(`Created ${form.slug}; an invitation went to ${form.adminEmail}.`);
      setForm(empty);
      setDomains('');
      onCreated();
    } catch (err) {
      setMessage(apiErrorMessage(err, 'The firm could not be created.'));
    }
  };
  return (
    <form className="panel-form" onSubmit={submit} aria-label="New firm">
      <h3>New firm</h3>
      <label>
        Short name (slug)
        <input required value={form.slug} onChange={set('slug')} />
      </label>
      <label>
        Legal name
        <input required value={form.legalName} onChange={set('legalName')} />
      </label>
      <label>
        Trading name
        <input value={form.tradingName} onChange={set('tradingName')} />
      </label>
      <label>
        Domains (comma separated)
        <input value={domains} onChange={(e) => setDomains(e.target.value)} />
      </label>
      <label>
        First administrator’s name
        <input required value={form.adminName} onChange={set('adminName')} />
      </label>
      <label>
        First administrator’s email
        <input type="email" required value={form.adminEmail} onChange={set('adminEmail')} />
      </label>
      <button type="submit" className="primary-button">
        Create and invite
      </button>
      {message ? <p className="field-hint">{message}</p> : null}
    </form>
  );
}

function Firms({ admin }: { admin: boolean }) {
  const [firms, setFirms] = useState<ConsoleFirm[]>([]);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    api
      .get<ConsoleFirm[]>('/platform/firms')
      .then(({ data }) => setFirms(data))
      .catch((err) => setError(apiErrorMessage(err, 'Firms could not be loaded.')));
  }, []);
  useEffect(load, [load]);
  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
      load();
    } catch (err) {
      setError(apiErrorMessage(err, 'That change did not go through.'));
    }
  };
  const comp = (firm: ConsoleFirm) => {
    const until = window.prompt('Complimentary until (YYYY-MM-DD, empty for no end date)', '');
    if (until === null) return;
    void act(() =>
      api.post(`/platform/firms/${firm.id}/complimentary`, { until: until.trim() || null }),
    );
  };
  return (
    <section aria-label="Firms">
      <h2>Firms</h2>
      {error ? <p className="notice notice-error">{error}</p> : null}
      <table className="data-table">
        <thead>
          <tr>
            <th>Firm</th>
            <th>Status</th>
            <th>Subscription</th>
            <th>Staff</th>
            <th>Matters</th>
            <th>AI tokens (month)</th>
            <th>Trust</th>
            {admin ? <th>Actions</th> : null}
          </tr>
        </thead>
        <tbody>
          {firms.map((firm) => (
            <tr key={firm.id}>
              <td>
                <strong>{firm.tradingName || firm.legalName}</strong>
                <br />
                <small>
                  {firm.slug}
                  {firm.domains.length ? ` · ${firm.domains.join(', ')}` : ''}
                </small>
              </td>
              <td>{firm.status}</td>
              <td>
                {firm.subscription.effectiveStatus}
                {firm.subscription.planCode ? ` · ${firm.subscription.planCode}` : ''}
                {firm.subscription.seats ? ` · ${firm.subscription.seats} seats` : ''}
                <br />
                <small>paid through {when(firm.subscription.paidThrough)}</small>
              </td>
              <td>{firm.staff}</td>
              <td>{firm.matters}</td>
              <td>{firm.aiTokensThisMonth.toLocaleString('en-ZA')}</td>
              <td>{firm.features.trustAccounting ? 'On' : 'Off'}</td>
              {admin ? (
                <td className="row-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() =>
                      act(() =>
                        api.patch(`/platform/firms/${firm.id}`, {
                          trustAccounting: !firm.features.trustAccounting,
                        }),
                      )
                    }
                  >
                    {firm.features.trustAccounting ? 'Turn trust off' : 'Turn trust on'}
                  </button>
                  <button type="button" className="secondary-button" onClick={() => comp(firm)}>
                    Complimentary
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      const next = firm.status === 'active' ? 'suspended' : 'active';
                      if (
                        next === 'active' ||
                        window.confirm(`Suspend ${firm.slug}? Its staff will be unable to sign in.`)
                      )
                        void act(() => api.patch(`/platform/firms/${firm.id}`, { status: next }));
                    }}
                  >
                    {firm.status === 'active' ? 'Suspend' : 'Reactivate'}
                  </button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
      {admin ? <NewFirm onCreated={load} /> : null}
    </section>
  );
}

function Plans({ admin }: { admin: boolean }) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [form, setForm] = useState({ code: '', name: '', monthly: '', annual: '' });
  const [error, setError] = useState('');
  const load = useCallback(() => {
    api.get<Plan[]>('/platform/plans').then(({ data }) => setPlans(data));
  }, []);
  useEffect(load, [load]);
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    try {
      await api.put('/platform/plans', {
        code: form.code,
        name: form.name,
        monthlySeatPriceCents: Math.round(Number(form.monthly) * 100),
        annualSeatPriceCents: Math.round(Number(form.annual) * 100),
      });
      setForm({ code: '', name: '', monthly: '', annual: '' });
      load();
    } catch (err) {
      setError(apiErrorMessage(err, 'The plan could not be saved.'));
    }
  };
  return (
    <section aria-label="Plans">
      <h2>Plans</h2>
      <p className="field-hint">Prices per seat, excluding VAT.</p>
      <table className="data-table">
        <thead>
          <tr>
            <th>Plan</th>
            <th>Monthly</th>
            <th>Annual</th>
            <th>Offered</th>
            {admin ? <th /> : null}
          </tr>
        </thead>
        <tbody>
          {plans.map((plan) => (
            <tr key={plan.code}>
              <td>
                {plan.name} <small>({plan.code})</small>
              </td>
              <td>{rand(plan.monthlySeatPriceCents)}</td>
              <td>{rand(plan.annualSeatPriceCents)}</td>
              <td>{plan.isActive ? 'Yes' : 'Retired'}</td>
              {admin ? (
                <td>
                  {plan.isActive ? (
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() =>
                        api
                          .post(`/platform/plans/${plan.code}/retire`)
                          .then(load, (err) =>
                            setError(apiErrorMessage(err, 'The plan could not be retired.')),
                          )
                      }
                    >
                      Retire
                    </button>
                  ) : null}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
      {error ? <p className="notice notice-error">{error}</p> : null}
      {admin ? (
        <form className="panel-form" onSubmit={save} aria-label="Save plan">
          <h3>Add or change a plan</h3>
          <label>
            Code
            <input
              required
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
            />
          </label>
          <label>
            Name
            <input
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label>
            Monthly per seat (R)
            <input
              required
              inputMode="decimal"
              value={form.monthly}
              onChange={(e) => setForm({ ...form, monthly: e.target.value })}
            />
          </label>
          <label>
            Annual per seat (R)
            <input
              required
              inputMode="decimal"
              value={form.annual}
              onChange={(e) => setForm({ ...form, annual: e.target.value })}
            />
          </label>
          <button type="submit" className="primary-button">
            Save plan
          </button>
        </form>
      ) : null}
    </section>
  );
}

function Sources({ admin }: { admin: boolean }) {
  const [sources, setSources] = useState<Source[]>([]);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    api.get<Source[]>('/platform/sources').then(({ data }) => setSources(data));
  }, []);
  useEffect(load, [load]);
  return (
    <section aria-label="Research sources">
      <h2>Research sources</h2>
      <p className="field-hint">
        Only approved sources are searched. Add new sources with <code>ops sources</code> once the
        licence or written permission is on file.
      </p>
      {error ? <p className="notice notice-error">{error}</p> : null}
      <table className="data-table">
        <thead>
          <tr>
            <th>Source</th>
            <th>Kind</th>
            <th>Licence</th>
            <th>Approved by</th>
            <th>Status</th>
            {admin ? <th /> : null}
          </tr>
        </thead>
        <tbody>
          {sources.map((source) => (
            <tr key={source.code}>
              <td>
                {source.name} <small>({source.code})</small>
              </td>
              <td>{source.kind}</td>
              <td>{source.licence}</td>
              <td>{source.approvedBy}</td>
              <td>{source.status}</td>
              {admin ? (
                <td>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() =>
                      api
                        .post(`/platform/sources/${source.code}/status`, {
                          status: source.status === 'approved' ? 'suspended' : 'approved',
                        })
                        .then(load, (err) =>
                          setError(apiErrorMessage(err, 'The source could not be changed.')),
                        )
                    }
                  >
                    {source.status === 'approved' ? 'Suspend' : 'Approve'}
                  </button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function CourtOnline({ admin }: { admin: boolean }) {
  const [courts, setCourts] = useState<CourtOnlineCourt[]>([]);
  const [form, setForm] = useState({ division: '', since: '', source: '' });
  const [error, setError] = useState('');
  const load = useCallback(() => {
    api.get<CourtOnlineCourt[]>('/platform/court-online').then(({ data }) => setCourts(data));
  }, []);
  useEffect(load, [load]);
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    try {
      await api.put('/platform/court-online', form);
      setForm({ division: '', since: '', source: '' });
      load();
    } catch (err) {
      setError(apiErrorMessage(err, 'The court could not be saved.'));
    }
  };
  return (
    <section aria-label="Court Online courts">
      <h2>Courts on Court Online</h2>
      <table className="data-table">
        <thead>
          <tr>
            <th>Division</th>
            <th>Since</th>
            <th>Source</th>
            {admin ? <th /> : null}
          </tr>
        </thead>
        <tbody>
          {courts.map((court) => (
            <tr key={court.division}>
              <td>{court.division}</td>
              <td>{court.since}</td>
              <td>{court.source}</td>
              {admin ? (
                <td>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() =>
                      api
                        .delete(`/platform/court-online/${court.division}`)
                        .then(load, (err) =>
                          setError(apiErrorMessage(err, 'The court could not be removed.')),
                        )
                    }
                  >
                    Remove
                  </button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
      {error ? <p className="notice notice-error">{error}</p> : null}
      {admin ? (
        <form className="panel-form" onSubmit={save} aria-label="Add court">
          <label>
            Division code
            <input
              required
              value={form.division}
              onChange={(e) => setForm({ ...form, division: e.target.value.toUpperCase() })}
            />
          </label>
          <label>
            Since
            <input
              type="date"
              required
              value={form.since}
              onChange={(e) => setForm({ ...form, since: e.target.value })}
            />
          </label>
          <label>
            Source (directive or notice)
            <input
              required
              value={form.source}
              onChange={(e) => setForm({ ...form, source: e.target.value })}
            />
          </label>
          <button type="submit" className="primary-button">
            Add court
          </button>
        </form>
      ) : null}
    </section>
  );
}

function Tickets() {
  const [filter, setFilter] = useState<'' | 'open' | 'answered' | 'closed'>('');
  const [tickets, setTickets] = useState<ConsoleTicketSummary[]>([]);
  const [open, setOpen] = useState<ConsoleTicket | null>(null);
  const [reply, setReply] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(() => {
    api
      .get<ConsoleTicketSummary[]>('/platform/tickets', {
        params: filter ? { status: filter } : {},
      })
      .then(({ data }) => setTickets(data))
      .catch((err) => setError(apiErrorMessage(err, 'Requests could not be loaded.')));
  }, [filter]);
  useEffect(load, [load]);
  const show = (firmId: string, id: string) =>
    api
      .get<ConsoleTicket>(`/platform/tickets/${firmId}/${id}`)
      .then(({ data }) => setOpen(data))
      .catch((err) => setError(apiErrorMessage(err, 'The request could not be loaded.')));
  useEffect(() => {
    // Links from the support mailbox: /console#ticket-<firm>-<ticket>
    const match = /^#ticket-([0-9a-f-]{36})-([0-9a-f-]{36})$/.exec(window.location.hash);
    if (match) void show(match[1]!, match[2]!);
  }, []);
  const act = async (fn: () => Promise<{ data: ConsoleTicket }>) => {
    setError('');
    try {
      const { data } = await fn();
      setOpen(data);
      setReply('');
      load();
    } catch (err) {
      setError(apiErrorMessage(err, 'That did not go through.'));
    }
  };
  return (
    <section aria-label="Support requests">
      <h2>Support requests</h2>
      <label>
        Show{' '}
        <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
          <option value="">Not closed</option>
          <option value="open">Waiting on support</option>
          <option value="answered">Waiting on the firm</option>
          <option value="closed">Closed</option>
        </select>
      </label>
      {error ? <p className="notice notice-error">{error}</p> : null}
      <table className="data-table">
        <thead>
          <tr>
            <th>Request</th>
            <th>Firm</th>
            <th>Kind</th>
            <th>Status</th>
            <th>Last message</th>
          </tr>
        </thead>
        <tbody>
          {tickets.map((t) => (
            <tr key={`${t.firmId}-${t.id}`}>
              <td>
                <button type="button" className="link-button" onClick={() => show(t.firmId, t.id)}>
                  {t.priority === 'urgent' ? '⚠ ' : ''}
                  {t.number}: {t.subject}
                </button>
              </td>
              <td>{t.firmSlug}</td>
              <td>{t.category}</td>
              <td>{t.status}</td>
              <td>{when(t.lastMessageAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {open ? (
        <article className="ticket" aria-label={`Request ${open.number}`}>
          <h3>
            {open.firmSlug} {open.number}: {open.subject}
          </h3>
          <ol className="ticket-messages">
            {open.messages.map((m) => (
              <li key={m.id} className={`ticket-message ticket-${m.author}`}>
                <strong>{m.name}</strong> <small>{when(m.createdAt)}</small>
                <p>{m.body}</p>
              </li>
            ))}
          </ol>
          <form
            className="panel-form"
            onSubmit={(event) => {
              event.preventDefault();
              void act(() =>
                api.post(`/platform/tickets/${open.firmId}/${open.id}/messages`, { body: reply }),
              );
            }}
          >
            <label>
              Reply to the firm
              <textarea
                required
                rows={4}
                value={reply}
                onChange={(e) => setReply(e.target.value)}
              />
            </label>
            <div className="row-actions">
              <button type="submit" className="primary-button">
                Send reply
              </button>
              {open.status !== 'closed' ? (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() =>
                    act(() =>
                      api.post(`/platform/tickets/${open.firmId}/${open.id}/status`, {
                        status: 'closed',
                      }),
                    )
                  }
                >
                  Close
                </button>
              ) : null}
            </div>
          </form>
        </article>
      ) : null}
    </section>
  );
}

function Articles({ admin }: { admin: boolean }) {
  const blank = { slug: '', title: '', category: '', body: '', published: true, sortOrder: 0 };
  const [articles, setArticles] = useState<HelpArticle[]>([]);
  const [form, setForm] = useState(blank);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    api.get<HelpArticle[]>('/platform/articles').then(({ data }) => setArticles(data));
  }, []);
  useEffect(load, [load]);
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    try {
      await api.put('/platform/articles', form);
      setForm(blank);
      load();
    } catch (err) {
      setError(apiErrorMessage(err, 'The article could not be saved.'));
    }
  };
  return (
    <section aria-label="Help articles">
      <h2>Help articles</h2>
      <table className="data-table">
        <thead>
          <tr>
            <th>Article</th>
            <th>Category</th>
            <th>Published</th>
            {admin ? <th /> : null}
          </tr>
        </thead>
        <tbody>
          {articles.map((a) => (
            <tr key={a.slug}>
              <td>
                {a.title} <small>({a.slug})</small>
              </td>
              <td>{a.category}</td>
              <td>{a.published ? 'Yes' : 'No'}</td>
              {admin ? (
                <td>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() =>
                      setForm({
                        slug: a.slug,
                        title: a.title,
                        category: a.category,
                        body: a.body,
                        published: a.published,
                        sortOrder: a.sortOrder,
                      })
                    }
                  >
                    Edit
                  </button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
      {error ? <p className="notice notice-error">{error}</p> : null}
      {admin ? (
        <form className="panel-form" onSubmit={save} aria-label="Save article">
          <h3>
            {form.slug && articles.some((a) => a.slug === form.slug) ? 'Edit' : 'New'} article
          </h3>
          <label>
            Slug
            <input
              required
              value={form.slug}
              onChange={(e) => setForm({ ...form, slug: e.target.value })}
            />
          </label>
          <label>
            Title
            <input
              required
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </label>
          <label>
            Category
            <input
              required
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
            />
          </label>
          <label>
            Text (# heading, - list item, blank line between paragraphs)
            <textarea
              required
              rows={10}
              value={form.body}
              onChange={(e) => setForm({ ...form, body: e.target.value })}
            />
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={form.published}
              onChange={(e) => setForm({ ...form, published: e.target.checked })}
            />
            Published
          </label>
          <button type="submit" className="primary-button">
            Save article
          </button>
          {form.body ? (
            <div aria-label="Preview">
              <h4>Preview</h4>
              <HelpText body={form.body} />
            </div>
          ) : null}
        </form>
      ) : null}
    </section>
  );
}

function Invoices() {
  const [invoices, setInvoices] = useState<ConsolePlatformInvoice[]>([]);
  useEffect(() => {
    api.get<ConsolePlatformInvoice[]>('/platform/invoices').then(({ data }) => setInvoices(data));
  }, []);
  const total = invoices.reduce((sum, i) => sum + i.totalCents, 0);
  const vat = invoices.reduce((sum, i) => sum + i.vatCents, 0);
  return (
    <section aria-label="Invoices to firms">
      <h2>Invoices to firms</h2>
      <p className="field-hint">
        One for each subscription payment PayFast confirmed. Listed: {rand(total)} including{' '}
        {rand(vat)} VAT.
      </p>
      <table className="data-table">
        <thead>
          <tr>
            <th>Invoice</th>
            <th>Firm</th>
            <th>Date</th>
            <th>Excl. VAT</th>
            <th>VAT</th>
            <th>Total</th>
            <th>PayFast reference</th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((i) => (
            <tr key={i.id}>
              <td>
                <a
                  href={`/api/platform/invoices/${i.firmId}/${i.id}/pdf`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {i.number}
                </a>
                {i.taxInvoice ? '' : ' (no VAT)'}
              </td>
              <td>{i.firmSlug}</td>
              <td>{i.issuedAt.slice(0, 10)}</td>
              <td>{rand(i.exclusiveCents)}</td>
              <td>{rand(i.vatCents)}</td>
              <td>{rand(i.totalCents)}</td>
              <td>{i.paymentReference}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Audit() {
  const [entries, setEntries] = useState<ConsoleAuditEntry[]>([]);
  useEffect(() => {
    api.get<ConsoleAuditEntry[]>('/platform/audit').then(({ data }) => setEntries(data));
  }, []);
  return (
    <section aria-label="Console audit">
      <h2>Console activity</h2>
      <table className="data-table">
        <thead>
          <tr>
            <th>When</th>
            <th>Operator</th>
            <th>Firm</th>
            <th>What</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id}>
              <td>{when(entry.createdAt)}</td>
              <td>{entry.operator ?? '—'}</td>
              <td>{entry.firmSlug ?? '—'}</td>
              <td>{entry.summary}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

const TABS = [
  'Support requests',
  'Firms',
  'Plans',
  'Invoices',
  'Research sources',
  'Court Online',
  'Help articles',
  'Activity',
] as const;
type Tab = (typeof TABS)[number];

export default function ConsoleApp() {
  const [me, setMe] = useState<ConsoleOperator | null>(null);
  const [state, setState] = useState<'loading' | 'signed-out' | 'unavailable' | 'ready'>('loading');
  const [tab, setTab] = useState<Tab>(
    window.location.hash.startsWith('#ticket-') ? 'Support requests' : 'Firms',
  );

  useEffect(() => {
    document.title = 'Platform console';
    api
      .get<ConsoleOperator>('/platform/me')
      .then(({ data }) => {
        setMe(data);
        setState('ready');
      })
      .catch((err) => setState(apiStatus(err) === 401 ? 'signed-out' : 'unavailable'));
  }, []);

  if (state === 'loading') return <p aria-busy="true">Loading…</p>;
  if (state === 'unavailable')
    return <p className="notice">The platform console is not available here.</p>;
  if (state === 'signed-out' || !me)
    return (
      <main className="auth-shell">
        <SignIn
          onDone={(operator) => {
            setMe(operator);
            setState('ready');
          }}
        />
      </main>
    );

  const admin = me.consoleRole === 'admin';
  return (
    <main className="console-shell">
      <header className="console-header">
        <strong>Platform console</strong>
        <span>
          {me.fullName} · {admin ? 'administrator' : 'read only'}
        </span>
        <button
          type="button"
          className="secondary-button"
          onClick={() =>
            api.post('/platform/sign-out').finally(() => {
              setMe(null);
              setState('signed-out');
            })
          }
        >
          Sign out
        </button>
      </header>
      <nav aria-label="Console sections" className="tab-row">
        {TABS.map((name) => (
          <button
            key={name}
            type="button"
            aria-pressed={tab === name}
            className={tab === name ? 'primary-button' : 'secondary-button'}
            onClick={() => setTab(name)}
          >
            {name}
          </button>
        ))}
      </nav>
      {tab === 'Firms' ? <Firms admin={admin} /> : null}
      {tab === 'Plans' ? <Plans admin={admin} /> : null}
      {tab === 'Research sources' ? <Sources admin={admin} /> : null}
      {tab === 'Court Online' ? <CourtOnline admin={admin} /> : null}
      {tab === 'Support requests' ? <Tickets /> : null}
      {tab === 'Help articles' ? <Articles admin={admin} /> : null}
      {tab === 'Invoices' ? <Invoices /> : null}
      {tab === 'Activity' ? <Audit /> : null}
    </main>
  );
}
