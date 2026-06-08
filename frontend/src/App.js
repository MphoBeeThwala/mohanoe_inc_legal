import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import IntakeForm from './components/IntakeForm';
import AssessmentCard from './components/AssessmentCard';
import CaseTable from './components/CaseTable';
import CaseWorkspace from './components/CaseWorkspace';
import OperationsHub from './components/OperationsHub';
import ErrorBoundary from './components/ErrorBoundary';
import DismissibleNotice from './components/DismissibleNotice';
import './App.css';

const api = axios.create({
  baseURL: '/api',
  timeout: 35000,
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

const NAV_SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'intake', label: 'Intake' },
  { id: 'cases', label: 'Cases' },
  { id: 'operations', label: 'Operations' },
];

function StatCard({ label, value, detail, tone = 'neutral' }) {
  return (
    <article className={`stat-card stat-${tone}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-detail">{detail}</div>
    </article>
  );
}

function LoadingShell() {
  return (
    <div className="app-shell">
      <div className="loading-shell" aria-busy="true" aria-label="Loading workspace">
        <div className="skeleton-hero" />
        <div className="summary-grid">
          <div className="skeleton-stat" />
          <div className="skeleton-stat" />
          <div className="skeleton-stat" />
          <div className="skeleton-stat" />
        </div>
        <div className="skeleton-panel" />
      </div>
    </div>
  );
}

function App() {
  const [currentUser, setCurrentUser] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [authNotice, setAuthNotice] = useState({
    tone: 'info',
    message: 'Sign in with your staff account to access the practice workspace.',
  });
  const [authConfig, setAuthConfig] = useState({
    publicRegistration: false,
    seedAdminOnStartup: false,
  });
  const [authMode, setAuthMode] = useState('login');
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
  const [activeSection, setActiveSection] = useState('overview');

  const sectionRefs = useRef({});
  const workspaceReady = useMemo(() => Boolean(currentUser), [currentUser]);

  const scrollToSection = useCallback((sectionId) => {
    const node = sectionRefs.current[sectionId];
    if (node) {
      node.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setActiveSection(sectionId);
    }
  }, []);

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
    const bootstrap = async () => {
      try {
        const { data } = await api.get('/auth/config');
        setAuthConfig(data);
        if (data.publicRegistration) {
          setAuthNotice({
            tone: 'info',
            message:
              'Create the first staff account, then sign in to open the workspace.',
          });
        }
      } catch (error) {
        // Auth config is optional for rendering the sign-in shell.
      }

      await loadSession();
    };

    bootstrap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!workspaceReady) {
      return undefined;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (visible[0]?.target?.dataset?.section) {
          setActiveSection(visible[0].target.dataset.section);
        }
      },
      { rootMargin: '-20% 0px -55% 0px', threshold: [0.15, 0.4, 0.7] },
    );

    NAV_SECTIONS.forEach(({ id }) => {
      const node = sectionRefs.current[id];
      if (node) {
        observer.observe(node);
      }
    });

    return () => observer.disconnect();
  }, [workspaceReady]);

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
      scrollToSection('cases');
    } catch (error) {
      setAuthNotice({
        tone: 'error',
        message: 'Could not load the selected matter.',
      });
    }
  };

  if (!authReady || loading) {
    return <LoadingShell />;
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
            <h2>{authMode === 'register' ? 'Create staff account' : 'Sign in'}</h2>
            <form className="auth-form" onSubmit={handleAuthSubmit}>
              {authMode === 'register' ? (
                <Field label="Full name" id="auth-fullName">
                  <input
                    id="auth-fullName"
                    type="text"
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
              <Field label="Email" id="auth-email">
                <input
                  id="auth-email"
                  type="email"
                  autoComplete="email"
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
              <Field label="Password" id="auth-password">
                <input
                  id="auth-password"
                  type="password"
                  autoComplete={authMode === 'register' ? 'new-password' : 'current-password'}
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
                  {authBusy
                    ? 'Working...'
                    : authMode === 'register'
                      ? 'Create account'
                      : 'Sign in'}
                </button>
                {authConfig.publicRegistration ? (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() =>
                      setAuthMode((current) =>
                        current === 'login' ? 'register' : 'login',
                      )
                    }
                  >
                    {authMode === 'login' ? 'Create account' : 'Back to sign in'}
                  </button>
                ) : null}
              </div>
            </form>
            <div className="field-hint">
              {authConfig.publicRegistration
                ? 'Demo mode: create a staff account with a password of at least 12 characters including upper-case, lower-case, and a number.'
                : 'Self-registration is disabled. Ask an administrator to provision a staff account.'}
            </div>
          </div>

          <DismissibleNotice
            tone={authNotice.tone}
            message={authNotice.message}
            onDismiss={() => setAuthNotice({ tone: 'info', message: '' })}
          />
        </section>
      </div>
    );
  }

  const activeLabel =
    NAV_SECTIONS.find((section) => section.id === activeSection)?.label || 'Overview';

  return (
    <div className="app-shell">
      <header className="hero hero-compact">
        <div className="hero-copy">
          <div className="brand-mark">M</div>
          <div>
            <p className="eyebrow">Mohanoe Inc. Attorneys</p>
            <h1>Practice workspace</h1>
            <p className="hero-text">
              Encrypted intake, matter triage, and day-to-day case operations.
            </p>
          </div>
        </div>
        <div className="user-strip">
          <div className="user-chip" title={currentUser.email}>
            <span className="user-name">{currentUser.fullName || currentUser.email}</span>
            <span className="user-role">{currentUser.role || 'staff'}</span>
          </div>
          <button type="button" className="secondary-button sign-out-button" onClick={handleLogout}>
            Sign out
          </button>
        </div>
      </header>

      <nav className="workspace-nav" aria-label="Workspace sections">
        <div className="workspace-nav-inner">
          <div className="nav-links">
            {NAV_SECTIONS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                className={`nav-link ${activeSection === id ? 'nav-link-active' : ''}`}
                onClick={() => scrollToSection(id)}
                aria-current={activeSection === id ? 'page' : undefined}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="breadcrumb" aria-label="Current section">
            <span className="breadcrumb-label">You are in</span>
            <strong>{activeLabel}</strong>
          </div>
        </div>
      </nav>

      <DismissibleNotice
        tone={authNotice.tone}
        message={authNotice.message}
        onDismiss={() => setAuthNotice({ tone: 'info', message: '' })}
      />

      <main className="dashboard">
        <section
          id="section-overview"
          className="dashboard-section"
          data-section="overview"
          ref={(node) => {
            sectionRefs.current.overview = node;
          }}
        >
          <div className="summary-grid">
            <StatCard
              label="Open intakes"
              value={summary?.openIntakes ?? 0}
              detail="New matters waiting for attorney triage"
              tone="mint"
            />
            <StatCard
              label="AI assessed"
              value={summary?.assessedIntakes ?? 0}
              detail="Redacted briefs analyzed server-side"
              tone="blue"
            />
            <StatCard
              label="Live matters"
              value={summary?.liveCases ?? 0}
              detail="Cases created from intake submissions"
              tone="gold"
            />
            <StatCard
              label="Critical"
              value={summary?.criticalMatters ?? 0}
              detail="Priority reviews needing immediate attention"
              tone="rose"
            />
          </div>
        </section>

        <section className="content-grid">
          <div className="primary-column">
            <section
              id="section-intake"
              className="dashboard-section"
              data-section="intake"
              ref={(node) => {
                sectionRefs.current.intake = node;
              }}
            >
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
                  onGoToCases={() => scrollToSection('cases')}
                />
              </div>
            </section>

            <section
              id="section-cases"
              className="dashboard-section"
              data-section="cases"
              ref={(node) => {
                sectionRefs.current.cases = node;
              }}
            >
              <div className="panel">
                <div className="panel-head">
                  <div>
                    <p className="panel-kicker">Case management</p>
                    <h2>Recent matters</h2>
                  </div>
                </div>
                <CaseTable
                  cases={cases}
                  onSelectCase={handleSelectCase}
                  onGoToIntake={() => scrollToSection('intake')}
                />
              </div>
            </section>
          </div>

          <aside className="secondary-column">
            <ErrorBoundary label="Assessment">
              <AssessmentCard
                matter={selectedMatter}
                onGoToIntake={() => scrollToSection('intake')}
                onGoToCases={() => scrollToSection('cases')}
              />
            </ErrorBoundary>

            <CaseWorkspace
              api={api}
              selectedCaseId={selectedCaseId}
              onSelectCase={handleSelectCase}
              onChanged={loadWorkspace}
            />

            <section
              id="section-operations"
              className="dashboard-section"
              data-section="operations"
              ref={(node) => {
                sectionRefs.current.operations = node;
              }}
            >
              <ErrorBoundary label="Operations">
                <OperationsHub
                  api={api}
                  selectedCaseId={selectedCaseId}
                  cases={cases}
                  currentUser={currentUser}
                  onChanged={loadWorkspace}
                />
              </ErrorBoundary>
            </section>

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
          </aside>
        </section>
      </main>
    </div>
  );
}

function Field({ label, hint, id, children }) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      {hint ? <div className="field-hint">{hint}</div> : null}
      {children}
    </div>
  );
}

export default App;
