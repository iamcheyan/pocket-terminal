import {render, screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {useState} from 'react';
import {describe, expect, it, vi} from 'vitest';
import {Button, Dialog, Field, Segmented, Toggle} from './components';

const DialogHarness = ({onClose = vi.fn()}: {onClose?: () => void}) => {
  const [open, setOpen] = useState(true);
  if (!open) return <div>closed</div>;
  return (
    <Dialog
      title="Confirm reboot"
      eyebrow="dangerous"
      onClose={() => {
        onClose();
        setOpen(false);
      }}
      footer={
        <>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button variant="danger">Confirm</Button>
        </>
      }
    >
      <Field id="target" label="Target">
        <input id="target" data-autofocus className="input" defaultValue="device" />
      </Field>
      <Toggle checked={false} onChange={() => undefined} label="Acknowledge" />
    </Dialog>
  );
};

describe('hand-drawn controls', () => {
  it('never renders a native dialog element and exposes dialog semantics', () => {
    render(<DialogHarness />);
    expect(document.querySelector('dialog')).toBeNull();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('Confirm reboot')).toBeInTheDocument();
  });

  it('focuses the autofocus field and closes on Escape', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<DialogHarness onClose={onClose} />);
    expect(document.activeElement).toBe(screen.getByLabelText('Target'));
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('traps Tab inside the dialog', async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    const dialog = screen.getByRole('dialog');
    const focusables = dialog.querySelectorAll<HTMLElement>('[data-kb], input');
    const last = focusables[focusables.length - 1];
    last.focus();
    await user.tab();
    expect(document.activeElement).toBe(focusables[0]);
  });

  it('reports selection state on segmented controls instead of using a native select', async () => {
    const onChange = vi.fn();
    const Harness = () => {
      const [value, setValue] = useState<'dark' | 'light'>('dark');
      return (
        <Segmented
          label="Theme"
          value={value}
          onChange={next => {
            setValue(next);
            onChange(next);
          }}
          options={[
            {value: 'dark', label: 'Dark'},
            {value: 'light', label: 'Light'},
          ]}
        />
      );
    };
    const user = userEvent.setup();
    render(<Harness />);
    expect(document.querySelector('select')).toBeNull();
    expect(screen.getByRole('button', {name: 'Dark'})).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', {name: 'Light'}));
    expect(onChange).toHaveBeenCalledWith('light');
    expect(screen.getByRole('button', {name: 'Light'})).toHaveAttribute('aria-pressed', 'true');
  });

  it('exposes switch semantics for toggles', async () => {
    const onChange = vi.fn();
    const Harness = () => {
      const [checked, setChecked] = useState(false);
      return (
        <Toggle
          checked={checked}
          label="Follow logs"
          onChange={next => {
            setChecked(next);
            onChange(next);
          }}
        />
      );
    };
    const user = userEvent.setup();
    render(<Harness />);
    const toggle = screen.getByRole('switch', {name: 'Follow logs'});
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await user.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  it('labels inputs through htmlFor so every field is reachable', () => {
    render(
      <Field id="host" label="Host">
        <input id="host" className="input" />
      </Field>,
    );
    expect(screen.getByLabelText('Host')).toBe(screen.getByRole('textbox'));
  });
});
