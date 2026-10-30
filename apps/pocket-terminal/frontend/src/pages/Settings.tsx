import {useEffect, useRef, useState} from 'react';
import {Check, Gamepad2, Keyboard, MousePointer2, SlidersHorizontal} from 'lucide-react';
import {defaultMapping, captureNextGamepadButton, gamepadAvailable, loadMapping, saveMapping, type GamepadMapping} from '../input';
import {Button, Card, Chip} from '../components';

export type LayoutMode = 'handheld' | 'eink' | 'desktop';
export type ThemeMode = 'dark' | 'light';
export type FontChoice = 'mono' | 'system';

export interface SettingsState {
  layout: LayoutMode;
  theme: ThemeMode;
  font: FontChoice;
  touchTargets: boolean;
}

export interface SettingsPageProps {
  settings: SettingsState;
  onChange: (patch: Partial<SettingsState>) => void;
  runtime: {version: string; shells: number; sessions: number; mock: boolean};
}

const BUTTON_LABELS: Record<keyof Omit<GamepadMapping, 'axisThreshold' | 'holdMs' | 'repeatMs' | 'invertY'>, string> = {
  dpadUp: 'D-Pad up',
  dpadDown: 'D-Pad down',
  dpadLeft: 'D-Pad left',
  dpadRight: 'D-Pad right',
  activate: 'Confirm',
  back: 'Back',
  palette: 'Command palette',
};

