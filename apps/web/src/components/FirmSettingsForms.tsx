import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import {
  contrastRatio,
  isHexColor,
  MIN_BRAND_CONTRAST,
  type FirmAssetKind,
  type FirmSettings,
  type FirmSettingsUpdate,
} from '@ahava88/shared';
import { api, apiErrorMessage } from '../api';

/** The firm's settings, with a save helper that returns the updated settings. */
export function useFirmSettings() {
  const [settings, setSettings] = useState<FirmSettings | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setSettings((await api.get<FirmSettings>('/firm/settings')).data);
    } catch (err) {
      setError(apiErrorMessage(err, 'Firm settings could not be loaded.'));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = useCallback(async (update: FirmSettingsUpdate) => {
    const { data } = await api.patch<FirmSettings>('/firm/settings', update);
    setSettings(data);
    return data;
  }, []);

  return { settings, error, save, reload: load };
}

interface FormProps {
  settings: FirmSettings;
  save: (update: FirmSettingsUpdate) => Promise<FirmSettings>;
  /** Called after a successful save (the wizard moves on). */
  onSaved?: () => unknown;
  saveLabel?: string;
}

function useSaving(onSaved?: () => unknown) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const run = async (action: () => Promise<unknown>, done = 'Saved.') => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await action();
      setMessage(done);
      await onSaved?.();
    } catch (err) {
      setError(apiErrorMessage(err, 'That could not be saved.'));
    } finally {
      setBusy(false);
    }
  };
  const status = (
    <>
      {error ? <p className="field-hint notice-error">{error}</p> : null}
      {message ? <p className="field-hint">{message}</p> : null}
    </>
  );
  return { busy, run, status };
}

function TextField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  multiline?: boolean;
  hint?: string;
}) {
  return (
    <label className="settings-field">
      <span>{props.label}</span>
      {props.multiline ? (
        <textarea
          rows={3}
          value={props.value}
          placeholder={props.placeholder}
          onChange={(event) => props.onChange(event.target.value)}
        />
      ) : (
        <input
          type={props.type ?? 'text'}
          value={props.value}
          placeholder={props.placeholder}
          onChange={(event) => props.onChange(event.target.value)}
        />
      )}
      {props.hint ? <small className="field-hint">{props.hint}</small> : null}
    </label>
  );
}

// ---------------------------------------------------------------- practice details

