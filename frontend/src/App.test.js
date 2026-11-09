import { render, screen } from '@testing-library/react';
import App from './App';
import { applyBranding, DEFAULT_BRANDING } from './branding';

test('renders the loading shell while the session is checked', () => {
  render(<App />);
  expect(screen.getByLabelText(/loading workspace/i)).toBeInTheDocument();
});

test('applies firm branding to the page title and theme colours', () => {
  applyBranding({
    ...DEFAULT_BRANDING,
    firmName: 'Nkosi & Partners Inc.',
    primaryColor: '#123456',
  });
  expect(document.title).toBe('Nkosi & Partners Inc. · Legal Practice Workspace');
  expect(document.documentElement.style.getPropertyValue('--brand-green')).toBe('#123456');
});

test('ignores unsafe colour values', () => {
  document.documentElement.style.removeProperty('--brand-accent');
  applyBranding({ ...DEFAULT_BRANDING, accentColor: 'red;background:url(x)' });
  expect(document.documentElement.style.getPropertyValue('--brand-accent')).toBe('');
});
