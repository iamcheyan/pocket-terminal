import {useCallback, useEffect, useRef} from 'react';

/**
 * Unified input for keyboard, D-Pad and gamepad.
 *
 * All three routes end in the same two primitives:
 *  - spatial focus movement between `[data-kb]` elements (bounding-box
 *    geometry, not DOM order, so grids behave like grids), and
 *  - activation of the focused control via a real click.
 *
 * Touch and mouse need no adapter: targets are sized by the layout tokens.
 */

export type NavDirection = 'up' | 'down' | 'left' | 'right';
export type InputCommand = NavDirection | 'activate' | 'back' | 'palette';

export interface GamepadMapping {
  /** Standard-mapping button indices. */
  dpadUp: number;
  dpadDown: number;
  dpadLeft: number;
  dpadRight: number;
  activate: number;
  back: number;
  palette: number;
  /** Analogue threshold for the left stick vertical axis. */
  axisThreshold: number;
  /** Hold before a direction repeats. */
  holdMs: number;
  /** Repeat interval while held. */
  repeatMs: number;
  invertY: boolean;
}

export const defaultMapping: GamepadMapping = {
  dpadUp: 12,
  dpadDown: 13,
  dpadLeft: 14,
  dpadRight: 15,
  activate: 0,
  back: 1,
  palette: 9,
  axisThreshold: 0.6,
  holdMs: 320,
  repeatMs: 170,
  invertY: false,
};

const MAPPING_KEY = 'pt.gamepad.mapping';

export const loadMapping = (): GamepadMapping => {
  try {
    const raw = localStorage.getItem(MAPPING_KEY);
    if (!raw) return defaultMapping;
    const parsed = JSON.parse(raw) as Partial<GamepadMapping>;
    return {...defaultMapping, ...parsed};
  } catch {
    return defaultMapping;
  }
};

export const saveMapping = (mapping: GamepadMapping) => {
  localStorage.setItem(MAPPING_KEY, JSON.stringify(mapping));
};

interface Rect {
  node: HTMLElement;
  left: number;
  top: number;
  right: number;
  bottom: number;
  cx: number;
  cy: number;
}

const collectTargets = (): Rect[] => {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>('[data-kb]'));
  const out: Rect[] = [];
  for (const node of nodes) {
    if (node.hasAttribute('disabled') || node.getAttribute('aria-disabled') === 'true') continue;
    if (node.closest('[hidden]')) continue;
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    out.push({
      node,
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      cx: rect.left + rect.width / 2,
      cy: rect.top + rect.height / 2,
    });
  }
  return out;
};

const isVisible = (node: HTMLElement) => {
  const rect = node.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0;
};

/** Spatial search: closest control whose centre lies in the requested half-plane. */
export const findInDirection = (direction: NavDirection): HTMLElement | null => {
  const targets = collectTargets();
  if (targets.length === 0) return null;
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const current = targets.find(entry => entry.node === active || entry.node.contains(active));
  if (!current) return targets[0].node;

  let best: Rect | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of targets) {
    if (candidate.node === current.node) continue;
    const dx = candidate.cx - current.cx;
    const dy = candidate.cy - current.cy;
    const inPlane =
      (direction === 'up' && dy < -1) ||
      (direction === 'down' && dy > 1) ||
      (direction === 'left' && dx < -1) ||
      (direction === 'right' && dx > 1);
    if (!inPlane) continue;
    // Primary axis distance dominates; cross-axis offset is a tie-breaker.
    const primary = direction === 'up' || direction === 'down' ? Math.abs(dy) : Math.abs(dx);
    const cross = direction === 'up' || direction === 'down' ? Math.abs(dx) : Math.abs(dy);
    const score = primary + cross * 2.2;
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best?.node ?? null;
};

const focusNode = (node: HTMLElement) => {
  node.focus({preventScroll: false});
  document.querySelectorAll<HTMLElement>('[data-dpad-active="true"]').forEach(el => el.removeAttribute('data-dpad-active'));
  node.setAttribute('data-dpad-active', 'true');
};

const clearDpadRing = () => {
  document.querySelectorAll<HTMLElement>('[data-dpad-active="true"]').forEach(el => el.removeAttribute('data-dpad-active'));
};

/** Move the focus ring one step. Returns false when there is no target. */
export const navigate = (direction: NavDirection): boolean => {
  const target = findInDirection(direction);
  if (!target) return false;
  focusNode(target);
  return true;
};

export const activateFocused = (): boolean => {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  if (!active.hasAttribute('data-kb') && !active.closest('[data-kb]')) return false;
  active.click();
  return true;
};

interface NavigationOptions {
  onPalette: () => void;
  onBack: () => void;
  /** While open, arrow keys belong to the dialog/list, not the page grid. */
  suspended: boolean;
  mapping: GamepadMapping;
}

/**
 * Installs keyboard + gamepad navigation for the lifetime of the component.
 * Keyboard arrows deliberately leave text fields alone.
 */
