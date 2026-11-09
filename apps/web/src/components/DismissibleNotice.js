import React from 'react';

function DismissibleNotice({ tone = 'info', message, onDismiss }) {
  if (!message) {
    return null;
  }

  return (
    <div
      className={`notice notice-${tone} notice-dismissible`}
      role={tone === 'error' ? 'alert' : 'status'}
      aria-live="polite"
    >
      <span className="notice-body">{message}</span>
      {onDismiss ? (
        <button
          type="button"
          className="notice-dismiss"
          onClick={onDismiss}
          aria-label="Dismiss message"
        >
          ×
        </button>
      ) : null}
    </div>
  );
}

export default DismissibleNotice;
