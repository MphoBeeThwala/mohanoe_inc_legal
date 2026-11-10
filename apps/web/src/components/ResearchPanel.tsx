import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AUTHORITY_LEVELS, type CitedSource, type ResearchRequest } from '@ahava88/shared';
import { api, apiErrorMessage } from '../api';

const STATUS_LABEL: Record<ResearchRequest['status'], string> = {
  draft: 'Draft brief',
  confirmed: 'Confirmed',
  answered: 'Answered',
  approved: 'Approved',
};

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
const VALIDITY_LABEL: Record<string, string> = {
  in_force: 'In force',
  amended: 'In force (amended)',
  repealed: 'Repealed',
  not_commenced: 'Not yet in force',
  overruled: 'Overruled',
};

function SourceItem({ source }: { source: CitedSource }) {
  return (
    <li id={`source-${source.ref}`}>
      <strong>[{source.ref}]</strong> {source.citation}
      {source.pinpoint ? `, ${source.pinpoint}` : ''} — {source.title}
      <div className="field-hint">
        {source.kind === 'precedent'
          ? 'Firm precedent (not authority)'
          : `${AUTHORITY_LEVELS[source.authorityLevel] ?? 'Other'} · ${source.sourceName} · ${VALIDITY_LABEL[source.validity] ?? source.validity}${source.versionDate ? ` · text as at ${source.versionDate}` : ''}`}
        {source.url ? (
          <>
            {' · '}
            <a href={source.url} target="_blank" rel="noreferrer">
              Open
            </a>
          </>
        ) : null}
      </div>
      <details>
        <summary>Passage</summary>
        <p className="research-passage">{source.text}</p>
      </details>
    </li>
  );
}

/** The verified answer: every claim cites retrieved passages, shown below it. */
function ResearchAnswerView({ request }: { request: ResearchRequest }) {
  const [named, setNamed] = useState(true);
  const answer = request.answer!;
  const claims = named ? answer.claimsNamed : answer.claims;
  return (
    <div className="research-answer">
      {answer.noAuthority ? (
        <p className="notice notice-warn">
          No authority found in the approved sources for this question. Nothing was guessed.
        </p>
      ) : (
        <>
          <label className="inline-check">
            <input type="checkbox" checked={named} onChange={(e) => setNamed(e.target.checked)} />
            Show names (only staff on this matter see them; the AI never did)
          </label>
          <ol className="research-claims">
            {claims.map((claim, index) => (
              <li key={index}>
                {claim.text}{' '}
                {claim.citations.map((ref) => (
                  <a key={ref} href={`#source-${ref}`} className="citation">
                    [{ref}]
                  </a>
                ))}
              </li>
            ))}
          </ol>
        </>
      )}
      {answer.gaps.length ? (
        <p className="field-hint">
          <strong>Not covered by the sources:</strong> {answer.gaps.join(' ')}
        </p>
      ) : null}
      {answer.removed.length ? (
        <details>
          <summary>
            {answer.removed.length} statement{answer.removed.length === 1 ? '' : 's'} removed by
            citation checks
          </summary>
          <ul>
            {answer.removed.map((item, index) => (
              <li key={index}>
                {item.text} <span className="field-hint">({item.reason})</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {answer.sources.length ? (
        <>
          <h4>Sources</h4>
          <ul className="research-sources">
            {answer.sources.map((source) => (
              <SourceItem key={source.ref} source={source} />
            ))}
          </ul>
        </>
      ) : null}
      <p className="field-hint">
        Research for the attorney to verify; it is not advice until an attorney approves it.
        {answer.model ? ` Model: ${answer.model}.` : ''}
      </p>
    </div>
  );
}

function ResearchBriefCard({
  request,
  onChange,
  onDelete,
  canApprove,
}: {
  request: ResearchRequest;
  onChange: (next: ResearchRequest) => void;
  onDelete: () => void;
  canApprove: boolean;
}) {
  const [note, setNote] = useState('');
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
          {STATUS_LABEL[request.status]}
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
          this exact text is sent for research.
        </p>
      )}
      {request.status === 'confirmed' || request.status === 'answered' ? (
        <button
          type="button"
          className={request.answer ? 'secondary-button' : 'primary-button'}
          disabled={busy}
          onClick={() =>
            run(async () => {
              const { data } = await api.post<ResearchRequest>(`/research/${request.id}/run`);
              onChange(data);
            })
          }
        >
          {busy ? 'Researching…' : request.answer ? 'Research again' : 'Run research'}
        </button>
      ) : null}
      {request.answer ? <ResearchAnswerView request={request} /> : null}
      {request.status === 'answered' && canApprove ? (
        <div className="research-approve">
          <label>
            Approval note (optional)
            <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <button
            type="button"
            className="primary-button"
            disabled={busy}
            onClick={() =>
              run(async () => {
                const { data } = await api.post<ResearchRequest>(
                  `/research/${request.id}/approve`,
                  {
                    note,
                  },
                );
                onChange(data);
              })
            }
          >
            Approve memo
          </button>
        </div>
      ) : null}
      {request.status === 'approved' ? (
        <p className="field-hint notice-success">
          Approved {request.approvedAt ? new Date(request.approvedAt).toLocaleString('en-ZA') : ''}
          {request.approvalNote ? `: ${request.approvalNote}` : '.'} The memo and its sources are
          kept as they were.
        </p>
      ) : null}
    </article>
  );
}

function ResearchPanel({ caseId, canApprove = false }: { caseId: string; canApprove?: boolean }) {
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
          canApprove={canApprove}
          onChange={(next) => setRequests((list) => list.map((r) => (r.id === next.id ? next : r)))}
          onDelete={() => setRequests((list) => list.filter((r) => r.id !== request.id))}
        />
      ))}
    </section>
  );
}

export default ResearchPanel;
