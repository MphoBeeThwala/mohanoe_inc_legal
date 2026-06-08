import React from 'react';

function CaseTable({ cases, onSelectCase }) {
  if (!cases?.length) {
    return (
      <div className="empty-state">
        No matters have been assessed yet. Submit an intake to create the first
        case.
      </div>
    );
  }

  return (
    <div className="case-table-wrap">
      <table className="case-table">
        <thead>
          <tr>
            <th>Case</th>
            <th>Client</th>
            <th>Practice area</th>
            <th>Urgency</th>
            <th>Status</th>
            <th>Action</th>
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
