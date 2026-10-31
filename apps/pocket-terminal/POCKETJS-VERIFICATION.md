# POCKETJS VERIFICATION — pocket-terminal

Round: PocketJS refactor. Device acceptance is a later pass.

## Shape

- Pocket app: `apps/pocket-terminal/pocket/`
- Frozen React reference: `apps/pocket-terminal/frontend/` (design reference; not extended).
- TSX files in the port: **6** (`main.tsx`, `app.tsx`, `ui.tsx`, three screens).
- Native tree only: `View`/`Text` from `@pocketjs/framework/solid/components`; no DOM, iframe, texture screenshot, or `dangerouslySetInnerHTML`.

## Manifest

- id: `dev.pocket-terminal.pocket`
- entry: `src/main.tsx`
- output: `pocket-terminal`
- viewport: `360×240 @2x` → physical `720×480`
- capabilities: `text.glyphs.baked`, `input.buttons`
- target: `rocknix-h700-kms`

## Admission / compile

```sh
cd apps/pocket-terminal/pocket
./setup-sdk.sh
SDK=${POCKETJS_SDK:-$HOME/development/.pocketjs-star-drift-sdk}
bun "$SDK/tools/pocket.ts" check \
  --runtime-config "$POCKET_VERIFY/pjs/profiles/pocket.runtime-config.ts" \
  --target rocknix-h700-kms --manifest pocket.json
bun "$SDK/tools/pocket.ts" compile \
  --runtime-config "$POCKET_VERIFY/pjs/profiles/pocket.runtime-config.ts" \
  --target rocknix-h700-kms --manifest pocket.json --output out.pocket
```

Admission: `sha256:81ceac87840639543765b13ec466243c913e0e0c11567a4ff68504a9aa06d6ba`; TypeScript passes for the app module graph. Package: `out.pocket`, sha256 `604df68108ee36b7e295736f801fab5d3de5497993f758f482bd174c02abf53c`.

## Frames

Rendered with the SDK wasm core at `renderScaled(2)` (720×480), not a browser:

```sh
cd "$POCKET_VERIFY"
bun tools/render-pocket.ts \
  --dir repos/pocket-terminal/apps/pocket-terminal/pocket \
  --script repos/pocket-terminal/apps/pocket-terminal/pocket/frames.json \
  --out repos/pocket-terminal/docs/pocket
```

| file | state | sha256 (first 16) |
|---|---|---|
| `docs/pocket/screen-home.png` | home | `91da56818d4c537c` |
| `docs/pocket/screen-home-focus.png` | home-focus | `cb76cf8eabfe8844` |
| `docs/pocket/screen-detail.png` | detail | `c11117a5159dc597` |
| `docs/pocket/screen-detail-action.png` | detail-action | `1a83ee579df324a7` |
| `docs/pocket/screen-settings.png` | settings | `6a66597d93d07be9` |
| `docs/pocket/screen-settings-toggled.png` | settings-toggled | `f547ebe89a7252b3` |

All six files have distinct bytes; the renderer rejects duplicate frames. The
tape is: move focus, open the item, run the first detail action, switch to
settings, move a row, toggle it.

Screens: Sessions/tools, session terminal, console settings. Interactions: SHELL/SSH/LOGS/STOP change session state; no PTY is spawned.

## Adapter

- **fixture** — this port runs from JSON baked into the package and labels the
  header `fixture`. `client.ts` also contains the `http` and `bridge` adapters
  behind the same `list()/get()/action()` surface.
- `http` uses `@pocketjs/framework/net-api`; valid only in the host dev profile.
- `bridge` uses `host.__pvc(JSON.stringify(request))`; the runtime forwards to
  the Go daemon on `127.0.0.1:<port>` with a hard timeout.
- Device gap: pocketshell-terminal PTY bridge. No WebSocket or xterm on the device profile.
- Daemon contract: /api/terminal/sessions, /api/ssh/profiles, /api/logs; mock SSH fixture.

## Not done / open questions

- Device run, saves/annotations and the bridge itself are out of this round.
- Real media/audio, OAuth, emulator, engine and system writes stay unimplemented
  where the original product already marked them mock or unavailable.
- Long lists use the six-item fixture surface; paging/virtual lists are a
  follow-up once the bridge provides paginated data.
