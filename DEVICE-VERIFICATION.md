# DEVICE VERIFICATION — pocket-terminal

Status: **DEVICE-PASS** for the captured states. Local host verification is in
`apps/pocket-terminal/POCKETJS-VERIFICATION.md`.

## Device

- Anbernic RG34XX, Base OS 1.5.2 (h700), kernel 4.9.170 aarch64.
- Access: Debian host -> HX90 -> USB ADB.
- Display: `/dev/fb0`, 720x480 visible page, 32 bpp.
- Runtime: `/mnt/sdcard/System/pocketjs/bin/pocket-linux-kms` (existing boot runtime, not rebuilt or replaced).
- Package: `pocket-terminal` sha256 `604df68108ee36b7e295736f801fab5d3de5497993f758f482bd174c02abf53c`.
- Deployed to `/storage/pjs/pocket-terminal/app.pocket` only.

## Procedure

1. Recorded boot launcher pid `16016` and `boot.pocket`
   sha256 `6ed41612bce1723d1eda64b5a0ee9333a105ed498b7085c03267539cf6c1b32d`.
2. Paused the launcher supervisor, stopped the launcher, and started the
   package with the same runtime and `/dev/fb0`.
3. Created a virtual keyboard with `/dev/uinput` and drove the native view
   tree through a FIFO (`uinputd-c`); no host browser and no HTML.
4. Captured `/dev/fb0` with `dd` -> base64 -> PIL.
5. Killed the package, restored the launcher, and read the pid
   `13326` and boot hash back.

Result: launcher pid changed, boot package sha256 stayed
`6ed41612bce1723d1eda64b5a0ee9333a105ed498b7085c03267539cf6c1b32d`. No write to `/storage/System`, `/storage/pocketjs`,
`/storage/baseos.conf` or `/storage/content`.

## Frames

The images are the device framebuffer. The UI was rasterized by the PocketJS
native renderer on the RG34XX, not by host Chrome.

| file | sha256 (first 16) |
|---|---|
| `docs/device/device-terminal-detail-action.png` | `f4b041d463944027` |
| `docs/device/device-terminal-detail.png` | `27bd4eabd4843e99` |
| `docs/device/device-terminal-fb-after.png` | `d59130e3329b8496` |
| `docs/device/device-terminal-fb-before.png` | `d59130e3329b8496` |
| `docs/device/device-terminal-home-focus.png` | `c936776576bd40a4` |
| `docs/device/device-terminal-home.png` | `acc5bc426bbc682e` |
| `docs/device/device-terminal-settings-toggled.png` | `cad0e975d31e1d41` |
| `docs/device/device-terminal-settings.png` | `b74c25f998b817ef` |

`device-terminal-fb-before.png` and `device-terminal-fb-after.png` are the boot
launcher before and after; they are byte-identical here, which is the intended
restore evidence.

Captured states: 6 states: home, focus, detail, detail action, settings, settings toggle.