export const useInputNavigation = ({onPalette, onBack, suspended, mapping}: NavigationOptions) => {
  const state = useRef({
    directions: [false, false, false, false],
    nextAt: [0, 0, 0, 0],
    buttons: [] as boolean[],
    frame: 0,
  });

  const handleCommand = useCallback(
    (command: InputCommand) => {
      if (command === 'palette') {
        onPalette();
        return;
      }
      if (suspended) return;
      if (command === 'back') {
        onBack();
        return;
      }
      if (command === 'activate') {
        activateFocused();
        return;
      }
      navigate(command);
    },
    [onBack, onPalette, suspended],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable === true;

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        onPalette();
        return;
      }
      if (event.key === 'Escape') {
        if (!suspended) onBack();
        return;
      }
      if (suspended) return;
      if (typing && (event.key.startsWith('Arrow') || event.key === 'Enter' || event.key === ' ')) {
        return;
      }
      const map: Record<string, NavDirection> = {
        ArrowUp: 'up',
        ArrowDown: 'down',
        ArrowLeft: 'left',
        ArrowRight: 'right',
      };
      const direction = map[event.key];
      if (direction) {
        event.preventDefault();
        handleCommand(direction);
        return;
      }
      if (event.key === 'Enter' && !(target instanceof HTMLButtonElement) && !(target instanceof HTMLAnchorElement)) {
        if (handleActivateKey()) event.preventDefault();
      }
    };

    const handleActivateKey = () => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement)) return false;
      if (active instanceof HTMLButtonElement || active instanceof HTMLAnchorElement) return false;
      if (!active.hasAttribute('data-kb') && !active.closest('[data-kb]')) return false;
      active.click();
      return true;
    };

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && !target.closest('[data-dpad-active]')) clearDpadRing();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [handleCommand, onBack, onPalette, suspended]);

  useEffect(() => {
    const loop = () => {
      const frameState = state.current;
      frameState.frame = requestAnimationFrame(loop);
      if (suspended) return;
      if (typeof navigator.getGamepads !== 'function') return;
      const pads = navigator.getGamepads();
      const now = performance.now();
      const directions: NavDirection[] = ['up', 'down', 'left', 'right'];
      for (const pad of pads) {
        if (!pad?.connected) continue;
        const pressed = [
          pad.buttons[mapping.dpadUp]?.pressed === true,
          pad.buttons[mapping.dpadDown]?.pressed === true,
          pad.buttons[mapping.dpadLeft]?.pressed === true,
          pad.buttons[mapping.dpadRight]?.pressed === true,
        ];
        let stickY = pad.axes[1] ?? 0;
        const stickX = pad.axes[0] ?? 0;
        if (mapping.invertY) stickY = -stickY;
        if (stickY > mapping.axisThreshold) pressed[1] = true;
        if (stickY < -mapping.axisThreshold) pressed[0] = true;
        if (stickX > mapping.axisThreshold) pressed[3] = true;
        if (stickX < -mapping.axisThreshold) pressed[2] = true;

        directions.forEach((direction, index) => {
          if (!pressed[index]) {
            frameState.directions[index] = false;
            return;
          }
          if (!frameState.directions[index]) {
            frameState.directions[index] = true;
            frameState.nextAt[index] = now + mapping.holdMs;
            handleCommand(direction);
            return;
          }
          if (now >= frameState.nextAt[index]) {
            frameState.nextAt[index] = now + mapping.repeatMs;
            handleCommand(direction);
          }
        });

        const bindings: ReadonlyArray<readonly [number, InputCommand]> = [
          [mapping.activate, 'activate'],
          [mapping.back, 'back'],
          [mapping.palette, 'palette'],
        ];
        for (const [index, command] of bindings) {
          const isPressed = pad.buttons[index]?.pressed === true;
          if (isPressed && frameState.buttons[index] !== true) handleCommand(command);
          frameState.buttons[index] = isPressed;
        }
      }
    };
    state.current.frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(state.current.frame);
  }, [handleCommand, mapping, suspended]);
};

/**
 * One-shot gamepad button capturer used by the mapping configurator: the next
 * pressed button index is reported to the caller.
 */
export const captureNextGamepadButton = (onCapture: (index: number) => void): (() => void) => {
  let frame = 0;
  const seen = new Set<number>();
  const tick = () => {
    frame = requestAnimationFrame(tick);
    if (typeof navigator.getGamepads !== 'function') return;
    for (const pad of navigator.getGamepads()) {
      if (!pad?.connected) continue;
      pad.buttons.forEach((button, index) => {
        if (!button.pressed) {
          seen.delete(index);
          return;
        }
        if (seen.has(index)) return;
        seen.add(index);
        onCapture(index);
      });
    }
  };
  frame = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(frame);
};

export const gamepadAvailable = (): boolean =>
  typeof navigator.getGamepads === 'function' && Array.from(navigator.getGamepads()).some(pad => pad?.connected);

export const focusedName = (): string => {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return '';
  if (!isVisible(active)) return '';
  return active.getAttribute('aria-label') ?? active.textContent?.trim().slice(0, 60) ?? '';
};
