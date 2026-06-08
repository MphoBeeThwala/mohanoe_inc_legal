import React from 'react';

function AssessmentCard({ matter }) {
  if (!matter) {
    return (
      <div className="panel assessment-panel">
        <p className="panel-kicker">Assessment</p>
        <h2>No matter selected</h2>
        <p className="muted">
          Submit an intake or choose a case to view the attorney-facing triage.
        </p>
      </div>
    );
  }

  const assessment = matter.assessment || {};

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

      {assessment.popiaNotes?.length ? (
        <div className="popia-callout">
          <div className="mini-label">POPIA notes</div>
          <ul>
            {assessment.popiaNotes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function Section({ title, items }) {
  if (!items || !items.length) {
    return null;
  }

  return (
    <div className="assessment-section">
      <div className="mini-label">{title}</div>
      <ul>
        {items.map((item) => (
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
