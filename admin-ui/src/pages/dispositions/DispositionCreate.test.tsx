import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { DispositionCreate } from './DispositionCreate';

vi.mock('../../providers/axiosClient', () => ({
  axiosClient: { post: vi.fn() },
}));

vi.mock('react-admin', () => ({
  useNotify: () => vi.fn(),
}));

function renderCreate(campaignId = 'camp-123') {
  return render(
    <MemoryRouter initialEntries={[`/campaigns/${campaignId}/dispositions/create`]}>
      <Routes>
        <Route
          path="/campaigns/:id/dispositions/create"
          element={<DispositionCreate />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('DispositionCreate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the create form with all required fields', () => {
    renderCreate();

    expect(screen.getByText('Neue Disposition')).toBeInTheDocument();
    expect(screen.getByTestId('disp-create-code')).toBeInTheDocument();
    expect(screen.getByTestId('disp-create-label')).toBeInTheDocument();
    expect(screen.getByTestId('disp-create-save')).toBeInTheDocument();
  });

  it('save button is disabled when both fields are empty', () => {
    renderCreate();

    expect(screen.getByTestId('disp-create-save')).toBeDisabled();
  });

  it('save button is disabled when only code is filled', async () => {
    const user = userEvent.setup();
    renderCreate();

    await user.type(screen.getByTestId('disp-create-code'), 'INTERESTED');

    expect(screen.getByTestId('disp-create-save')).toBeDisabled();
  });

  it('auto-uppercases the code input', async () => {
    const user = userEvent.setup();
    renderCreate();

    await user.type(screen.getByTestId('disp-create-code'), 'interested');

    expect(screen.getByTestId('disp-create-code')).toHaveValue('INTERESTED');
  });

  it('shows validation error for code with invalid characters', () => {
    renderCreate();
    const codeInput = screen.getByTestId('disp-create-code');

    fireEvent.change(codeInput, { target: { value: 'INVALID-CODE' } });

    expect(screen.getByText('Nur GROSSBUCHSTABEN, Ziffern und _ erlaubt')).toBeInTheDocument();
  });

  it('save button stays disabled when code has invalid characters', () => {
    renderCreate();
    const codeInput = screen.getByTestId('disp-create-code');

    fireEvent.change(codeInput, { target: { value: 'BAD CODE' } });
    fireEvent.change(screen.getByTestId('disp-create-label'), { target: { value: 'Test' } });

    expect(screen.getByTestId('disp-create-save')).toBeDisabled();
  });

  it('enables save button when valid code and label are provided', async () => {
    const user = userEvent.setup();
    renderCreate();

    await user.type(screen.getByTestId('disp-create-code'), 'INTERESTED');
    await user.type(screen.getByTestId('disp-create-label'), 'Interessiert');

    expect(screen.getByTestId('disp-create-save')).toBeEnabled();
  });

  it('calls POST /campaigns/:id/dispositions with correct payload on submit', async () => {
    const { axiosClient } = await import('../../providers/axiosClient');
    vi.mocked(axiosClient.post).mockResolvedValueOnce({ data: { id: 'new-disp' } });

    const user = userEvent.setup();
    renderCreate('camp-456');

    await user.type(screen.getByTestId('disp-create-code'), 'NOT_AVAILABLE');
    await user.type(screen.getByTestId('disp-create-label'), 'Nicht verfügbar');
    await user.click(screen.getByTestId('disp-create-save'));

    await waitFor(() => {
      expect(axiosClient.post).toHaveBeenCalledWith(
        '/campaigns/camp-456/dispositions',
        expect.objectContaining({
          code: 'NOT_AVAILABLE',
          label: 'Nicht verfügbar',
        }),
      );
    });
  });

  it('shows error alert when POST fails', async () => {
    const { axiosClient } = await import('../../providers/axiosClient');
    vi.mocked(axiosClient.post).mockRejectedValueOnce(new Error('Network error'));

    const user = userEvent.setup();
    renderCreate();

    await user.type(screen.getByTestId('disp-create-code'), 'FAIL_TEST');
    await user.type(screen.getByTestId('disp-create-label'), 'Fehler Test');
    await user.click(screen.getByTestId('disp-create-save'));

    await waitFor(() => {
      expect(screen.getByTestId('disp-create-error')).toBeInTheDocument();
      expect(screen.getByText('Fehler beim Erstellen')).toBeInTheDocument();
    });
  });
});
