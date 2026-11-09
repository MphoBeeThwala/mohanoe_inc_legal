import React, { useEffect, useMemo, useState } from 'react';
import DismissibleNotice from './DismissibleNotice';

const initialDocumentForm = {
  title: '',
  documentType: 'correspondence',
  body: '',
  tags: '',
};

const initialInvoiceForm = {
  subject: '',
  invoiceNumber: '',
  lineDescription: '',
  lineAmount: '',
  currency: 'ZAR',
};

const initialLedgerForm = {
  entryType: 'payment',
  account: 'trust',
  amount: '',
  reference: '',
  notes: '',
};

const initialEventForm = {
  title: '',
  startsAt: '',
  eventType: 'deadline',
  location: '',
  notes: '',
};

const initialNotificationForm = {
  title: '',
  body: '',
  category: 'general',
  priority: 'medium',
  recipientRole: 'attorney',
};

const initialReportForm = {
  title: 'Practice snapshot',
  reportType: 'dashboard',
};

const initialComplianceForm = {
  requestType: 'access',
  subjectName: '',
  subjectEmail: '',
  caseRef: '',
  description: '',
};

const initialExportForm = {
  subjectEmail: '',
  caseRef: '',
};

function OperationsHub({ api, selectedCaseId, cases = [], currentUser, onChanged }) {
  const [tab, setTab] = useState('documents');
  const [documents, setDocuments] = useState([]);
  const [billingSummary, setBillingSummary] = useState(null);
  const [billingInvoices, setBillingInvoices] = useState([]);
  const [billingLedger, setBillingLedger] = useState([]);
  const [calendar, setCalendar] = useState([]);
  const [audit, setAudit] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [reports, setReports] = useState([]);
  const [complianceSummary, setComplianceSummary] = useState(null);
  const [complianceRequests, setComplianceRequests] = useState([]);
  const [exportPreview, setExportPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState(null);
  const [documentForm, setDocumentForm] = useState(initialDocumentForm);
  const [invoiceForm, setInvoiceForm] = useState(initialInvoiceForm);
  const [ledgerForm, setLedgerForm] = useState(initialLedgerForm);
  const [eventForm, setEventForm] = useState(initialEventForm);
  const [notificationForm, setNotificationForm] = useState(initialNotificationForm);
  const [reportForm, setReportForm] = useState(initialReportForm);
  const [complianceForm, setComplianceForm] = useState(initialComplianceForm);
  const [exportForm, setExportForm] = useState(initialExportForm);

  const selectedCase = useMemo(
    () => cases.find((item) => item.id === selectedCaseId) || null,
    [cases, selectedCaseId],
  );

  const loadBatch = async (paths) => {
    const results = await Promise.allSettled(paths.map((path) => api.get(path)));
    return results.map((result, index) => ({
      path: paths[index],
      ok: result.status === 'fulfilled',
      data: result.status === 'fulfilled' ? result.value.data : null,
    }));
  };

  const loadData = async () => {
    setLoading(true);
    const batchOne = await loadBatch([
      '/documents',
      '/billing/summary',
      '/billing/invoices',
      '/billing/ledger',
      '/calendar/upcoming',
    ]);
    const batchTwo = await loadBatch([
      '/audit',
      '/notifications',
      '/reports',
      '/compliance/summary',
      '/compliance/requests',
    ]);
    const responses = [...batchOne, ...batchTwo];
    const byPath = Object.fromEntries(responses.map((item) => [item.path, item]));
    const failed = responses.filter((item) => !item.ok);

    if (byPath['/documents']?.ok) setDocuments(byPath['/documents'].data);
    if (byPath['/billing/summary']?.ok) setBillingSummary(byPath['/billing/summary'].data);
    if (byPath['/billing/invoices']?.ok) setBillingInvoices(byPath['/billing/invoices'].data);
    if (byPath['/billing/ledger']?.ok) setBillingLedger(byPath['/billing/ledger'].data);
    if (byPath['/calendar/upcoming']?.ok) setCalendar(byPath['/calendar/upcoming'].data);
    if (byPath['/audit']?.ok) setAudit(byPath['/audit'].data);
    if (byPath['/notifications']?.ok) setNotifications(byPath['/notifications'].data);
    if (byPath['/reports']?.ok) setReports(byPath['/reports'].data);
    if (byPath['/compliance/summary']?.ok) setComplianceSummary(byPath['/compliance/summary'].data);
    if (byPath['/compliance/requests']?.ok) setComplianceRequests(byPath['/compliance/requests'].data);

    if (failed.length === responses.length) {
      throw new Error('All operations endpoints failed');
    }

    if (failed.length > 0) {
      setNotice({
        tone: 'warn',
        message: `Some operations data could not be loaded (${failed.length} of ${responses.length} requests).`,
      });
    }
    setLoading(false);
  };

  useEffect(() => {
    loadData().catch(() => {
      setLoading(false);
      setNotice({
        tone: 'warn',
        message: 'Operations data could not be loaded. Check your connection and try again.',
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCaseId]);

  const activeCaseId = selectedCaseId || selectedCase?.id || '';

  const submitDocument = async (event) => {
    event.preventDefault();
    if (!activeCaseId || !documentForm.title || !documentForm.body) {
      return;
    }

    setBusy(true);
    try {
      await api.post('/documents', {
        caseId: activeCaseId,
        title: documentForm.title,
        documentType: documentForm.documentType,
        body: documentForm.body,
        tags: documentForm.tags
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      });
      setDocumentForm(initialDocumentForm);
      await Promise.all([loadData(), onChanged?.()]);
      setNotice({ tone: 'success', message: 'Document saved.' });
    } catch (error) {
      setNotice({
        tone: 'error',
        message: error?.response?.data?.message || 'Could not save document.',
      });
    } finally {
      setBusy(false);
    }
  };

  const submitInvoice = async (event) => {
    event.preventDefault();
    if (!activeCaseId || !invoiceForm.subject || !invoiceForm.lineAmount) {
      return;
    }

    setBusy(true);
    try {
      await api.post('/billing/invoices', {
        caseId: activeCaseId,
        subject: invoiceForm.subject,
        invoiceNumber: invoiceForm.invoiceNumber,
        lineItems: [
          {
            description: invoiceForm.lineDescription || invoiceForm.subject,
            amount: invoiceForm.lineAmount,
            quantity: 1,
            rate: invoiceForm.lineAmount,
          },
        ],
        currency: invoiceForm.currency,
      });
      setInvoiceForm(initialInvoiceForm);
      await Promise.all([loadData(), onChanged?.()]);
      setNotice({ tone: 'success', message: 'Invoice issued.' });
    } catch (error) {
      setNotice({
        tone: 'error',
        message: error?.response?.data?.message || 'Could not issue invoice.',
      });
    } finally {
      setBusy(false);
    }
  };

  const submitLedger = async (event) => {
    event.preventDefault();
    if (!activeCaseId || !ledgerForm.amount) {
      return;
    }

    setBusy(true);
    try {
      await api.post('/billing/ledger', {
        caseId: activeCaseId,
        entryType: ledgerForm.entryType,
        account: ledgerForm.account,
        amount: ledgerForm.amount,
        reference: ledgerForm.reference,
        notes: ledgerForm.notes,
      });
      setLedgerForm(initialLedgerForm);
      await Promise.all([loadData(), onChanged?.()]);
      setNotice({ tone: 'success', message: 'Ledger entry recorded.' });
    } catch (error) {
      setNotice({
        tone: 'error',
        message: error?.response?.data?.message || 'Could not record ledger entry.',
      });
    } finally {
      setBusy(false);
    }
  };

  const submitEvent = async (event) => {
    event.preventDefault();
    if (!activeCaseId || !eventForm.title || !eventForm.startsAt) {
      return;
    }

    setBusy(true);
    try {
      await api.post('/calendar', {
        caseId: activeCaseId,
        title: eventForm.title,
        eventType: eventForm.eventType,
        startsAt: eventForm.startsAt,
        location: eventForm.location,
        notes: eventForm.notes,
      });
      setEventForm(initialEventForm);
      await Promise.all([loadData(), onChanged?.()]);
      setNotice({ tone: 'success', message: 'Calendar event added.' });
    } catch (error) {
      setNotice({
        tone: 'error',
        message: error?.response?.data?.message || 'Could not add calendar event.',
      });
    } finally {
      setBusy(false);
    }
  };

  const submitNotification = async (event) => {
    event.preventDefault();
    if (!notificationForm.title || !notificationForm.body) {
      return;
    }

    setBusy(true);
    try {
      await api.post('/notifications', notificationForm);
      setNotificationForm(initialNotificationForm);
      await Promise.all([loadData(), onChanged?.()]);
      setNotice({ tone: 'success', message: 'Notification created.' });
    } catch (error) {
      setNotice({
        tone: 'error',
        message: error?.response?.data?.message || 'Could not create notification.',
      });
    } finally {
      setBusy(false);
    }
  };

  const submitReport = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api.post('/reports', reportForm);
      await Promise.all([loadData(), onChanged?.()]);
      setNotice({ tone: 'success', message: 'Report generated.' });
    } catch (error) {
      setNotice({
        tone: 'error',
        message: error?.response?.data?.message || 'Could not generate report.',
      });
    } finally {
      setBusy(false);
    }
  };

  const submitComplianceRequest = async (event) => {
    event.preventDefault();
    if (!complianceForm.subjectName || !complianceForm.subjectEmail || !complianceForm.description) {
      return;
    }

    setBusy(true);
    try {
      await api.post('/compliance/requests', complianceForm);
      setComplianceForm(initialComplianceForm);
      await loadData();
      setNotice({ tone: 'success', message: 'Compliance request logged.' });
    } catch (error) {
      setNotice({
        tone: 'error',
        message: error?.response?.data?.message || 'Could not create compliance request.',
      });
    } finally {
      setBusy(false);
    }
  };

  const submitExportPreview = async (event) => {
    event.preventDefault();
    if (!exportForm.subjectEmail && !exportForm.caseRef) {
      return;
    }

    setBusy(true);
    try {
      const { data } = await api.get('/compliance/export', {
        params: exportForm,
      });
      setExportPreview(data);
      setNotice({ tone: 'success', message: 'Export preview generated.' });
    } catch (error) {
      setNotice({
        tone: 'error',
        message: error?.response?.data?.message || 'Could not generate export preview.',
      });
    } finally {
      setBusy(false);
    }
  };

  const fulfillComplianceRequest = async (requestId) => {
    setBusy(true);
    try {
      await api.post(`/compliance/requests/${requestId}/fulfill`, {
        status: 'fulfilled',
        responseSummary: 'Handled by practice operations team.',
      });
      await loadData();
      setNotice({ tone: 'success', message: 'Compliance request fulfilled.' });
    } catch (error) {
      setNotice({
        tone: 'error',
        message: error?.response?.data?.message || 'Could not fulfill request.',
      });
    } finally {
      setBusy(false);
    }
  };

  const runRetentionSweep = async () => {
    setBusy(true);
    try {
      await api.post('/compliance/retention/sweep');
      await loadData();
      setNotice({ tone: 'success', message: 'Retention sweep completed.' });
    } catch (error) {
      setNotice({
        tone: 'error',
        message: error?.response?.data?.message || 'Could not run retention sweep.',
      });
    } finally {
      setBusy(false);
    }
  };

  const markNotificationRead = async (notificationId) => {
    setBusy(true);
    try {
      await api.post(`/notifications/${notificationId}/read`);
      await loadData();
      setNotice({ tone: 'success', message: 'Notification marked as read.' });
    } catch (error) {
      setNotice({
        tone: 'error',
        message: error?.response?.data?.message || 'Could not update notification.',
      });
    } finally {
      setBusy(false);
    }
  };

  const tabs = [
    ['documents', 'Documents'],
    ['billing', 'Billing'],
    ['calendar', 'Calendar'],
    ['notifications', 'Notifications'],
    ['reports', 'Reports'],
    ['compliance', 'Compliance'],
    ['audit', 'Audit'],
  ];

  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <p className="panel-kicker">Practice operations</p>
          <h2>Documents, billing, calendar, notifications, reports, compliance, and audit</h2>
        </div>
      </div>

      <div className="tab-row">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`tab-button ${tab === key ? 'tab-active' : ''}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="mini-label">Selected matter</div>
      <div className="muted">
        {selectedCase?.caseNumber || 'No case selected — open a matter from Cases first'}
      </div>

      {loading ? <OpsSkeleton /> : null}

      {!loading && tab === 'documents' ? (
        <section className="ops-section">
          <form className="stack-form" onSubmit={submitDocument}>
            <input
              value={documentForm.title}
              onChange={(event) =>
                setDocumentForm((current) => ({
                  ...current,
                  title: event.target.value,
                }))
              }
              placeholder="Pleadings cover note"
            />
            <select
              value={documentForm.documentType}
              onChange={(event) =>
                setDocumentForm((current) => ({
                  ...current,
                  documentType: event.target.value,
                }))
              }
            >
              <option value="correspondence">Correspondence</option>
              <option value="pleading">Pleading</option>
              <option value="memo">Memo</option>
              <option value="agreement">Agreement</option>
              <option value="template">Template</option>
            </select>
            <textarea
              rows={4}
              value={documentForm.body}
              onChange={(event) =>
                setDocumentForm((current) => ({
                  ...current,
                  body: event.target.value,
                }))
              }
              placeholder="Document body"
            />
            <input
              value={documentForm.tags}
              onChange={(event) =>
                setDocumentForm((current) => ({
                  ...current,
                  tags: event.target.value,
                }))
              }
              placeholder="Tags, comma separated"
            />
            <button className="secondary-button" disabled={busy}>
              Save document
            </button>
          </form>

          <div className="mini-list">
            {documents.length ? (
              documents.slice(0, 5).map((item) => (
                <div key={item.id} className="mini-item">
                  <div>
                    <strong>{item.title}</strong>
                    <div className="muted">
                      {item.caseNumber} - {item.documentType}
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <EmptyHint
                message="No documents yet."
                hint={activeCaseId ? 'Save your first document above.' : 'Select a case to attach documents.'}
              />
            )}
          </div>
        </section>
      ) : null}

      {!loading && tab === 'billing' ? (
        <section className="ops-section">
          <div className="mini-grid">
            <Stat label="Invoices" value={billingSummary?.invoices ?? 0} />
            <Stat label="Outstanding" value={billingSummary?.outstanding ?? 0} />
            <Stat label="Trust" value={billingSummary?.trustBalance ?? 0} />
            <Stat label="Operating" value={billingSummary?.operatingBalance ?? 0} />
          </div>

          <form className="stack-form" onSubmit={submitInvoice}>
            <input
              value={invoiceForm.subject}
              onChange={(event) =>
                setInvoiceForm((current) => ({
                  ...current,
                  subject: event.target.value,
                }))
              }
              placeholder="Consultation and drafting"
            />
            <input
              value={invoiceForm.invoiceNumber}
              onChange={(event) =>
                setInvoiceForm((current) => ({
                  ...current,
                  invoiceNumber: event.target.value,
                }))
              }
              placeholder="INV-2026-001"
            />
            <input
              value={invoiceForm.lineDescription}
              onChange={(event) =>
                setInvoiceForm((current) => ({
                  ...current,
                  lineDescription: event.target.value,
                }))
              }
              placeholder="Line item description"
            />
            <input
              type="number"
              value={invoiceForm.lineAmount}
              onChange={(event) =>
                setInvoiceForm((current) => ({
                  ...current,
                  lineAmount: event.target.value,
                }))
              }
              placeholder="Amount"
            />
            <button className="secondary-button" disabled={busy}>
              Issue invoice
            </button>
          </form>

          <div className="mini-list">
            {billingInvoices.slice(0, 4).map((item) => (
              <div key={item.id} className="mini-item">
                <div>
                  <strong>{item.number}</strong>
                  <div className="muted">{item.subject}</div>
                </div>
                <div>{item.total}</div>
              </div>
            ))}
          </div>

          <div className="mini-list">
            {billingLedger.slice(0, 4).map((item) => (
              <div key={item.id} className="mini-item">
                <div>
                  <strong>{item.entryType}</strong>
                  <div className="muted">{item.reference || item.account}</div>
                </div>
                <div>{item.amount}</div>
              </div>
            ))}
          </div>

          <form className="stack-form" onSubmit={submitLedger}>
            <select
              value={ledgerForm.entryType}
              onChange={(event) =>
                setLedgerForm((current) => ({
                  ...current,
                  entryType: event.target.value,
                }))
              }
            >
              <option value="payment">Payment</option>
              <option value="trust_deposit">Trust deposit</option>
              <option value="trust_withdrawal">Trust withdrawal</option>
              <option value="fee_transfer">Fee transfer</option>
            </select>
            <select
              value={ledgerForm.account}
              onChange={(event) =>
                setLedgerForm((current) => ({
                  ...current,
                  account: event.target.value,
                }))
              }
            >
              <option value="trust">Trust</option>
              <option value="operating">Operating</option>
            </select>
            <input
              type="number"
              value={ledgerForm.amount}
              onChange={(event) =>
                setLedgerForm((current) => ({
                  ...current,
                  amount: event.target.value,
                }))
              }
              placeholder="Amount"
            />
            <input
              value={ledgerForm.reference}
              onChange={(event) =>
                setLedgerForm((current) => ({
                  ...current,
                  reference: event.target.value,
                }))
              }
              placeholder="Reference"
            />
            <textarea
              rows={3}
              value={ledgerForm.notes}
              onChange={(event) =>
                setLedgerForm((current) => ({
                  ...current,
                  notes: event.target.value,
                }))
              }
              placeholder="Notes"
            />
            <button className="secondary-button" disabled={busy}>
              Record ledger entry
            </button>
          </form>
        </section>
      ) : null}

      {!loading && tab === 'calendar' ? (
        <section className="ops-section">
          <form className="stack-form" onSubmit={submitEvent}>
            <input
              value={eventForm.title}
              onChange={(event) =>
                setEventForm((current) => ({
                  ...current,
                  title: event.target.value,
                }))
              }
              placeholder="High court appearance"
            />
            <input
              type="datetime-local"
              value={eventForm.startsAt}
              onChange={(event) =>
                setEventForm((current) => ({
                  ...current,
                  startsAt: event.target.value,
                }))
              }
            />
            <select
              value={eventForm.eventType}
              onChange={(event) =>
                setEventForm((current) => ({
                  ...current,
                  eventType: event.target.value,
                }))
              }
            >
              <option value="deadline">Deadline</option>
              <option value="hearing">Hearing</option>
              <option value="client_meeting">Client meeting</option>
              <option value="internal">Internal</option>
            </select>
            <input
              value={eventForm.location}
              onChange={(event) =>
                setEventForm((current) => ({
                  ...current,
                  location: event.target.value,
                }))
              }
              placeholder="Courtroom / virtual link"
            />
            <textarea
              rows={3}
              value={eventForm.notes}
              onChange={(event) =>
                setEventForm((current) => ({
                  ...current,
                  notes: event.target.value,
                }))
              }
              placeholder="Notes"
            />
            <button className="secondary-button" disabled={busy}>
              Add event
            </button>
          </form>

          <div className="mini-list">
            {calendar.length ? (
              calendar.slice(0, 6).map((item) => (
                <div key={item.id} className="mini-item">
                  <div>
                    <strong>{item.title}</strong>
                    <div className="muted">
                      {item.startsAt} - {item.eventType}
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <EmptyHint message="No upcoming events." hint="Add a deadline or hearing above." />
            )}
          </div>
        </section>
      ) : null}

      {!loading && tab === 'notifications' ? (
        <section className="ops-section">
          <div className="mini-grid">
            <Stat
              label="Unread"
              value={notifications.filter((item) => !item.isRead).length}
            />
            <Stat label="Total" value={notifications.length} />
          </div>

          <form className="stack-form" onSubmit={submitNotification}>
            <input
              value={notificationForm.title}
              onChange={(event) =>
                setNotificationForm((current) => ({
                  ...current,
                  title: event.target.value,
                }))
              }
              placeholder="Urgent hearing reminder"
            />
            <textarea
              rows={3}
              value={notificationForm.body}
              onChange={(event) =>
                setNotificationForm((current) => ({
                  ...current,
                  body: event.target.value,
                }))
              }
              placeholder="Notification body"
            />
            <select
              value={notificationForm.category}
              onChange={(event) =>
                setNotificationForm((current) => ({
                  ...current,
                  category: event.target.value,
                }))
              }
            >
              <option value="general">General</option>
              <option value="deadline">Deadline</option>
              <option value="billing">Billing</option>
              <option value="case_update">Case update</option>
            </select>
            <select
              value={notificationForm.priority}
              onChange={(event) =>
                setNotificationForm((current) => ({
                  ...current,
                  priority: event.target.value,
                }))
              }
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
            <select
              value={notificationForm.recipientRole}
              onChange={(event) =>
                setNotificationForm((current) => ({
                  ...current,
                  recipientRole: event.target.value,
                }))
              }
            >
              <option value="attorney">Attorney</option>
              <option value="paralegal">Paralegal</option>
              <option value="admin">Admin</option>
            </select>
            <button className="secondary-button" disabled={busy}>
              Send notification
            </button>
          </form>

          <div className="mini-list">
            {notifications.slice(0, 6).map((item) => (
              <div key={item.id} className="mini-item">
                <div>
                  <strong>{item.title}</strong>
                  <div className="muted">{item.body}</div>
                </div>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => markNotificationRead(item.id)}
                  disabled={busy || item.isRead}
                >
                  {item.isRead ? 'Read' : 'Mark read'}
                </button>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {!loading && tab === 'reports' ? (
        <section className="ops-section">
          <div className="mini-grid">
            <Stat label="Snapshots" value={reports.length} />
            <Stat label="Unread notifications" value={notifications.filter((item) => !item.isRead).length} />
          </div>

          <form className="stack-form" onSubmit={submitReport}>
            <input
              value={reportForm.title}
              onChange={(event) =>
                setReportForm((current) => ({
                  ...current,
                  title: event.target.value,
                }))
              }
              placeholder="Practice snapshot"
            />
            <select
              value={reportForm.reportType}
              onChange={(event) =>
                setReportForm((current) => ({
                  ...current,
                  reportType: event.target.value,
                }))
              }
            >
              <option value="dashboard">Dashboard</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
            <button className="secondary-button" disabled={busy}>
              Generate report
            </button>
          </form>

          <div className="mini-list">
            {reports.slice(0, 5).map((item) => (
              <div key={item.id} className="mini-item">
                <div>
                  <strong>{item.title}</strong>
                  <div className="muted">{item.reportType}</div>
                </div>
                <div className="muted">{item.createdAt}</div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {!loading && tab === 'compliance' ? (
        <section className="ops-section">
          <div className="mini-grid">
            <Stat label="Open requests" value={complianceSummary?.openRequests ?? 0} />
            <Stat label="Fulfilled" value={complianceSummary?.fulfilledRequests ?? 0} />
            <Stat label="Retention days" value={complianceSummary?.retentionDays ?? 0} />
            <Stat label="Eligible" value={complianceSummary?.eligibleForRetention ?? 0} />
          </div>

          <form className="stack-form" onSubmit={submitComplianceRequest}>
            <select
              value={complianceForm.requestType}
              onChange={(event) =>
                setComplianceForm((current) => ({
                  ...current,
                  requestType: event.target.value,
                }))
              }
            >
              <option value="access">Access</option>
              <option value="correction">Correction</option>
              <option value="deletion">Deletion</option>
              <option value="export">Export</option>
              <option value="objection">Objection</option>
            </select>
            <input
              value={complianceForm.subjectName}
              onChange={(event) =>
                setComplianceForm((current) => ({
                  ...current,
                  subjectName: event.target.value,
                }))
              }
              placeholder="Subject name"
            />
            <input
              type="email"
              value={complianceForm.subjectEmail}
              onChange={(event) =>
                setComplianceForm((current) => ({
                  ...current,
                  subjectEmail: event.target.value,
                }))
              }
              placeholder="subject@example.com"
            />
            <input
              value={complianceForm.caseRef}
              onChange={(event) =>
                setComplianceForm((current) => ({
                  ...current,
                  caseRef: event.target.value,
                }))
              }
              placeholder="Case number or submission id"
            />
            <textarea
              rows={3}
              value={complianceForm.description}
              onChange={(event) =>
                setComplianceForm((current) => ({
                  ...current,
                  description: event.target.value,
                }))
              }
              placeholder="Request details"
            />
            <button className="secondary-button" disabled={busy}>
              Log compliance request
            </button>
          </form>

          <form className="stack-form" onSubmit={submitExportPreview}>
            <input
              type="email"
              value={exportForm.subjectEmail}
              onChange={(event) =>
                setExportForm((current) => ({
                  ...current,
                  subjectEmail: event.target.value,
                }))
              }
              placeholder="Export subject email"
            />
            <input
              value={exportForm.caseRef}
              onChange={(event) =>
                setExportForm((current) => ({
                  ...current,
                  caseRef: event.target.value,
                }))
              }
              placeholder="Case ref for export"
            />
            <button className="secondary-button" disabled={busy}>
              Generate export preview
            </button>
          </form>

          {currentUser?.role === 'admin' ? (
            <button type="button" className="secondary-button" onClick={runRetentionSweep} disabled={busy}>
              Run retention sweep
            </button>
          ) : null}

          {exportPreview ? (
            <div className="panel nested-panel">
              <p className="panel-kicker">Export preview</p>
              <div className="mini-grid">
                <Stat label="Submissions" value={exportPreview.submissions?.length ?? 0} />
                <Stat label="Cases" value={exportPreview.cases?.length ?? 0} />
                <Stat label="Documents" value={exportPreview.documents?.length ?? 0} />
                <Stat label="Invoices" value={exportPreview.invoices?.length ?? 0} />
              </div>
              <div className="muted">{exportPreview.notices?.join(' ')}</div>
            </div>
          ) : null}

          <div className="mini-list">
            {complianceRequests.slice(0, 6).map((item) => (
              <div key={item.id} className="mini-item">
                <div>
                  <strong>{item.requestType}</strong>
                  <div className="muted">{item.subjectName} - {item.status}</div>
                </div>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => fulfillComplianceRequest(item.id)}
                  disabled={busy || item.status === 'fulfilled'}
                >
                  {item.status === 'fulfilled' ? 'Fulfilled' : 'Fulfill'}
                </button>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {!loading && tab === 'audit' ? (
        <section className="ops-section">
          <div className="mini-list">
            {audit.length ? (
              audit.slice(0, 8).map((item) => (
                <div key={item.id} className="mini-item">
                  <div>
                    <strong>{item.action}</strong>
                    <div className="muted">{item.summary}</div>
                  </div>
                  <div className="muted">{item.createdAt}</div>
                </div>
              ))
            ) : (
              <EmptyHint message="No audit entries yet." hint="Activity will appear here as you work." />
            )}
          </div>
        </section>
      ) : null}

      <DismissibleNotice
        tone={notice?.tone}
        message={notice?.message}
        onDismiss={() => setNotice(null)}
      />
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="mini-stat">
      <div className="mini-label">{label}</div>
      <strong>{value}</strong>
    </div>
  );
}

function OpsSkeleton() {
  return (
    <div className="ops-skeleton" aria-busy="true" aria-label="Loading operations data">
      <div className="skeleton-line skeleton-wide" />
      <div className="skeleton-line" />
      <div className="skeleton-line skeleton-short" />
      <div className="skeleton-grid">
        <div className="skeleton-block" />
        <div className="skeleton-block" />
        <div className="skeleton-block" />
      </div>
    </div>
  );
}

function EmptyHint({ message, hint }) {
  return (
    <div className="empty-state empty-state-compact">
      <p>{message}</p>
      {hint ? <p className="muted">{hint}</p> : null}
    </div>
  );
}

export default OperationsHub;