export function ProfileForm({ settings, save, onSaved, saveLabel = 'Save' }: FormProps) {
  const [profile, setProfile] = useState(settings.profile);
  const [address, setAddress] = useState(settings.billing.address);
  const { busy, run, status } = useSaving(onSaved);
  const field = (name: keyof typeof profile) => ({
    value: profile[name],
    onChange: (value: string) => setProfile({ ...profile, [name]: value }),
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    run(() => save({ profile, billing: { address } }));
  };
  return (
    <form className="settings-form" aria-label="Practice details" onSubmit={submit}>
      <TextField
        label="Physical or postal address"
        value={address}
        onChange={setAddress}
        multiline
        hint="Printed on invoices; required before invoices are issued."
      />
      <TextField
        label="Company registration number"
        placeholder="2015/123456/21"
        {...field('registrationNumber')}
      />
      <TextField label="Legal Practice Council number" {...field('lpcNumber')} />
      <TextField
        label="Fidelity Fund certificate"
        placeholder="Number and year"
        {...field('fidelityFundCertificate')}
      />
      <TextField label="Office email" type="email" {...field('email')} />
      <TextField label="Telephone" type="tel" {...field('phone')} />
      <TextField label="Website" placeholder="https://" {...field('website')} />
      <TextField
        label="Reply-to email"
        type="email"
        hint="Replies to emails sent from the system (invoices, invitations) go here."
        {...field('replyToEmail')}
      />
      {status}
      <button className="primary-button" disabled={busy}>
        {saveLabel}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------- name, colours, logo

const MAX_ASSET: Record<FirmAssetKind, number> = { logo: 1024 * 1024, icon: 256 * 1024 };

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function ColourField(props: { label: string; value: string; onChange: (value: string) => void }) {
  const ratio = isHexColor(props.value) ? contrastRatio(props.value, '#ffffff') : 0;
  return (
    <label className="settings-field">
      <span>{props.label}</span>
      <span className="colour-row">
        <input
          type="color"
          aria-label={`${props.label} picker`}
          value={isHexColor(props.value) && props.value.length === 7 ? props.value : '#000000'}
          onChange={(event) => props.onChange(event.target.value)}
        />
        <input
          aria-label={props.label}
          value={props.value}
          onChange={(event) => props.onChange(event.target.value.trim())}
        />
      </span>
      <small className={ratio >= MIN_BRAND_CONTRAST ? 'field-hint' : 'field-hint notice-error'}>
        {ratio
          ? `Contrast with white text ${ratio.toFixed(1)}:1${ratio >= MIN_BRAND_CONTRAST ? '' : ` (needs ${MIN_BRAND_CONTRAST}:1: choose a darker colour)`}`
          : 'Enter a colour such as #1f4e79'}
      </small>
    </label>
  );
}

export function BrandForm({ settings, save, onSaved, saveLabel = 'Save' }: FormProps) {
  const [brand, setBrand] = useState({
    legalName: settings.brand.legalName,
    tradingName: settings.brand.tradingName,
    primaryColor: settings.brand.primaryColor,
    accentColor: settings.brand.accentColor,
  });
  const [assets, setAssets] = useState({
    logo: settings.brand.logoUrl,
    icon: settings.brand.iconUrl,
  });
  const { busy, run, status } = useSaving(onSaved);

  const upload = (kind: FirmAssetKind) => (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    run(async () => {
      if (file.size > MAX_ASSET[kind]) {
        throw new Error(`The ${kind} must be ${MAX_ASSET[kind] / 1024} KB or smaller.`);
      }
      const { data } = await api.put<{ url: string }>(`/firm/assets/${kind}`, {
        contentType: file.type,
        contentBase64: await readBase64(file),
      });
      setAssets((current) => ({ ...current, [kind]: data.url }));
    }, `The ${kind} has been updated.`);
  };

  const remove = (kind: FirmAssetKind) =>
    run(async () => {
      await api.delete(`/firm/assets/${kind}`);
      setAssets((current) => ({ ...current, [kind]: null }));
    }, `The ${kind} has been removed.`);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    run(() => save({ brand }));
  };

  return (
    <form className="settings-form" aria-label="Name, logo and colours" onSubmit={submit}>
      <TextField
        label="Registered name"
        value={brand.legalName}
        onChange={(legalName) => setBrand({ ...brand, legalName })}
        hint="As registered, e.g. Nkosi and Partners Incorporated. Shown on invoices."
      />
      <TextField
        label="Trading name"
        value={brand.tradingName}
        onChange={(tradingName) => setBrand({ ...brand, tradingName })}
        hint="The name staff and clients see, and the sender name on emails."
      />
      <ColourField
        label="Main colour"
        value={brand.primaryColor}
        onChange={(primaryColor) => setBrand({ ...brand, primaryColor })}
      />
      <ColourField
        label="Accent colour"
        value={brand.accentColor}
        onChange={(accentColor) => setBrand({ ...brand, accentColor })}
      />
      <div
        className="brand-preview"
        aria-label="Preview"
        style={{ borderColor: brand.primaryColor }}
      >
        {assets.logo ? <img src={assets.logo} alt="Firm logo" /> : null}
        <strong style={{ color: isHexColor(brand.primaryColor) ? brand.primaryColor : undefined }}>
          {brand.tradingName || brand.legalName}
        </strong>
        <span
          className="brand-preview-button"
          style={{ background: isHexColor(brand.primaryColor) ? brand.primaryColor : undefined }}
        >
          Button
        </span>
        <span
          className="brand-preview-button"
          style={{ background: isHexColor(brand.accentColor) ? brand.accentColor : undefined }}
        >
          Accent
        </span>
      </div>
      {(['logo', 'icon'] as const).map((kind) => (
        <div key={kind} className="settings-field">
          <span>{kind === 'logo' ? 'Logo' : 'Browser icon'}</span>
          <span className="row-actions">
            <label className="secondary-button">
              {assets[kind] ? 'Replace' : 'Upload'} {kind === 'logo' ? 'logo' : 'icon'}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                aria-label={kind === 'logo' ? 'Logo file' : 'Icon file'}
                className="visually-hidden"
                disabled={busy}
                onChange={upload(kind)}
              />
            </label>
            {assets[kind] ? (
              <button
                type="button"
                className="link-button"
                disabled={busy}
                onClick={() => remove(kind)}
              >
                Remove
              </button>
            ) : null}
          </span>
          <small className="field-hint">
            {kind === 'logo'
              ? 'PNG or JPEG, up to 1 MB; a wide logo works best. It also goes on invoices.'
              : 'Square PNG, up to 256 KB. Without one, the logo is used.'}
          </small>
        </div>
      ))}
      {status}
      <button className="primary-button" disabled={busy}>
        {saveLabel}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------- invoicing and VAT

export function InvoicingForm({ settings, save, onSaved, saveLabel = 'Save' }: FormProps) {
  const [billing, setBilling] = useState(settings.billing);
  const { busy, run, status } = useSaving(onSaved);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    run(() =>
      save({
        billing: {
          vatRegistered: billing.vatRegistered,
          vatNumber: billing.vatRegistered ? billing.vatNumber || null : billing.vatNumber || null,
          bankDetails: billing.bankDetails,
          paymentTermsDays: billing.paymentTermsDays,
          invoiceFooter: billing.invoiceFooter,
        },
      }),
    );
  };
  return (
    <form className="settings-form" aria-label="Invoicing and VAT" onSubmit={submit}>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={billing.vatRegistered}
          onChange={(event) => setBilling({ ...billing, vatRegistered: event.target.checked })}
        />
        The firm is a VAT vendor (issues tax invoices)
      </label>
      {billing.vatRegistered ? (
        <TextField
          label="VAT number"
          value={billing.vatNumber ?? ''}
          onChange={(vatNumber) => setBilling({ ...billing, vatNumber })}
          placeholder="4xxxxxxxxx"
        />
      ) : null}
      <TextField
        label="Bank details for payments"
        value={billing.bankDetails}
        onChange={(bankDetails) => setBilling({ ...billing, bankDetails })}
        multiline
        hint="The business account. Never the trust account details in emails."
      />
      <label className="settings-field">
        <span>Payment terms (days)</span>
        <input
          type="number"
          min={0}
          max={365}
          value={billing.paymentTermsDays}
          onChange={(event) =>
            setBilling({ ...billing, paymentTermsDays: Number(event.target.value) })
          }
        />
      </label>
      <TextField
        label="Invoice footer"
        value={billing.invoiceFooter}
        onChange={(invoiceFooter) => setBilling({ ...billing, invoiceFooter })}
      />
      {status}
      <button className="primary-button" disabled={busy}>
        {saveLabel}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------- numbering and compliance

export function PracticeForm({ settings, save, onSaved, saveLabel = 'Save' }: FormProps) {
  const [casePrefix, setCasePrefix] = useState(settings.brand.casePrefix);
  const [invoicePrefix, setInvoicePrefix] = useState(settings.billing.invoicePrefix);
  const [ficaEnforced, setFicaEnforced] = useState(settings.ficaEnforced);
  const [retentionYears, setRetentionYears] = useState(
    settings.retentionIsDefault ? '' : String(Math.round(settings.retentionDays / 365)),
  );
  const { busy, run, status } = useSaving(onSaved);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    run(() =>
      save({
        brand: { casePrefix },
        billing: { invoicePrefix },
        ficaEnforced,
        retentionDays: retentionYears ? Number(retentionYears) * 365 : null,
      }),
    );
  };
  return (
    <form className="settings-form" aria-label="Numbering and compliance" onSubmit={submit}>
      <TextField
        label="Matter number prefix"
        value={casePrefix}
        onChange={(value) => setCasePrefix(value.toUpperCase())}
        hint={`New matters are numbered ${casePrefix || 'MAT'}-2026-0001 and so on.`}
      />
      <TextField
        label="Invoice number prefix"
        value={invoicePrefix}
        onChange={(value) => setInvoicePrefix(value.toUpperCase())}
        hint={`Invoices are numbered ${invoicePrefix || 'INV'}-000001, with no gaps.`}
      />
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={ficaEnforced}
          onChange={(event) => setFicaEnforced(event.target.checked)}
        />
        Open new matters only for FICA-verified clients
      </label>
      <label className="settings-field">
        <span>Keep closed matters for (years)</span>
        <input
          type="number"
          min={1}
          max={100}
          placeholder={`Platform default: ${Math.round(settings.retentionDays / 365)}`}
          value={retentionYears}
          onChange={(event) => setRetentionYears(event.target.value)}
        />
        <small className="field-hint">
          Closed matters are removed for good after this. Check your record-keeping obligations
          first.
        </small>
      </label>
      {status}
      <button className="primary-button" disabled={busy}>
        {saveLabel}
      </button>
    </form>
  );
}
