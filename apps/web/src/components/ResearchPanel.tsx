import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { ResearchRequest } from '@ahava88/shared';
import { api, apiErrorMessage } from '../api';

const KIND_LABEL: Record<string, string> = {
  person: 'names',
  listed_detail: 'listed details',
  id_number: 'ID numbers',
  phone: 'phone numbers',
  email: 'email addresses',
  bank_account: 'account numbers',
  card_number: 'card numbers',
  registration_number: 'registration numbers',
  case_number: 'case numbers',
  address: 'addresses',
  erf: 'erf numbers',
  po_box: 'PO boxes',
};

function removedSummary(request: ResearchRequest): string {
  const byKind = new Map<string, number>();
  for (const item of request.replacements) {
    byKind.set(item.kind, (byKind.get(item.kind) ?? 0) + item.count);
  }
  if (!byKind.size) return 'Nothing needed removing.';
  return `Removed: ${[...byKind.entries()]
    .map(([kind, count]) => `${count} ${KIND_LABEL[kind] ?? kind}`)
    .join(', ')}.`;
}

/**
 * Research briefs on a matter: the attorney sees exactly what an AI model
 * would receive, de-identified, can edit it, and confirms it.
 */
function ResearchBriefCard({
  request,
  onChange,
  onDelete,
}: {
  request: ResearchRequest;
  onChange: (next: ResearchRequest) => void;
  onDelete: () => void;
}) {
  const [text, setText] = useState(request.brief);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const draft = request.status === 'draft';
  const edited = text.trim() !== request.brief.trim();

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
        <strong>{request.question}</strong>
        <span className={`status-pill status-${draft ? 'trialing' : 'active'}`}>
          {draft ? 'Draft brief' : 'Confirmed'}
        </span>
      </header>
      <p className="field-hint">{removedSummary(request)}</p>
      {request.warnings.length ? (
        <p className="field-hint notice-warn">
          Check these before confirming. They may be names nobody listed on the matter:{' '}
          <strong>{request.warnings.join(', ')}</strong>. Replace them with a token such as [Person
          3] if they identify someone.
        </p>
      ) : null}
      <label>
        What the AI will receive
        <textarea
          rows={12}
          value={text}
          readOnly={!draft}
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      {error ? <p className="field-hint notice-error">{error}</p> : null}
      {draft ? (
        <div className="button-row">
          <button
            type="button"
            className="secondary-button"
            disabled={busy || !edited}
            onClick={() =>
              run(async () => {
                const { data } = await api.patch<ResearchRequest>(`/research/${request.id}`, {
                  brief: text,
                });
                onChange(data);
                setText(data.brief);
              })
            }
          >
            Save edits
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={busy || edited}
            onClick={() =>
              run(async () => {
                const { data } = await api.post<ResearchRequest>(`/research/${request.id}/confirm`);
                onChange(data);
              })
            }
          >
            Confirm brief
          </button>
          <button
            type="button"
            className="link-button"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await api.delete(`/research/${request.id}`);
                onDelete();
              })
            }
          >
            Delete draft
          </button>
        </div>
      ) : (
        <p className="field-hint">
          Confirmed{' '}
          {request.confirmedAt ? new Date(request.confirmedAt).toLocaleString('en-ZA') : ''}. Only
          this exact text will be sent for research.
        </p>
      )}
    </article>
  );
}

function ResearchPanel({ caseId }: { caseId: string }) {
  const [requests, setRequests] = useState<ResearchRequest[]>([]);
  const [question, setQuestion] = useState('');
  const [facts, setFacts] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data } = await api.get<ResearchRequest[]>(`/cases/${caseId}/research`);
    setRequests(data);
  }, [caseId]);

  useEffect(() => {
    load().catch((err) => setError(apiErrorMessage(err, 'Research briefs could not be loaded.')));
  }, [load]);

  const draft = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { data } = await api.post<ResearchRequest>(`/cases/${caseId}/research`, {
        question,
        additionalFacts: facts,
      });
      setRequests((list) => [data, ...list]);
      setQuestion('');
      setFacts('');
    } catch (err) {
      setError(apiErrorMessage(err, 'The brief could not be prepared.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel research-panel" aria-label="Legal research">
      <div className="panel-head">
        <div>
          <p className="panel-kicker">AI research</p>
          <h3>Research briefs</h3>
        </div>
      </div>
      <p className="field-hint">
        The question and the matter&apos;s facts are de-identified before anything is sent: the
        client and parties become tokens such as [Client], and ID numbers, contact details,
        addresses and case numbers are removed. You review and confirm the exact brief first.
      </p>
      <form className="research-form" onSubmit={draft}>
        <label>
          Research question
          <textarea
            rows={3}
            required
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
          />
        </label>
        <label>
          Facts to add (optional)
          <textarea rows={3} value={facts} onChange={(event) => setFacts(event.target.value)} />
        </label>
        <button type="submit" className="primary-button" disabled={busy || !question.trim()}>
          Prepare brief
        </button>
      </form>
      {error ? <p className="field-hint notice-error">{error}</p> : null}
      {requests.map((request) => (
        <ResearchBriefCard
          key={request.id}
          request={request}
          onChange={(next) => setRequests((list) => list.map((r) => (r.id === next.id ? next : r)))}
          onDelete={() => setRequests((list) => list.filter((r) => r.id !== request.id))}
        />
      ))}
    </section>
  );
}

export default ResearchPanel;
