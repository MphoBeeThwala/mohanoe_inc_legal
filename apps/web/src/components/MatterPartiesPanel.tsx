import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { MatterParty, MatterPartyRole, PartyKind } from '@ahava88/shared';
import { api, apiErrorMessage } from '../api';

const ROLE_NAMES: Record<MatterPartyRole, string> = {
  client: 'Client',
  opposing: 'Opposing party',
  opposing_attorney: 'Opposing attorney',
  related: 'Related person',
  witness: 'Witness',
};

interface MatterPartiesPanelProps {
  caseId: string;
  canEdit: boolean;
}

/** Who is on a matter: the client and the other parties. */
function MatterPartiesPanel({ caseId, canEdit }: MatterPartiesPanelProps) {
  const [rows, setRows] = useState<MatterParty[] | null>(null);
  const [form, setForm] = useState({
    name: '',
    kind: 'individual' as PartyKind,
    role: 'opposing' as MatterPartyRole,
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setRows((await api.get<MatterParty[]>(`/cases/${caseId}/parties`)).data);
  }, [caseId]);

  useEffect(() => {
    // Roles without access to the client register simply don't see this panel.
    load().catch(() => setRows(null));
  }, [load]);

  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { data } = await api.post<MatterParty[]>(`/cases/${caseId}/parties`, {
        role: form.role,
        party: { kind: form.kind, details: { name: form.name } },
      });
      setRows(data);
      setForm((current) => ({ ...current, name: '' }));
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not add the party.'));
    } finally {
      setBusy(false);
    }
  };

  if (!rows) {
    return null;
  }
  return (
    <div className="matter-access">
      <h3>Parties</h3>
      <ul className="tag-list">
        {rows.map((row) => (
          <li key={`${row.party.id}-${row.role}`}>
            {row.party.name} · {ROLE_NAMES[row.role]}
          </li>
        ))}
      </ul>
      {error ? <p className="field-hint notice-error">{error}</p> : null}
      {canEdit ? (
        <form className="inline-form" onSubmit={add} aria-label="Add a party">
          <input
            aria-label="Party name"
            placeholder="Name of the other party"
            value={form.name}
            onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
            required
          />
          <select
            aria-label="Party type"
            value={form.kind}
            onChange={(event) =>
              setForm((current) => ({ ...current, kind: event.target.value as PartyKind }))
            }
          >
            <option value="individual">Individual</option>
            <option value="entity">Organisation</option>
          </select>
          <select
            aria-label="Role on the matter"
            value={form.role}
            onChange={(event) =>
              setForm((current) => ({ ...current, role: event.target.value as MatterPartyRole }))
            }
          >
            {(['opposing', 'opposing_attorney', 'related', 'witness'] as const).map((role) => (
              <option key={role} value={role}>
                {ROLE_NAMES[role]}
              </option>
            ))}
          </select>
          <button className="secondary-button" disabled={busy}>
            Add party
          </button>
        </form>
      ) : null}
    </div>
  );
}

export default MatterPartiesPanel;
