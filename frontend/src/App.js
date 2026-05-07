import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import IntakeForm from './components/IntakeForm';
import AssessmentCard from './components/AssessmentCard';
import CaseTable from './components/CaseTable';
import CaseWorkspace from './components/CaseWorkspace';
import OperationsHub from './components/OperationsHub';
import './App.css';

const api = axios.create({
  baseURL: '/api',
  timeout: 20000,
});

api.interceptors.request.use((config) => {
  const token = window.localStorage.getItem('mhl_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
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
  const [currentUser, setCurrentUser] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [authMode, setAuthMode] = useState('login');
  const [authBusy, setAuthBusy] = useState(false);
  const [authNotice, setAuthNotice] = useState({
    tone: 'info',
    message:
      'Sign in to access attorney workspace functions. Intake and assessment remain POPIA-safe and server-side.',
  });
  const [authForm, setAuthForm] = useState({
    fullName: '',
    email: '',
    password: '',
  });
  const [summary, setSummary] = useState(null);
  const [cases, setCases] = useState([]);
  const [selectedMatter, setSelectedMatter] = useState(null);
  const [selectedCaseId, setSelectedCaseId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const workspaceReady = useMemo(() => Boolean(currentUser), [currentUser]);

  const loadWorkspace = async () => {
    const [summaryResponse, casesResponse, submissionsResponse] =
      await Promise.all([
        api.get('/intake/summary'),
        api.get('/cases'),
        api.get('/intake/submissions'),
      ]);

    setSummary(summaryResponse.data);
    setCases(casesResponse.data);

    const latest = submissionsResponse.data[0];
    if (latest) {
      setSelectedMatter(latest);
      setSelectedCaseId(latest.matterCase?.id || latest.matterCase?.submissionId);
    }
  };

  const loadSession = async () => {
    const token = window.localStorage.getItem('mhl_token');
    if (!token) {
      setAuthReady(true);
      setLoading(false);
      return;
    }

    try {
      const { data } = await api.get('/auth/me');
      setCurrentUser(data.user);
      await loadWorkspace();
    } catch (error) {
      window.localStorage.removeItem('mhl_token');
      setAuthNotice({
        tone: 'warn',
        message: 'Your session expired. Please sign in again.',
      });
    } finally {
      setAuthReady(true);
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleAuthSubmit = async (event) => {
    event.preventDefault();
    setAuthBusy(true);
    try {
      const endpoint = authMode === 'register' ? '/auth/register' : '/auth/login';
      const payload =
        authMode === 'register'
          ? {
              fullName: authForm.fullName,
              email: authForm.email,
              password: authForm.password,
            }
          : {
              email: authForm.email,
              password: authForm.password,
            };

      const { data } = await api.post(endpoint, payload);
      window.localStorage.setItem('mhl_token', data.token);
      setCurrentUser(data.user);
      setAuthNotice({
        tone: 'success',
        message: `Welcome, ${data.user.fullName || data.user.email}.`,
      });
      await loadWorkspace();
    } catch (error) {
      setAuthNotice({
        tone: 'error',
        message:
          error?.response?.data?.message ||
          error?.message ||
          'Authentication failed.',
      });
    } finally {
      setAuthBusy(false);
    }
  };

  const handleLogout = () => {
    window.localStorage.removeItem('mhl_token');
    setCurrentUser(null);
    setSummary(null);
    setCases([]);
    setSelectedMatter(null);
    setSelectedCaseId(null);
    setAuthNotice({
      tone: 'info',
      message: 'Signed out. The workspace is now locked.',
    });
  };

  const handleSubmit = async (payload) => {
    setBusy(true);
    setAuthNotice({
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
      setSelectedCaseId(
        assessmentResponse.data.matterCase?.id ||
          assessmentResponse.data.matterCase?.submissionId ||
          assessmentResponse.data.id,
      );
      setAuthNotice({
        tone: 'success',
        message: `Intake ${submissionResponse.data.id} assessed successfully.`,
      });
      await loadWorkspace();
      return true;
    } catch (error) {
      setAuthNotice({
        tone: 'error',
        message:
          error?.response?.data?.message ||
          error?.message ||
          'Unable to submit intake.',
      });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const handleSelectCase = async (caseRow) => {
    try {
      const caseKey = caseRow.id || caseRow.submissionId || caseRow.caseNumber;
      setSelectedCaseId(caseKey);
      const { data } = await api.get(`/cases/${caseKey}`);
      setSelectedMatter(data);
    } catch (error) {
      setAuthNotice({
        tone: 'error',
        message: 'Could not load the selected matter.',
      });
    }
  };

  if (!authReady || loading) {
    return (
      <div className="app-shell">
        <div className="notice notice-info">Loading workspace...</div>
      </div>
    );
  }

  if (!workspaceReady) {
    return (
      <div className="app-shell auth-shell">
        <header className="hero">
          <div className="hero-copy">
            <div className="brand-mark">M</div>
            <div>
              <p className="eyebrow">Mohanoe Inc. Attorneys</p>
              <h1>Legal practice management platform</h1>
              <p className="hero-text">
                Encrypted intake, role-based workspace access, case management,
                and POPIA-safe AI triage.
              </p>
            </div>
          </div>
          <div className="hero-badges">
            <span className="pill pill-strong">Secure workspace</span>
            <span className="pill">Attorney access only</span>
            <span className="pill">Case operations</span>
          </div>
        </header>

        <section className="auth-grid">
          <div className="panel">
            <p className="panel-kicker">Authentication</p>
            <h2>{authMode === 'login' ? 'Sign in' : 'Create a user'}</h2>
            <form className="auth-form" onSubmit={handleAuthSubmit}>
              {authMode === 'register' ? (
                <Field label="Full name">
                  <input
                    value={authForm.fullName}
                    onChange={(event) =>
                      setAuthForm((current) => ({
                        ...current,
                        fullName: event.target.value,
                      }))
                    }
                    required
                  />
                </Field>
              ) : null}
              <Field label="Email">
                <input
                  type="email"
                  value={authForm.email}
                  onChange={(event) =>
                    setAuthForm((current) => ({
                      ...current,
                      email: event.target.value,
                    }))
                  }
                  required
                />
              </Field>
              <Field label="Password">
                <input
                  type="password"
                  value={authForm.password}
                  onChange={(event) =>
                    setAuthForm((current) => ({
                      ...current,
                      password: event.target.value,
                    }))
                  }
                  required
                />
              </Field>
              <div className="action-row">
                <button type="submit" className="primary-button" disabled={authBusy}>
                  {authBusy ? 'Working...' : authMode === 'login' ? 'Sign in' : 'Create user'}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() =>
                    setAuthMode((mode) => (mode === 'login' ? 'register' : 'login'))
                  }
                >
                  {authMode === 'login' ? 'Need an account?' : 'Have an account?'}
                </button>
              </div>
            </form>
          </div>

          <div className={`notice notice-${authNotice.tone}`}>
            {authNotice.message}
          </div>
        </section>
      </div>
    );
  }

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
              triage, and AI-assisted case assessment in one workspace.
            </p>
          </div>
        </div>
        <div className="hero-badges">
          <span className="pill pill-strong">Encrypted intake</span>
          <span className="pill">POPIA purpose limitation</span>
          <span className="pill">Attorney review first</span>
          <button type="button" className="secondary-button" onClick={handleLogout}>
            Sign out
          </button>
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
                  onClick={() =>
                    setAuthNotice({
                      tone: 'info',
                      message:
                        'Use the sample matter to test the full encrypted intake and assessment flow.',
                    })
                  }
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
            <CaseWorkspace
              api={api}
              selectedCaseId={selectedCaseId}
              onSelectCase={handleSelectCase}
              onChanged={loadWorkspace}
            />

            <OperationsHub
              api={api}
              selectedCaseId={selectedCaseId}
              cases={cases}
              onChanged={loadWorkspace}
            />

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

            <div className={`notice notice-${authNotice.tone}`}>
              {authNotice.message}
            </div>
          </aside>
        </section>
      </main>
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <label className="field">
      <div className="field-label">{label}</div>
      {hint ? <div className="field-hint">{hint}</div> : null}
      {children}
    </label>
  );
}

export default App;
