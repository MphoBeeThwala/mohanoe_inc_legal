import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { FirmDomain } from '@ahava88/shared';
import { api, apiErrorMessage } from '../api';

const STATUS: Record<FirmDomain['status'], string> = {
  pending_dns: 'Waiting for the DNS record',
  pending_routing: 'DNS verified; waiting for the address to reach the platform',
  active: 'Active',
};

/** A firm's own web addresses: add, see the DNS records to publish, check, remove. */
function DomainsPanel() {
  const [domains, setDomains] = useState<FirmDomain[]>([]);
  const [domain, setDomain] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setDomains((await api.get<FirmDomain[]>('/firm/domains')).data);
  }, []);

  useEffect(() => {
    load().catch((err) => setError(apiErrorMessage(err, 'Domains could not be loaded.')));
  }, [load]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await action();
      await load();
    } catch (err) {
      setError(apiErrorMessage(err, 'That did not work.'));
    } finally {
      setBusy(false);
    }
  };

  const add = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    run(async () => {
      await api.post('/firm/domains', { domain });
      setDomain('');
    });
  };

  return (
    <div className="domains-panel">
      <p className="field-hint">
        Use your own address, such as portal.yourfirm.co.za. Add the two DNS records shown, then
        check. Emails switch to your address once it works.
      </p>
      {error ? <p className="field-hint notice-error">{error}</p> : null}
      {domains.map((item) => (
        <div key={item.id} className="domain-item">
          <strong>{item.domain}</strong> · {STATUS[item.status]}
          {item.status !== 'active' ? (
            <dl className="dns-records">
              <dt>TXT record</dt>
              <dd>
                <code>{item.txtRecordName}</code> = <code>{item.txtRecordValue}</code>
              </dd>
              {item.cnameTarget ? (
                <>
                  <dt>CNAME record</dt>
                  <dd>
                    <code>{item.domain}</code> → <code>{item.cnameTarget}</code>
                  </dd>
                </>
              ) : (
                <>
                  <dt>Address</dt>
                  <dd>Ask platform support for the CNAME target.</dd>
                </>
              )}
            </dl>
          ) : null}
          {item.lastError ? <p className="field-hint notice-error">{item.lastError}</p> : null}
          <span className="row-actions">
            {item.status !== 'active' ? (
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => run(() => api.post(`/firm/domains/${item.id}/check`))}
              >
                Check now
              </button>
            ) : null}
            <button
              type="button"
              className="link-button"
              disabled={busy}
              aria-label={`Remove ${item.domain}`}
              onClick={() => run(() => api.delete(`/firm/domains/${item.id}`))}
            >
              Remove
            </button>
          </span>
        </div>
      ))}
      <form className="inline-form" aria-label="Add a domain" onSubmit={add}>
        <input
          aria-label="Domain"
          placeholder="portal.yourfirm.co.za"
          value={domain}
          onChange={(event) => setDomain(event.target.value)}
        />
        <button className="secondary-button" disabled={busy || !domain.trim()}>
          Add domain
        </button>
      </form>
    </div>
  );
}

export default DomainsPanel;