const SettingsPage = ({settings, onChange, runtime}: SettingsPageProps) => {
  const [mapping, setMapping] = useState<GamepadMapping>(() => loadMapping());
  const [capturing, setCapturing] = useState<keyof typeof BUTTON_LABELS | null>(null);
  const cancelCapture = useRef<(() => void) | null>(null);
  const [padDetected, setPadDetected] = useState(false);

  useEffect(() => {
    setPadDetected(gamepadAvailable());
    const interval = window.setInterval(() => setPadDetected(gamepadAvailable()), 2000);
    const onConnect = () => setPadDetected(true);
    window.addEventListener('gamepadconnected', onConnect);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('gamepadconnected', onConnect);
    };
  }, []);

  useEffect(() => {
    if (!capturing) return undefined;
    cancelCapture.current = captureNextGamepadButton(index => {
      setMapping(previous => {
        const next = {...previous, [capturing]: index};
        saveMapping(next);
        return next;
      });
      setCapturing(null);
    });
    return () => {
      cancelCapture.current?.();
      cancelCapture.current = null;
    };
  }, [capturing]);

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>Settings &amp; input</h2>
          <p>
            Layout, theme and controller mapping. Everything here is a hand-drawn control: no native select, dialog or
            confirm appears anywhere in this app.
          </p>
        </div>
        <span className="spacer" />
        <Chip>v{runtime.version}</Chip>
      </div>

      <div className="grid cols-3" style={{marginBottom: 10}}>
        <Card eyebrow="layout" title="Surface profile" action={<SlidersHorizontal size={13} />}>
          <div className="segmented" role="group" aria-label="Layout mode">
            {(['handheld', 'eink', 'desktop'] as const).map(mode => (
              <button
                key={mode}
                type="button"
                aria-pressed={settings.layout === mode}
                onClick={() => onChange({layout: mode})}
                data-kb
              >
                {settings.layout === mode ? <Check size={11} /> : null}
                {mode}
              </button>
            ))}
          </div>
          <div className="hint" style={{marginTop: 8}}>
            Handheld: bottom navigation, 44px targets, stacked panes. E-Ink: maximum contrast, mono-chrome. Desktop:
            sidebar navigation with denser tables.
          </div>
        </Card>

        <Card eyebrow="theme" title="Appearance">
          <div className="segmented" role="group" aria-label="Theme">
            {(['dark', 'light'] as const).map(theme => (
              <button
                key={theme}
                type="button"
                aria-pressed={settings.theme === theme}
                onClick={() => onChange({theme})}
                data-kb
              >
                {settings.theme === theme ? <Check size={11} /> : null}
                {theme}
              </button>
            ))}
          </div>
          <div className="hint" style={{marginTop: 8}}>
            Both themes are contrast-checked; the terminal palette follows the app theme.
          </div>
        </Card>

        <Card eyebrow="terminal" title="Font">
          <div className="segmented" role="group" aria-label="Terminal font">
            {(['mono', 'system'] as const).map(font => (
              <button
                key={font}
                type="button"
                aria-pressed={settings.font === font}
                onClick={() => onChange({font})}
                data-kb
              >
                {font === 'mono' ? 'Monospace' : 'UI stack'}
              </button>
            ))}
          </div>
          <div className="hint" style={{marginTop: 8}}>
            Font size lives in the terminal toolbar so it is reachable while typing. {runtime.shells} shells detected,{' '}
            {runtime.sessions} live sessions.
          </div>
        </Card>
      </div>

      <Card eyebrow="input" title="Adaptive input" action={<Gamepad2 size={13} />}>
        <div className="grid cols-3">
          <div>
            <div className="eyebrow">
              <Keyboard size={10} /> keyboard
            </div>
            <div className="hint" style={{marginTop: 5}}>
              Ctrl/⌘+K opens the palette. Arrows move a spatial focus ring. Enter activates. Esc goes back. Ctrl+Shift+C/V
              copy and paste in the terminal.
            </div>
          </div>
          <div>
            <div className="eyebrow">
              <MousePointer2 size={10} /> touch &amp; mouse
            </div>
            <div className="hint" style={{marginTop: 5}}>
              Targets are at least 40px in handled layouts (44px on handheld). The split-pane divider, tabs and log rows
              all accept direct taps.
            </div>
          </div>
          <div>
            <div className="eyebrow">
              <Gamepad2 size={10} /> gamepad
            </div>
            <div className="hint" style={{marginTop: 5}}>
              {padDetected ? 'Controller detected. ' : 'No controller detected; mapping still editable. '}
              Standard mapping: 12/13/14/15 D-Pad, 0 confirm, 1 back, 9 palette.
            </div>
          </div>
        </div>
      </Card>

      <div style={{height: 10}} />

      <Card eyebrow="gamepad" title="Button mapping" action={<Chip tone={padDetected ? 'on' : ''}>{padDetected ? 'connected' : 'waiting'}</Chip>}>
        <div className="grid cols-2">
          {Object.entries(BUTTON_LABELS).map(([key, label]) => {
            const value = mapping[key as keyof typeof BUTTON_LABELS];
            return (
              <div className="row" key={key}>
                <span className="row-main">
                  <strong>{label}</strong>
                  <small>button index</small>
                </span>
                <Chip tone={capturing === key ? 'mock' : ''}>{capturing === key ? 'press now…' : value}</Chip>
                <Button
                  size="sm"
                  onClick={() => setCapturing(capturing === key ? null : (key as keyof typeof BUTTON_LABELS))}
                  data-kb
                >
                  {capturing === key ? 'Cancel' : 'Rebind'}
                </Button>
              </div>
            );
          })}
        </div>
        <div className="toolbar-row" style={{marginTop: 10, marginBottom: 0}}>
          <Button
            size="sm"
            onClick={() => {
              setMapping(defaultMapping);
              saveMapping(defaultMapping);
            }}
          >
            Restore defaults
          </Button>
          <Chip>threshold {mapping.axisThreshold}</Chip>
          <Chip>hold {mapping.holdMs}ms</Chip>
          <Chip>repeat {mapping.repeatMs}ms</Chip>
          <Button
            size="sm"
            onClick={() => {
              const next = {...mapping, invertY: !mapping.invertY};
              setMapping(next);
              saveMapping(next);
            }}
          >
            {mapping.invertY ? 'Invert Y: on' : 'Invert Y: off'}
          </Button>
          <span style={{flex: 1}} />
          <Chip tone={runtime.mock ? 'mock' : ''}>{runtime.mock ? 'mock ssh target active' : 'live'}</Chip>
        </div>
      </Card>
    </div>
  );
};

export default SettingsPage;
