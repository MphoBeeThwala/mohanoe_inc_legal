import React from 'react';

function ensureStringArray(value) {
  if (Array.isArray(value)) {
    return value.filter((item) => item != null && item !== '').map(String);
  }
  if (value == null || value === '') {
    return [];
  }
  if (typeof value === 'string') {
    return [value];
  }
  if (typeof value === 'object') {
    return Object.values(value)
      .filter((item) => item != null && item !== '')
      .map(String);
  }
  return [String(value)];
}

function AssessmentCard({ matter, onGoToIntake, onGoToCases }) {
  if (!matter) {
    return (
      <div className="panel assessment-panel">
        <p className="panel-kicker">Assessment</p>
        <h2>No matter selected</h2>
        <p className="muted">
          Submit an intake or choose a case to view the attorney-facing triage.
        </p>
        <div className="empty-actions">
          {onGoToIntake ? (
            <button type="button" className="primary-button" onClick={onGoToIntake}>
              New intake
            </button>
          ) : null}
          {onGoToCases ? (
            <button type="button" className="secondary-button" onClick={onGoToCases}>
              Browse cases
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  const assessment = matter.assessment || {};
  const popiaNotes = ensureStringArray(assessment.popiaNotes);

  return (
    <div className="panel assessment-panel">
      <p className="panel-kicker">Assessment</p>
      <h2>{assessment.matterType || matter.practiceArea || 'Matter triage'}</h2>
      <div className="assessment-meta">
        <span className={`chip chip-${String(assessment.urgency || 'medium')}`}>
          {assessment.urgency || 'medium'}
        </span>
        <span className="chip chip-neutral">{assessment.provider || 'rules'}</span>
        <span className="chip chip-neutral">
          {matter.clientLabel || 'Client A'}
        </span>
      </div>

      <p className="assessment-summary">
        {assessment.summary ||
          matter.summary ||
          'The matter has not been assessed yet.'}
      </p>

      <Section title="Key facts" items={assessment.keyFacts} />
      <Section title="Attorney questions" items={assessment.attorneyQuestions} />
      <Section
        title="Recommended documents"
        items={assessment.recommendedDocuments}
      />
      <Section title="Compliance flags" items={assessment.complianceFlags} />
      <Section title="Next actions" items={assessment.nextActions} />

      <div className="assessment-footer">
        <div>
          <div className="mini-label">Confidence</div>
          <strong>{formatConfidence(assessment.confidence)}</strong>
        </div>
        <div>
          <div className="mini-label">Model</div>
          <strong>{assessment.model || 'offline-triage'}</strong>
        </div>
      </div>

      {popiaNotes.length ? (
        <div className="popia-callout">
          <div className="mini-label">POPIA notes</div>
          <ul>
            {popiaNotes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function Section({ title, items }) {
  const list = ensureStringArray(items);
  if (!list.length) {
    return null;
  }

  return (
    <div className="assessment-section">
      <div className="mini-label">{title}</div>
      <ul>
        {list.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function formatConfidence(confidence) {
  if (typeof confidence !== 'number') {
    return 'n/a';
  }

  return `${Math.round(confidence * 100)}%`;
}

export default AssessmentCard;
