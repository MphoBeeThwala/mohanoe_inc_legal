import React, { useEffect, useState } from 'react';
import axios from 'axios';
import IntakeForm from './components/IntakeForm';
import AssessmentCard from './components/AssessmentCard';
import CaseTable from './components/CaseTable';
import './App.css';

const api = axios.create({
  baseURL: '/api',
  timeout: 20000,
});

const sampleMatter = {
  fullName: 'Thandi Nkosi',
  email: 'thandi.nkosi@example.com',
  phone: '+27821234567',
  practiceArea: 'Family Law',
  jurisdiction: 'Gauteng Division, Johannesburg',
  urgencyHint: 'high',
  matterSummary:
    'The client wants to move urgently because there is a threatened relocation of the minor child and the other party has stopped complying with an existing parenting plan.',
  requestedOutcome:
    'Emergency advice on custody, contact, and a possible interdict or urgent court application.',
  documentsMentioned:
    "Existing parenting plan, WhatsApp messages, school notices, and the child's birth certificate.",
  preferredLanguage: 'English',
};

function StatCard({ label, value, detail, tone = 'neutral' }) {
  return (
    <article className={`stat-card stat-${tone}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-detail">{detail}</div>
    </article>
  );
}

function App() {
  const [summary, setSummary] = useState(null);
  const [cases, setCases] = useState([]);
  const [selectedMatter, setSelectedMatter] = useState(null);
  const [notice, setNotice] = useState({
    tone: 'info',
    message:
      'Client-facing AI assessment is disabled in the browser. All triage runs server-side with PII redaction.',
  });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const loadWorkspace = async () => {
    const [summaryResponse, casesResponse, submissionsResponse] =
      await Promise.all([
        api.get('/intake/summary'),
        api.get('/intake/cases'),
        api.get('/intake/submissions'),
      ]);

    setSummary(summaryResponse.data);
    setCases(casesResponse.data);

    const latest = submissionsResponse.data[0];
    if (latest) {
      setSelectedMatter(latest);
    }
  };

  useEffect(() => {
    loadWorkspace()
      .catch(() => {
        setNotice({
          tone: 'warn',
          message:
            'The backend is not reachable yet. Start the API server on port 3001 and reload.',
        });
      })
      .finally(() => setLoading(false));
  }, []);

  const handleSubmit = async (payload) => {
    setBusy(true);
    setNotice({
      tone: 'info',
      message:
        'Submitting encrypted intake and generating an attorney-facing assessment...',
    });

    try {
      const submissionResponse = await api.post('/intake/submissions', payload);
      const assessmentResponse = await api.post(
        `/intake/submissions/${submissionResponse.data.id}/assess`,
      );

      setSelectedMatter(assessmentResponse.data);
      setNotice({
        tone: 'success',
        message: `Intake ${submissionResponse.data.id} assessed successfully.`,
      });
      await loadWorkspace();
      return true;
    } catch (error) {
      const message =
        error?.response?.data?.message ||
        error?.message ||
        'Unable to submit intake.';
      setNotice({ tone: 'error', message });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const handleSelectCase = async (caseRow) => {
    try {
      const { data } = await api.get(`/intake/submissions/${caseRow.submissionId}`);
      setSelectedMatter(data);
    } catch (error) {
      setNotice({
        tone: 'error',
        message: 'Could not load the selected matter.',
      });
    }
  };

  return (
    <div className="app-shell">
      <header className="hero">
        <div className="hero-copy">
          <div className="brand-mark">M</div>
          <div>
            <p className="eyebrow">Mohanoe Inc. Attorneys</p>
            <h1>Legal practice management with POPIA-safe AI intake</h1>
            <p className="hero-text">
              Day-to-day matter handling, encrypted client intake, attorney
              triage, and AI-assisted case assessment in a single workspace.
            </p>
          </div>
        </div>
        <div className="hero-badges">
          <span className="pill pill-strong">Encrypted intake</span>
          <span className="pill">POPIA purpose limitation</span>
          <span className="pill">Attorney review first</span>
        </div>
      </header>

      <main className="dashboard">
        <section className="summary-grid">
          <StatCard
            label="Open intakes"
            value={loading ? '...' : summary?.openIntakes ?? 0}
            detail="New matters waiting for attorney triage"
            tone="mint"
          />
          <StatCard
            label="AI assessed"
            value={loading ? '...' : summary?.assessedIntakes ?? 0}
            detail="Redacted briefs analyzed server-side"
            tone="blue"
          />
          <StatCard
            label="Live matters"
            value={loading ? '...' : summary?.liveCases ?? 0}
            detail="Cases created from intake submissions"
            tone="gold"
          />
          <StatCard
            label="Critical"
            value={loading ? '...' : summary?.criticalMatters ?? 0}
            detail="Priority reviews needing immediate attention"
            tone="rose"
          />
        </section>

        <section className="content-grid">
          <div className="primary-column">
            <div className="panel">
              <div className="panel-head">
                <div>
                  <p className="panel-kicker">Client intake</p>
                  <h2>Collect the matter, redact PII, then assess it</h2>
                </div>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setNotice({
                    tone: 'info',
                    message:
                      'Use the sample matter to test the full encrypted intake and assessment flow.',
                  })}
                >
                  Review flow
                </button>
              </div>

              <IntakeForm
                onSubmit={handleSubmit}
                busy={busy}
                sampleMatter={sampleMatter}
              />
            </div>

            <div className="panel">
              <div className="panel-head">
                <div>
                  <p className="panel-kicker">Case management</p>
                  <h2>Recent matters</h2>
                </div>
              </div>
              <CaseTable cases={cases} onSelectCase={handleSelectCase} />
            </div>
          </div>

          <aside className="secondary-column">
            <AssessmentCard matter={selectedMatter} />

            <div className="panel compliance-panel">
              <p className="panel-kicker">POPIA controls</p>
              <h2>How the AI path stays safer</h2>
              <ul className="compliance-list">
                <li>Raw intake payloads are encrypted before persistence.</li>
                <li>Only a redacted matter brief is sent to the model.</li>
                <li>Consent gates are required for both storage and AI review.</li>
                <li>Assessment output is attorney-facing, not client-facing.</li>
              </ul>
            </div>

            <div className={`notice notice-${notice.tone}`}>
              {notice.message}
            </div>
          </aside>
        </section>
      </main>
    </div>
  );
}

export default App;
