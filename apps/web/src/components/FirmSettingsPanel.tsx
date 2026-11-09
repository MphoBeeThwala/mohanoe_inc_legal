import { useState } from 'react';
import DomainsPanel from './DomainsPanel';
import {
  BrandForm,
  InvoicingForm,
  PracticeForm,
  ProfileForm,
  useFirmSettings,
} from './FirmSettingsForms';

const TABS = [
  ['profile', 'Practice details'],
  ['brand', 'Name, logo and colours'],
  ['invoicing', 'Invoicing and VAT'],
  ['practice', 'Numbering and compliance'],
  ['domains', 'Web address'],
] as const;

type Tab = (typeof TABS)[number][0];

/** Firm settings for administrators (the same forms as the onboarding wizard). */
function FirmSettingsPanel({ onChanged }: { onChanged?: () => unknown }) {
  const { settings, error, save } = useFirmSettings();
  const [tab, setTab] = useState<Tab>('profile');
  const saveAndRefresh = async (update: Parameters<typeof save>[0]) => {
    const saved = await save(update);
    await onChanged?.();
    return saved;
  };

  return (
    <section className="panel firm-settings" aria-label="Firm settings">
      <div className="panel-head">
        <div>
          <p className="panel-kicker">Firm</p>
          <h2>Firm settings</h2>
        </div>
      </div>
      <div className="tab-row" role="tablist">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? 'tab-button active' : 'tab-button'}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {error ? <p className="field-hint notice-error">{error}</p> : null}
      {tab === 'domains' ? <DomainsPanel /> : null}
      {settings && tab === 'profile' ? (
        <ProfileForm settings={settings} save={saveAndRefresh} />
      ) : null}
      {settings && tab === 'brand' ? <BrandForm settings={settings} save={saveAndRefresh} /> : null}
      {settings && tab === 'invoicing' ? (
        <InvoicingForm settings={settings} save={saveAndRefresh} />
      ) : null}
      {settings && tab === 'practice' ? (
        <PracticeForm settings={settings} save={saveAndRefresh} />
      ) : null}
    </section>
  );
}

export default FirmSettingsPanel;
