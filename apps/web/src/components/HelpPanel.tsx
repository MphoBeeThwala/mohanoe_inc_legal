// Help centre and support requests. Requests go to the platform's support
// team, never to clients; staff are asked to leave client details out.
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type {
  HelpArticle,
  HelpCentre,
  NewSupportTicket,
  SupportTicket,
  SupportTicketSummary,
  TicketCategory,
} from '@ahava88/shared';
import { api, apiErrorMessage } from '../api';

const CATEGORY_LABELS: Record<TicketCategory, string> = {
  question: 'Question',
  problem: 'Something is not working',
  billing: 'Subscription or billing',
  data_request: 'Records or data request',
  security: 'Security concern',
};
const STATUS_LABELS = { open: 'With support', answered: 'Support replied', closed: 'Closed' };

const when = (value: string) =>
  new Date(value).toLocaleString('en-ZA', {
    timeZone: 'Africa/Johannesburg',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

/** Article text: '# ' headings, '- ' list items, blank lines between paragraphs. Never HTML. */
export function HelpText({ body }: { body: string }) {
  const blocks = body.split(/\n\s*\n/);
  return (
    <div className="help-text">
      {blocks.map((block, index) => {
        const lines = block.split('\n').filter((line) => line.trim());
        if (lines.length === 1 && lines[0]!.startsWith('# ')) {
          return <h4 key={index}>{lines[0]!.slice(2)}</h4>;
        }
        if (lines.every((line) => line.startsWith('- '))) {
          return (
            <ul key={index}>
              {lines.map((line, i) => (
                <li key={i}>{line.slice(2)}</li>
              ))}
            </ul>
          );
        }
        // A heading followed by a list or text in the same block.
        return (
          <div key={index}>
            {lines.map((line, i) =>
              line.startsWith('# ') ? (
                <h4 key={i}>{line.slice(2)}</h4>
              ) : line.startsWith('- ') ? (
                <ul key={i}>
                  <li>{line.slice(2)}</li>
                </ul>
              ) : (
                <p key={i}>{line}</p>
              ),
            )}
          </div>
        );
      })}
    </div>
  );
}

function NewRequest({ onCreated }: { onCreated: (ticket: SupportTicket) => void }) {
  const empty: NewSupportTicket = {
    subject: '',
    body: '',
    category: 'question',
    priority: 'normal',
  };
  const [form, setForm] = useState(empty);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    try {
      const { data } = await api.post<SupportTicket>('/helpdesk/tickets', form);
      setForm(empty);
      onCreated(data);
    } catch (err) {
      setError(apiErrorMessage(err, 'The request could not be sent.'));
    }
  };
  return (
    <form className="panel-form" onSubmit={submit} aria-label="New support request">
      <h3>New support request</h3>
      <p className="field-hint">
        Please leave out client names, ID numbers and case facts. Use the matter number instead (for
        example the number shown on the matter).
      </p>
      <label>
        What it is about
        <select
          value={form.category}
          onChange={(e) => setForm({ ...form, category: e.target.value as TicketCategory })}
        >
          {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Subject
        <input
          required
          minLength={3}
          maxLength={200}
          value={form.subject}
          onChange={(e) => setForm({ ...form, subject: e.target.value })}
        />
      </label>
      <label>
        What happened
        <textarea
          required
          rows={5}
          maxLength={10000}
          value={form.body}
          onChange={(e) => setForm({ ...form, body: e.target.value })}
        />
      </label>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={form.priority === 'urgent'}
          onChange={(e) => setForm({ ...form, priority: e.target.checked ? 'urgent' : 'normal' })}
        />
        Urgent: work has stopped
      </label>
      {error ? <p className="field-hint notice-error">{error}</p> : null}
      <button type="submit" className="primary-button">
        Send to support
      </button>
    </form>
  );
}

function Ticket({ id, onChanged }: { id: string; onChanged: () => void }) {
  const [ticket, setTicket] = useState<SupportTicket | null>(null);
  const [reply, setReply] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    api
      .get<SupportTicket>(`/helpdesk/tickets/${id}`)
      .then(({ data }) => setTicket(data))
      .catch((err) => setError(apiErrorMessage(err, 'The request could not be loaded.')));
  }, [id]);
  const act = async (fn: () => Promise<{ data: SupportTicket }>) => {
    setError('');
    try {
      const { data } = await fn();
      setTicket(data);
      setReply('');
      onChanged();
    } catch (err) {
      setError(apiErrorMessage(err, 'That did not go through.'));
    }
  };
  if (error && !ticket) return <p className="notice notice-error">{error}</p>;
  if (!ticket) return <p aria-busy="true">Loading…</p>;
  return (
    <article className="ticket" aria-label={`Request ${ticket.number}`}>
      <h3>
        {ticket.number}: {ticket.subject}
      </h3>
      <p className="field-hint">
        {CATEGORY_LABELS[ticket.category]} · {STATUS_LABELS[ticket.status]}
        {ticket.priority === 'urgent' ? ' · urgent' : ''}
      </p>
      <ol className="ticket-messages">
        {ticket.messages.map((message) => (
          <li key={message.id} className={`ticket-message ticket-${message.author}`}>
            <strong>{message.name}</strong> <small>{when(message.createdAt)}</small>
            <p>{message.body}</p>
          </li>
        ))}
      </ol>
      <form
        className="panel-form"
        onSubmit={(event) => {
          event.preventDefault();
          void act(() => api.post(`/helpdesk/tickets/${ticket.id}/messages`, { body: reply }));
        }}
      >
        <label>
          Reply
          <textarea required rows={3} value={reply} onChange={(e) => setReply(e.target.value)} />
        </label>
        <div className="row-actions">
          <button type="submit" className="primary-button">
            Send reply
          </button>
          {ticket.status !== 'closed' ? (
            <button
              type="button"
              className="secondary-button"
              onClick={() => act(() => api.post(`/helpdesk/tickets/${ticket.id}/close`))}
            >
              Close request
            </button>
          ) : null}
        </div>
      </form>
      {error ? <p className="notice notice-error">{error}</p> : null}
    </article>
  );
}

