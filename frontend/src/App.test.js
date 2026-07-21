import { render, screen } from '@testing-library/react';
import App from './App';

beforeEach(() => {
  localStorage.clear();

  // Avoid real network calls; App or children may fetch on mount.
  global.fetch = jest.fn(() =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve([]),
    } as any),
  ) as any;
});

afterEach(() => {
  jest.resetAllMocks();
});

test('renders Login link when not authenticated', () => {
  render(<App />);
  expect(screen.getByRole('link', { name: /login/i })).toBeInTheDocument();
});

test("when role in localStorage is 'admin', Nav shows 'Admin Orders' link", () => {
  localStorage.setItem('role', 'admin');

  render(<App />);
  expect(screen.getByRole('link', { name: /admin orders/i })).toBeInTheDocument();
});