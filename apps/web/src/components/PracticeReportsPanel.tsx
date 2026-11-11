// Practice reports: WIP, debtors, utilisation, realisation and a fee-earner
// summary, for a date range, with a CSV download. Firm-wide for those with
// reports.firm; otherwise the signed-in person's own figures.
import { useCallback, useEffect, useState } from 'react';
import type {
  DebtorBuckets,
  DebtorsReport,
  FeeEarnerReport,
  PracticeReportKind,
  RealisationReport,
  UtilisationReport,
  WipReport,
} from '@ahava88/shared';
import { api, apiErrorMessage } from '../api';

const KINDS: Array<[PracticeReportKind, string]> = [
  ['wip', 'Work in progress'],
  ['debtors', 'Debtors'],
  ['utilisation', 'Utilisation'],
  ['realisation', 'Realisation'],
  ['fee-earners', 'Fee earners'],
];

type AnyReport =
  WipReport | DebtorsReport | UtilisationReport | RealisationReport | FeeEarnerReport;

const rand = (cents: number) =>
  `R ${(cents / 100).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (value: number | null) => (value === null ? '—' : `${(value * 100).toFixed(1)}%`);
const today = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Johannesburg',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

function Table({ head, rows }: { head: string[]; rows: Array<Array<string | number>> }) {
  return (
    <table className="data-table">
      <thead>
        <tr>
          {head.map((h) => (
            <th key={h}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.length ? (
          rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j}>{cell}</td>
              ))}
            </tr>
          ))
        ) : (
          <tr>
            <td colSpan={head.length}>Nothing for this period.</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

const buckets = (b: DebtorBuckets) =>
  [b.current, b.days30, b.days60, b.days90, b.days120, b.total].map(rand);

function View({ kind, report }: { kind: PracticeReportKind; report: AnyReport }) {
  if (kind === 'wip') {
    const r = report as WipReport;
    return (
      <>
        <p>
          Unbilled: <strong>{rand(r.totals.totalCents)}</strong> ({r.totals.hours} h of time,{' '}
          {rand(r.totals.disbursementCents)} disbursements)
        </p>
        <Table
          head={['Matter', 'Hours', 'Time', 'Disbursements', 'Total', 'Oldest work']}
          rows={r.matters.map((m) => [
            m.caseNumber,
            m.hours,
            rand(m.timeCents),
            rand(m.disbursementCents),
            rand(m.totalCents),
            m.oldestWorkDate ?? '',
          ])}
        />
        <Table
          head={['Fee earner', 'Hours', 'Time']}
          rows={r.feeEarners.map((e) => [e.name, e.hours, rand(e.timeCents)])}
        />
      </>
    );
  }
  if (kind === 'debtors') {
    const r = report as DebtorsReport;
    const rows = r.clients.map((c) => [c.clientLabel, c.invoices, ...buckets(c)]);
    if (r.restricted) rows.push(['Restricted matters', '', ...buckets(r.restricted)]);
    rows.push(['Total', '', ...buckets(r.totals)]);
    return (
      <Table
        head={['Client', 'Invoices', 'Current', '1–30 days', '31–60', '61–90', '90+', 'Total']}
        rows={rows}
      />
    );
  }
  if (kind === 'utilisation') {
    const r = report as UtilisationReport;
    return (
      <Table
        head={['Fee earner', 'Month', 'Billable h', 'Non-billable h', 'Target h', 'Utilisation']}
        rows={r.rows.map((row) => [
          row.name,
          row.month,
          row.billableHours,
          row.nonBillableHours,
          row.targetHours ?? '—',
          pct(row.utilisation),
        ])}
      />
    );
  }
  if (kind === 'realisation') {
    const r = report as RealisationReport;
    return (
      <>
        <p>
          Billing realisation <strong>{pct(r.totals.billingRealisation)}</strong> · collection
          realisation <strong>{pct(r.totals.collectionRealisation)}</strong>
        </p>
        <Table
          head={[
            'Fee earner',
            'Recorded',
            'Billed',
            'Written off',
            'Unbilled',
            'Billing realisation',
          ]}
          rows={r.feeEarners.map((e) => [
            e.name,
            rand(e.recordedCents),
            rand(e.billedCents),
            rand(e.writtenOffCents),
            rand(e.unbilledCents),
            pct(e.billingRealisation),
          ])}
        />
        <Table
          head={['Matter', 'Recorded', 'Billed', 'Invoiced', 'Collected', 'Collection realisation']}
          rows={r.matters.map((m) => [
            m.caseNumber,
            rand(m.recordedCents),
            rand(m.billedCents),
            rand(m.invoicedCents),
            rand(m.collectedCents),
            pct(m.collectionRealisation),
          ])}
        />
      </>
    );
  }
  const r = report as FeeEarnerReport;
  return (
    <Table
      head={['Fee earner', 'Billable h', 'Non-billable h', 'Recorded', 'Billed', 'Written off']}
      rows={r.rows.map((row) => [
        row.name,
        row.billableHours,
        row.nonBillableHours,
        rand(row.recordedCents),
        rand(row.billedCents),
        rand(row.writtenOffCents),
      ])}
    />
  );
}

export default function PracticeReportsPanel() {
  const [kind, setKind] = useState<PracticeReportKind>('wip');
  const [from, setFrom] = useState(() => `${today().slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const [loaded, setLoaded] = useState<{ kind: PracticeReportKind; data: AnyReport } | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setError('');
    api
      .get<AnyReport>(`/reports/practice/${kind}`, { params: { from, to } })
      .then(({ data }) => setLoaded({ kind, data }))
      .catch((err) => {
        setLoaded(null);
        setError(apiErrorMessage(err, 'The report could not be loaded.'));
      });
  }, [kind, from, to]);
  useEffect(load, [load]);

  // Show a result only for the report and period it was loaded for.
  const report =
    loaded && loaded.kind === kind && loaded.data.from === from && loaded.data.to === to
      ? loaded.data
      : null;
  const csvHref = `/api/reports/practice/${kind}.csv?${new URLSearchParams({ from, to })}`;
  return (
    <section aria-label="Practice reports" className="practice-reports">
      <h3>Practice reports</h3>
      <div className="action-row">
        <label>
          Report{' '}
          <select value={kind} onChange={(e) => setKind(e.target.value as PracticeReportKind)}>
            {KINDS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          From <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          To <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        </label>
        <a className="secondary-button" href={csvHref} download>
          Download CSV
        </a>
      </div>
      {report ? (
        <p className="field-hint">
          {report.scope === 'firm'
            ? 'Whole firm. Restricted matters you cannot see are counted but not named.'
            : 'Your own time and disbursements, on matters you can see.'}
          {kind === 'debtors' ? ' Owed at the end of the period.' : ''}
          {kind === 'wip' ? ' Unbilled at the end of the period.' : ''}
        </p>
      ) : null}
      {error ? <p className="notice notice-error">{error}</p> : null}
      {report ? <View kind={kind} report={report} /> : null}
    </section>
  );
}