export default function HelpPanel() {
  const [centre, setCentre] = useState<HelpCentre | null>(null);
  const [article, setArticle] = useState<HelpArticle | null>(null);
  const [tickets, setTickets] = useState<SupportTicketSummary[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const loadTickets = useCallback(() => {
    api
      .get<SupportTicketSummary[]>('/helpdesk/tickets')
      .then(({ data }) => setTickets(data))
      .catch((err) => setError(apiErrorMessage(err, 'Requests could not be loaded.')));
  }, []);
  useEffect(() => {
    api
      .get<HelpCentre>('/helpdesk')
      .then(({ data }) => setCentre(data))
      .catch((err) => setError(apiErrorMessage(err, 'Help could not be loaded.')));
    loadTickets();
  }, [loadTickets]);

  const categories = [...new Set((centre?.articles ?? []).map((a) => a.category))];
  return (
    <div className="panel">
      <p className="panel-kicker">Help</p>
      <h2>Help and support</h2>
      {error ? <p className="notice notice-error">{error}</p> : null}
      {centre?.statusPageUrl ? (
        <p>
          Something down?{' '}
          <a href={centre.statusPageUrl} target="_blank" rel="noreferrer">
            Check the service status
          </a>
          .
        </p>
      ) : null}

      <div className="help-grid">
        <section aria-label="Help articles">
          <h3>Guides</h3>
          {categories.map((category) => (
            <div key={category}>
              <h4>{category}</h4>
              <ul className="link-list">
                {centre!.articles
                  .filter((a) => a.category === category)
                  .map((a) => (
                    <li key={a.slug}>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() =>
                          api
                            .get<HelpArticle>(`/helpdesk/articles/${a.slug}`)
                            .then(({ data }) => setArticle(data))
                        }
                      >
                        {a.title}
                      </button>
                    </li>
                  ))}
              </ul>
            </div>
          ))}
          {article ? (
            <article aria-label={article.title} className="help-article">
              <h3>{article.title}</h3>
              <HelpText body={article.body} />
            </article>
          ) : null}
        </section>

        <section aria-label="Support requests">
          <h3>Your requests</h3>
          {tickets.length ? (
            <ul className="link-list">
              {tickets.map((t) => (
                <li key={t.id}>
                  <button type="button" className="link-button" onClick={() => setOpenId(t.id)}>
                    {t.number}: {t.subject}
                  </button>{' '}
                  <small>
                    {STATUS_LABELS[t.status]} · {when(t.lastMessageAt)}
                    {t.createdBy ? ` · ${t.createdBy}` : ''}
                  </small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="field-hint">No requests yet.</p>
          )}
          {openId ? <Ticket key={openId} id={openId} onChanged={loadTickets} /> : null}
          <NewRequest
            onCreated={(ticket) => {
              loadTickets();
              setOpenId(ticket.id);
            }}
          />
        </section>
      </div>
    </div>
  );
}
