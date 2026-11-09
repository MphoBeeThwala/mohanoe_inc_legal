export type NoticeTone = 'info' | 'success' | 'warn' | 'error';

export interface Notice {
  tone: NoticeTone;
  message: string;
}

interface DismissibleNoticeProps {
  tone?: NoticeTone;
  message?: string | null;
  onDismiss?: () => void;
}

function DismissibleNotice({ tone = 'info', message, onDismiss }: DismissibleNoticeProps) {
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
