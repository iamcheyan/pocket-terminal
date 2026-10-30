import {useEffect, useId, useRef, type CSSProperties, type ReactNode} from 'react';
import {X} from 'lucide-react';

/**
 * Hand-drawn controls. No native select/dialog/alert/confirm is used anywhere
 * in this app: every widget here is a real button or listbox with correct ARIA
 * state so keyboard, D-Pad and screen readers all work.
 */

export const Button = ({
  children,
  onClick,
  variant = 'default',
  size = 'md',
  disabled,
  iconOnly,
  label,
  type = 'button',
  style,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  size?: 'md' | 'sm';
  disabled?: boolean;
  iconOnly?: boolean;
  label?: string;
  type?: 'button' | 'submit';
  style?: CSSProperties;
}) => (
  <button
    type={type}
    className={`btn ${variant === 'default' ? '' : variant} ${size === 'sm' ? 'sm' : ''} ${iconOnly ? 'icon' : ''}`}
    onClick={onClick}
    disabled={disabled}
    data-kb
    aria-label={label}
    title={label}
    style={style}
  >
    {children}
  </button>
);

export const Segmented = <T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: {value: T; label: string; icon?: ReactNode}[];
  onChange: (value: T) => void;
  label: string;
}) => (
  <div className="segmented" role="group" aria-label={label}>
    {options.map(option => (
      <button
        key={option.value}
        type="button"
        aria-pressed={value === option.value}
        onClick={() => onChange(option.value)}
        data-kb
      >
        {option.icon}
        {option.label}
      </button>
    ))}
  </div>
);

export const Field = ({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) => (
  <div className="field">
    <label htmlFor={id}>{label}</label>
    {children}
    {hint ? <span className="hint">{hint}</span> : null}
  </div>
);

export const Toggle = ({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) => (
  <button
    type="button"
    className="switch"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    onClick={() => onChange(!checked)}
    data-kb
  >
    <span className="switch-track" aria-hidden="true" />
    <span>{label}</span>
  </button>
);

export const Card = ({
  title,
  eyebrow,
  action,
  children,
  className = '',
  style,
}: {
  title?: string;
  eyebrow?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) => (
  <section className={`card ${className}`} style={style}>
    {title || eyebrow || action ? (
      <div className="card-head">
        <div style={{minWidth: 0}}>
          {eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}
          {title ? <h3>{title}</h3> : null}
        </div>
        <span className="spacer" />
        {action}
      </div>
    ) : null}
    {children}
  </section>
);

export const Meter = ({percent, tone}: {percent: number; tone?: 'warn' | 'bad'}) => (
  <div
    className={`meter ${tone ?? ''}`}
    role="progressbar"
    aria-valuenow={Math.round(percent)}
    aria-valuemin={0}
    aria-valuemax={100}
  >
    <i style={{width: `${Math.max(0, Math.min(100, percent))}%`}} />
  </div>
);

export const Chip = ({
  children,
  tone = '',
  title,
}: {
  children: ReactNode;
  tone?: '' | 'on' | 'mock' | 'danger';
  title?: string;
}) => (
  <span className={`chip ${tone}`} title={title}>
    {children}
  </span>
);

export const Empty = ({icon, title, body, action}: {icon: ReactNode; title: string; body: string; action?: ReactNode}) => (
  <div className="empty">
    {icon}
    <strong>{title}</strong>
    <p>{body}</p>
    {action}
  </div>
);

export const Dialog = ({
  title,
  eyebrow,
  onClose,
  children,
  footer,
  wide,
  labelledBy,
}: {
  title: string;
  eyebrow?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  labelledBy?: string;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const headingId = useId();

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = ref.current;
    const first = node?.querySelector<HTMLElement>('[data-autofocus]') ?? node?.querySelector<HTMLElement>('[data-kb]');
    first?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !node) return;
      const focusable = Array.from(node.querySelectorAll<HTMLElement>('[data-kb], input, textarea, [tabindex="0"]')).filter(
        element => !element.hasAttribute('disabled'),
      );
      if (focusable.length === 0) return;
      const index = focusable.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey ? index - 1 : index + 1;
      if (next < 0) {
        event.preventDefault();
        focusable[focusable.length - 1].focus();
      } else if (next >= focusable.length) {
        event.preventDefault();
        focusable[0].focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      previous?.focus();
    };
  }, [onClose]);

  return (
    <div
      className="scrim"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={`dialog ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy ?? headingId}
        ref={ref}
      >
        <div className="dialog-head">
          <div>
            {eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}
            <h2 id={headingId}>{title}</h2>
          </div>
          <span className="spacer" />
          <Button variant="ghost" size="sm" iconOnly label="Close dialog" onClick={onClose}>
            <X size={14} />
          </Button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer ? <div className="dialog-foot">{footer}</div> : null}
      </div>
    </div>
  );
};

export const Tabs = <T extends string>({
  value,
  items,
  onChange,
  label,
}: {
  value: T;
  items: {value: T; label: string; badge?: string}[];
  onChange: (value: T) => void;
  label: string;
}) => (
  <div className="segmented" role="tablist" aria-label={label}>
    {items.map(item => (
      <button
        key={item.value}
        type="button"
        role="tab"
        aria-selected={value === item.value}
        aria-current={value === item.value ? 'page' : undefined}
        onClick={() => onChange(item.value)}
        data-kb
      >
        {item.label}
        {item.badge ? <span className="nav-count">{item.badge}</span> : null}
      </button>
    ))}
  </div>
);

export type ToastTone = 'info' | 'good' | 'error';

export interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}

export const Toasts = ({items, onDismiss}: {items: ToastItem[]; onDismiss: (id: number) => void}) => (
  <div className="toasts" role="status" aria-live="polite">
    {items.map(item => (
      <div key={item.id} className="toast" data-tone={item.tone}>
        <span style={{flex: 1}}>{item.message}</span>
        <Button variant="ghost" size="sm" iconOnly label="Dismiss" onClick={() => onDismiss(item.id)}>
          <X size={12} />
        </Button>
      </div>
    ))}
  </div>
);
