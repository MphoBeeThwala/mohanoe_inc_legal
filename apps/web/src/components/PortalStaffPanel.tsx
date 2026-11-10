import { useCallback, useEffect, useState } from 'react';
import type { DocumentRecord, MatterParty, PortalAccess, PortalMessage } from '@ahava88/shared';
import { api, apiErrorMessage } from '../api';

interface Props {
  caseId: string;
  canManagePortal: boolean;
  canWriteMatter: boolean;
  canShareDocuments: boolean;
}

/** The client portal for this matter: access, the client update, shared documents, messages. */
function PortalStaffPanel({ caseId, canManagePortal, canWriteMatter, canShareDocuments }: Props) {
  const [clients, setClients] = useState<
    Array<{ party: MatterParty['party']; access: PortalAccess | null }>
  >([]);
  const [docs, setDocs] = useState<DocumentRecord[]>([]);
  const [messages, setMessages] = useState<PortalMessage[]>([]);
  const [update, setUpdate] = useState('');
  const [reply, setReply] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const parties = (await api.get<MatterParty[]>(`/cases/${caseId}/parties`)).data.filter(
      (p) => p.role === 'client',
    );
    setClients(
      canManagePortal
        ? await Promise.all(
            parties.map(async ({ party }) => ({
              party,
              access: (
                await api.get<{ access: PortalAccess | null }>(`/clients/${party.id}/portal`)
              ).data.access,
            })),
          )
        : parties.map(({ party }) => ({ party, access: null })),
    );
    if (canShareDocuments) {
      setDocs(
        (await api.get<DocumentRecord[]>('/documents')).data.filter((d) => d.caseId === caseId),
      );
    }
    if (canManagePortal) {
      setMessages((await api.get<PortalMessage[]>(`/cases/${caseId}/portal-messages`)).data);
    }
  }, [caseId, canManagePortal, canShareDocuments]);

  useEffect(() => {
    load().catch((err) =>
      setError(apiErrorMessage(err, 'The portal details could not be loaded.')),
    );
  }, [load]);

  const run = async (fn: () => Promise<string | void>) => {
    setError('');
    setNote('');
    try {
      const done = await fn();
      if (done) setNote(done);
      await load();
    } catch (err) {
      setError(apiErrorMessage(err, 'That did not work.'));
    }
  };

  return (
    <section className="panel" aria-label="Client portal">
      <div className="panel-head">
        <div>
          <p className="panel-kicker">Client portal</p>
          <h3>What the client sees</h3>
        </div>
      </div>
      {note ? <p className="field-hint notice-success">{note}</p> : null}
      {error ? <p className="field-hint notice-error">{error}</p> : null}

      {canManagePortal
        ? clients.map(({ party, access }) => (
            <p key={party.id} className="button-row">
              <span>
                {party.name}:{' '}
                {access
                  ? access.status === 'active'
                    ? 'has portal access'
                    : access.status === 'invited'
                      ? 'invited'
                      : 'access withdrawn'
                  : 'no portal access'}
              </span>
              <button
                type="button"
                className="secondary-button"
                onClick={() =>
                  run(async () => {
                    await api.post(`/clients/${party.id}/portal/invite`, {});
                    return 'Invitation emailed.';
                  })
                }
              >
                {access ? 'Send a new invitation' : 'Invite to the portal'}
              </button>
              {access && access.status !== 'disabled' ? (
                <button
                  type="button"
                  className="link-button"
                  onClick={() =>
                    run(async () => {
                      await api.post(`/portal-users/${access.id}/disable`);
                      return 'Portal access withdrawn.';
                    })
                  }
                >
                  Withdraw access
                </button>
              ) : null}
            </p>
          ))
        : null}

      {canWriteMatter ? (
        <form
          className="research-form"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              await api.put(`/cases/${caseId}/client-update`, { update });
              return 'Update saved for the client.';
            });
          }}
        >
          <label>
            Update for the client
            <textarea
              rows={3}
              maxLength={2000}
              value={update}
              onChange={(e) => setUpdate(e.target.value)}
              placeholder="Where the matter stands and what happens next, in plain language."
            />
          </label>
          <button type="submit" className="secondary-button">
            Save update
          </button>
        </form>
      ) : null}

      {canShareDocuments && docs.length ? (
        <div>
          <h4>Documents</h4>
          <ul className="trust-list">
            {docs.map((doc) => (
              <li key={doc.id}>
                <label className="inline-check">
                  <input
                    type="checkbox"
                    checked={Boolean(doc.sharedWithClientAt)}
                    onChange={(e) =>
                      run(async () => {
                        await api.post(`/documents/${doc.id}/share`, { shared: e.target.checked });
                      })
                    }
                  />
                  {doc.title} — shared with the client
                </label>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {canManagePortal ? (
        <div className="portal-messages">
          <h4>Messages</h4>
          {messages.length ? null : <p className="field-hint">No messages yet.</p>}
          {messages.map((m) => (
            <p
              key={m.id}
              className={`portal-message portal-message-${m.from === 'client' ? 'staff' : 'client'}`}
            >
              <strong>{m.senderName}</strong>{' '}
              <span className="field-hint">{new Date(m.sentAt).toLocaleString('en-ZA')}</span>
              <br />
              {m.body}
            </p>
          ))}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                await api.post(`/cases/${caseId}/portal-messages`, { body: reply });
                setReply('');
                return 'Sent. The client is told by email that there is a message.';
              });
            }}
          >
            <label>
              Reply to the client
              <textarea
                rows={2}
                required
                value={reply}
                onChange={(e) => setReply(e.target.value)}
              />
            </label>
            <button type="submit" className="primary-button">
              Send
            </button>
          </form>
        </div>
      ) : null}
    </section>
  );
}

export default PortalStaffPanel;
