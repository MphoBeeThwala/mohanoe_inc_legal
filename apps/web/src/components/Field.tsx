import type { ReactNode } from 'react';

interface FieldProps {
  label: string;
  hint?: string;
  id: string;
  children: ReactNode;
}

function Field({ label, hint, id, children }: FieldProps) {
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

export default Field;
