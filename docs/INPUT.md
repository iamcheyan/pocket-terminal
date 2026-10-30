# Input model

Four input families drive the same UI. There is no separate "controller mode":
keyboard, D-Pad and gamepad all move one spatial focus ring, and touch/mouse hit
the same targets directly.

## Keyboard

| Keys | Action |
|---|---|
| `Ctrl`/`⌘` + `K` | Open/close the command palette |
| `↑ ↓ ← →` | Move the spatial focus ring (skipped while typing in a field) |
| `Enter` | Activate the focused control |
| `Esc` | Close the palette / dialog, otherwise return to Overview |
| `Tab` / `Shift+Tab` | Native tab order inside dialogs (trapped) |
| `Ctrl+Shift+C` | Copy the terminal selection |
| `Ctrl+Shift+V` | Paste into the focused terminal pane |

Terminal keystrokes are forwarded verbatim while the xterm surface has focus, so
shell shortcuts (`Ctrl+R`, `Ctrl+C`, …) are unaffected.

## Focus ring

`src/input.ts` implements geometry-based navigation:

1. Collect every visible, enabled `[data-kb]` control with a non-zero box.
2. From the focused control, keep candidates whose centre lies in the requested
   half-plane.
3. Score `primaryAxisDistance + 2.2 × crossAxisDistance` and pick the minimum.

Weighting the cross axis means a 2×2 grid behaves like a grid: `↓` from the
top-left tile goes to the tile directly below it, not the diagonal one. Moving
off the edge returns `false` and focus stays put. The focused node gets
`data-dpad-active="true"` so the ring is visible without relying on
`:focus-visible` heuristics (which browsers suppress for programmatic focus).

## D-Pad / gamepad

Polled with `requestAnimationFrame` against the W3C standard mapping.

| Default button index | Meaning |
|---|---|
| 12 / 13 | D-Pad up / down |
| 14 / 15 | D-Pad left / right |
| 0 | Confirm (activate) |
| 1 | Back |
| 9 | Command palette |

The left stick is treated as a D-Pad with a 0.6 threshold. Holding a direction
fires once immediately, then repeats after 320 ms every 170 ms. `Y` can be
inverted for controllers that report it backwards.

All of it is rebindable in **Settings → Button mapping**: pick a slot, press the
button, the index is stored in `localStorage` (`pt.gamepad.mapping`) and used by
the next poll. Defaults can be restored, and the axis threshold/hold/repeat
values are shown alongside.

Palette navigation is D-Pad-native too: the palette owns `↑/↓/Enter/Esc` while
open (page navigation is suspended), and options carry `aria-selected`.

`scripts/ui-smoke.mjs` injects a synthetic standard-mapped pad and asserts three
things: the D-Pad moves the same focus ring the keyboard uses, the palette button
(9) opens the command palette, and exactly one element carries
`data-dpad-active`. That is a behaviour test of the mapping code, not a
substitute for physical hardware (see `KNOWN-LIMITS.md`).

## Touch and mouse

- Base target height is 40 px; the handheld layout raises interactive controls to
  44 px (tabs, rows, buttons). The headless smoke run asserts that no visible
  control in the handheld layout at 390×844 is smaller than 28 px on either
  axis.
- Tap targets are the real controls, not invisible overlays; no hover-only
  affordance is required for any action.
- Dialog dismiss works by tapping the scrim; the close button is also 32 px.
- Pointer input clears the D-Pad ring so the two models never disagree about
  what is focused.

## Screen readers / semantics

- Tabs: `role="tablist"` + `role="tab"` with `aria-selected`.
- Palette: `role="dialog"` + `role="listbox"`/`role="option"`, `aria-activedescendant`
  on the query input.
- Dialogs: `role="dialog"`, `aria-modal="true"`, labelled heading, focus trap,
  focus restored to the opener on close.
- Segmented controls: `aria-pressed`; switches: `role="switch"` + `aria-checked`.
- Log rows: `role="log"` with `aria-live` only while following.
- Toasts: `role="status"` + `aria-live="polite"`.

## Layout matrix

| Layout | Selected by | Structure |
|---|---|---|
| `desktop` | default / Settings | Fixed 214 px sidebar, dense tables, split panes side by side |
| `handheld` | Settings / palette / topbar cycle | Bottom tab bar, stacked panes, 44 px targets |
| `eink` | Settings / palette | Grayscale, 1.5 px borders, thicker meters, light background forced |

The handheld structure also applies automatically below 760 px, so a phone with
`desktop` selected still gets the bottom bar and stacked panes. Both themes
(`dark`, `light`) are independent of the layout choice, and the e-ink layout
forces a light, grayscale palette regardless of the theme setting.
