import React from 'react';

function CaseTable({ cases, onSelectCase, onGoToIntake }) {
  if (!cases?.length) {
    return (
      <div className="empty-state">
        <p>No matters have been assessed yet.</p>
        <p className="muted">Submit a client intake to create your first case.</p>
        {onGoToIntake ? (
          <button type="button" className="primary-button" onClick={onGoToIntake}>
            Go to intake
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="case-table-wrap">
      <table className="case-table">
        <thead>
          <tr>
            <th scope="col">Case</th>
            <th scope="col">Client</th>
            <th scope="col">Practice area</th>
            <th scope="col">Urgency</th>
            <th scope="col">Status</th>
            <th scope="col">Action</th>
          </tr>
        </thead>
        <tbody>
          {cases.map((item) => (
            <tr key={item.id}>
              <td>{item.caseNumber}</td>
              <td>{item.clientLabel}</td>
              <td>{item.practiceArea}</td>
              <td>
                <span className={`chip chip-${item.urgency || 'medium'}`}>
                  {item.urgency || 'medium'}
                </span>
              </td>
              <td>{item.status}</td>
              <td>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => onSelectCase(item)}
                >
                  Open
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default CaseTable;
