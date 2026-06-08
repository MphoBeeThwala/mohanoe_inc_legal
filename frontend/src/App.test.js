import { render, screen } from '@testing-library/react';
import App from './App';

test('renders sign-in shell while auth is loading', () => {
  render(<App />);
  expect(screen.getByText(/loading workspace/i)).toBeInTheDocument();
});
