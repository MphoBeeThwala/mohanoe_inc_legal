import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ROLE_LABELS, type MatterAccess, type StaffDirectoryEntry } from '@ahava88/shared';
import { api, apiErrorMessage } from '../api';

interface MatterAccessPanelProps {
  caseId: string;
  /** Called when the current user can no longer see the matter. */
  onLostAccess: () => void;
}

/** Who can see a matter: firm-wide or restricted, its members, and ethical walls. */
function MatterAccessPanel({ caseId, onLostAccess }: MatterAccessPanelProps) {
  const [access, setAccess] = useState<MatterAccess | null>(null);
  const [staff, setStaff] = useState<StaffDirectoryEntry[]>([]);
  const [memberId, setMemberId] = useState('');
  const [wall, setWall] = useState({ userId: '', reason: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [accessResponse, directory] = await Promise.all([
      api.get<MatterAccess>(`/cases/${caseId}/access`),
      api.get<StaffDirectoryEntry[]>('/users/directory'),
    ]);
    setAccess(accessResponse.data);
    setStaff(directory.data);
  }, [caseId]);

  useEffect(() => {
    load().catch((err: unknown) => setError(apiErrorMessage(err, 'Could not load matter access.')));
  }, [load]);

  const run = async (action: () => Promise<{ status: number; data: MatterAccess | '' }>) => {
    setBusy(true);
    setError('');
    try {
      const response = await action();
      if (response.status === 204) {
        onLostAccess();
        return;
      }
      setAccess(response.data as MatterAccess);
    } catch (err) {
      setError(apiErrorMessage(err, 'That did not work.'));
    } finally {
      setBusy(false);
    }
  };

  if (!access) {
    return error ? <p className="field-hint">{error}</p> : null;
  }

  const memberIds = new Set(access.members.map((member) => member.userId));
  const walledIds = new Set(access.exclusions.map((exclusion) => exclusion.userId));
  const candidates = staff.filter(
    (person) => !memberIds.has(person.id) && !walledIds.has(person.id),
  );

  const addMember = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!memberId) return;
    run(() => api.post(`/cases/${caseId}/members`, { userId: memberId })).then(() =>
      setMemberId(''),
    );
  };

  const addWall = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    run(() => api.post(`/cases/${caseId}/exclusions`, wall)).then(() =>
      setWall({ userId: '', reason: '' }),
    );
  };

  return (
    <div className="matter-access">
      <h3>Who can see this matter</h3>
      {error ? <p className="field-hint notice-error">{error}</p> : null}
      <div className="action-row">
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={access.access === 'restricted'}
            disabled={!access.canManage || busy}
            onChange={(event) =>
              run(() =>
                api.put(`/cases/${caseId}/access`, {
                  access: event.target.checked ? 'restricted' : 'firm',
                }),
              )
            }
          />
          Restricted: only members and administrators
        </label>
      </div>
      <p className="field-hint">
        {access.access === 'restricted'
          ? 'Only the people listed below (and administrators) can open this matter.'
          : 'Everyone at the firm who works on matters can open this matter.'}
      </p>

      <h4>Members</h4>
      <ul className="tag-list">
        {access.members.map((member) => (
          <li key={member.userId}>
            {member.fullName} · {member.memberRole === 'lead' ? 'Lead' : ROLE_LABELS[member.role]}
            {access.canManage ? (
              <button
                type="button"
                className="link-button"
                disabled={busy}
                aria-label={`Remove ${member.fullName}`}
                onClick={() => run(() => api.delete(`/cases/${caseId}/members/${member.userId}`))}
              >
                ×
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {access.canManage ? (
        <form className="inline-form" onSubmit={addMember} aria-label="Add a member">
          <select value={memberId} onChange={(event) => setMemberId(event.target.value)}>
            <option value="">Add a member…</option>
            {candidates.map((person) => (
              <option key={person.id} value={person.id}>
                {person.fullName} ({ROLE_LABELS[person.role]})
              </option>
            ))}
          </select>
          <button className="secondary-button" disabled={busy || !memberId}>
            Add
          </button>
        </form>
      ) : null}

      <h4>Ethical walls</h4>
      {access.exclusions.length ? (
        <ul className="tag-list">
          {access.exclusions.map((exclusion) => (
            <li key={exclusion.userId}>
              {exclusion.fullName}
              {exclusion.reason ? ` · ${exclusion.reason}` : ''}
              {access.canManage ? (
                <button
                  type="button"
                  className="link-button"
                  disabled={busy}
                  aria-label={`Remove wall for ${exclusion.fullName}`}
                  onClick={() =>
                    run(() => api.delete(`/cases/${caseId}/exclusions/${exclusion.userId}`))
                  }
                >
                  ×
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="field-hint">No one is walled off this matter.</p>
      )}
      {access.canManage ? (
        <form className="inline-form" onSubmit={addWall} aria-label="Add an ethical wall">
          <select
            value={wall.userId}
            onChange={(event) => setWall((current) => ({ ...current, userId: event.target.value }))}
            required
          >
            <option value="">Wall off…</option>
            {staff
              .filter((person) => !walledIds.has(person.id))
              .map((person) => (
                <option key={person.id} value={person.id}>
                  {person.fullName}
                </option>
              ))}
          </select>
          <input
            placeholder="Reason (conflict of interest)"
            value={wall.reason}
            onChange={(event) => setWall((current) => ({ ...current, reason: event.target.value }))}
            required
          />
          <button className="secondary-button" disabled={busy || !wall.userId}>
            Add wall
          </button>
        </form>
      ) : null}
    </div>
  );
}

export default MatterAccessPanel;
