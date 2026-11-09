import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import {
  FICA_DOCUMENT_LABELS,
  FICA_DOCUMENT_TYPES,
  hasPermission,
  type FicaDocumentType,
  type FicaProfile,
  type FicaRiskFactors,
  type PublicUser,
} from '@ahava88/shared';
import { api, apiErrorMessage } from '../api';

const FACTORS: Array<[keyof FicaRiskFactors, string]> = [
  ['politicallyExposed', 'Politically exposed person (or family / close associate)'],
  ['highRiskJurisdiction', 'Linked to a high-risk or sanctioned country'],
  ['nonFaceToFace', 'Not met face to face'],
  ['cashIntensive', 'Cash-intensive, or large cash in the matter'],
  ['complexStructure', 'Complex ownership or unclear beneficial owners'],
];

const STATUS_LABEL: Record<FicaProfile['status'], string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  verified: 'Verified',
  review_due: 'Review due',
};

const readBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

/** FICA customer due diligence for one client. */
function FicaPanel({ clientId, currentUser }: { clientId: string; currentUser: PublicUser }) {
  const can = (permission: Parameters<typeof hasPermission>[1]) =>
    hasPermission(currentUser.role, permission);
  const [profile, setProfile] = useState<FicaProfile | null>(null);
  const [factors, setFactors] = useState<FicaRiskFactors>({});
  const [docType, setDocType] = useState<FicaDocumentType>('id_document');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const apply = (data: FicaProfile) => {
    setProfile(data);
    setFactors(data.riskFactors);
    if (data.missing[0]) setDocType(data.missing[0]);
  };

  const load = useCallback(async () => {
    apply((await api.get<FicaProfile>(`/clients/${clientId}/fica`)).data);
  }, [clientId]);

  useEffect(() => {
    load().catch(() => setProfile(null));
  }, [load]);

  const run = async (action: () => Promise<FicaProfile>) => {
    setBusy(true);
    setError('');
    try {
      apply(await action());
    } catch (err) {
      setError(apiErrorMessage(err, 'That did not work.'));
    } finally {
      setBusy(false);
    }
  };

  const uploadFile = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!file) return;
    run(async () => {
      const dataBase64 = await readBase64(file);
      const { data } = await api.post<FicaProfile>(`/clients/${clientId}/fica/documents`, {
        docType,
        fileName: file.name,
        contentType: file.type,
        dataBase64,
      });
      setFile(null);
      return data;
    });
  };

  if (!profile) {
    return null;
  }

  return (
    <div className="matter-access">
      <h3>
        FICA ·{' '}
        <span className={`fica-badge fica-${profile.status}`}>{STATUS_LABEL[profile.status]}</span>
      </h3>
      <p className="field-hint">
        Risk: <strong>{profile.riskRating}</strong>
        {profile.verifiedAt
          ? ` · verified ${new Date(profile.verifiedAt).toLocaleDateString()} by ${profile.verifiedBy}`
          : ''}
        {profile.reviewDue ? ` · review due ${profile.reviewDue}` : ''}
      </p>
      {error ? <p className="field-hint notice-error">{error}</p> : null}

      <fieldset className="fica-factors" disabled={!can('fica.write') || busy}>
        <legend>Risk factors</legend>
        {FACTORS.map(([key, label]) => (
          <label key={key} className="checkbox-row">
            <input
              type="checkbox"
              checked={Boolean(factors[key])}
              onChange={(event) =>
                setFactors((current) => ({ ...current, [key]: event.target.checked }))
              }
            />
            {label}
          </label>
        ))}
        {can('fica.write') ? (
          <button
            type="button"
            className="secondary-button"
            onClick={() =>
              run(
                async () =>
                  (
                    await api.put<FicaProfile>(`/clients/${clientId}/fica/risk`, {
                      riskFactors: factors,
                    })
                  ).data,
              )
            }
          >
            Save risk assessment
          </button>
        ) : null}
      </fieldset>

      <h4>Documents</h4>
      {profile.missing.length ? (
        <p className="field-hint">
          Still needed: {profile.missing.map((type) => FICA_DOCUMENT_LABELS[type]).join(', ')}
        </p>
      ) : (
        <p className="field-hint">All required documents are on file.</p>
      )}
      <ul className="field-hint">
        {profile.documents.map((doc) => (
          <li key={doc.id}>
            {FICA_DOCUMENT_LABELS[doc.docType]}:{' '}
            <a href={`/api/clients/${clientId}/fica/documents/${doc.id}`}>{doc.fileName}</a> (
            {Math.ceil(doc.sizeBytes / 1024)} KB)
            {can('fica.write') ? (
              <button
                type="button"
                className="link-button"
                aria-label={`Remove ${doc.fileName}`}
                disabled={busy}
                onClick={() =>
                  run(
                    async () =>
                      (
                        await api.delete<FicaProfile>(
                          `/clients/${clientId}/fica/documents/${doc.id}`,
                        )
                      ).data,
                  )
                }
              >
                ×
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {can('fica.write') ? (
        <form className="inline-form" onSubmit={uploadFile} aria-label="Upload a FICA document">
          <select
            aria-label="Document type"
            value={docType}
            onChange={(event) => setDocType(event.target.value as FicaDocumentType)}
          >
            {FICA_DOCUMENT_TYPES.map((type) => (
              <option key={type} value={type}>
                {FICA_DOCUMENT_LABELS[type]}
              </option>
            ))}
          </select>
          <input
            aria-label="File"
            type="file"
            accept="application/pdf,image/jpeg,image/png"
            onChange={(event: ChangeEvent<HTMLInputElement>) =>
              setFile(event.target.files?.[0] ?? null)
            }
          />
          <button className="secondary-button" disabled={busy || !file}>
            Upload
          </button>
        </form>
      ) : null}
      {can('fica.verify') && profile.status !== 'verified' ? (
        <button
          type="button"
          className="primary-button"
          disabled={busy || profile.missing.length > 0}
          onClick={() =>
            run(async () => (await api.post<FicaProfile>(`/clients/${clientId}/fica/verify`)).data)
          }
        >
          Mark FICA verified
        </button>
      ) : null}
    </div>
  );
}

export default FicaPanel;
