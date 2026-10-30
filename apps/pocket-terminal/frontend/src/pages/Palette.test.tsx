import {render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {describe, expect, it, vi} from 'vitest';
import CommandPalette, {type PaletteCommand} from './Palette';

const commands = (onRun: (id: string) => void): PaletteCommand[] => [
  {id: 'a', title: 'New local shell', detail: 'bash', group: 'Terminal', run: () => onRun('shell')},
  {id: 'b', title: 'Go to Logs', group: 'Navigate', run: () => onRun('logs')},
  {id: 'c', title: 'Go to SSH manager', group: 'Navigate', run: () => onRun('ssh')},
  {id: 'd', title: 'Switch to light theme', group: 'Appearance', run: () => onRun('theme')},
];

describe('command palette', () => {
  it('is hidden when closed and renders an ARIA listbox when open', () => {
    const {rerender} = render(<CommandPalette open={false} commands={commands(vi.fn())} onClose={vi.fn()} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    rerender(<CommandPalette open commands={commands(vi.fn())} onClose={vi.fn()} />);
    expect(screen.getByRole('listbox', {name: 'Commands'})).toBeInTheDocument();
    expect(screen.getByRole('option', {name: /New local shell/})).toHaveAttribute('aria-selected', 'true');
  });

  it('filters as the user types and keeps selection valid', async () => {
    const user = userEvent.setup();
    render(<CommandPalette open commands={commands(vi.fn())} onClose={vi.fn()} />);
    const query = screen.getByLabelText('Palette query');
    await user.type(query, 'logs');
    await waitFor(() => {
      expect(screen.queryByRole('option', {name: /Go to SSH/})).toBeNull();
    });
    expect(screen.getByRole('option', {name: /Go to Logs/})).toHaveAttribute('aria-selected', 'true');
  });

  it('runs the highlighted command with Enter and closes first', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette open commands={commands(onRun)} onClose={onClose} />);
    await user.type(screen.getByLabelText('Palette query'), 'shell');
    await user.keyboard('{Enter}');
    expect(onClose).toHaveBeenCalled();
    expect(onRun).toHaveBeenCalledWith('shell');
  });

  it('moves the highlight with arrow keys (DPad path) and activates the second item', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    render(<CommandPalette open commands={commands(onRun)} onClose={vi.fn()} />);
    const items = screen.getAllByRole('option');
    expect(items[0]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowDown}');
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Enter}');
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape without running anything', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette open commands={commands(onRun)} onClose={onClose} />);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
    expect(onRun).not.toHaveBeenCalled();
  });

  it('supports touch/mouse activation of an option', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    render(<CommandPalette open commands={commands(onRun)} onClose={vi.fn()} />);
    await user.click(screen.getByRole('option', {name: /Switch to light theme/}));
    expect(onRun).toHaveBeenCalledWith('theme');
  });

  it('explains an empty result set', async () => {
    const user = userEvent.setup();
    render(<CommandPalette open commands={commands(vi.fn())} onClose={vi.fn()} />);
    await user.type(screen.getByLabelText('Palette query'), 'zzzzzz');
    expect(screen.getByText(/No commands match/)).toBeInTheDocument();
  });
});
