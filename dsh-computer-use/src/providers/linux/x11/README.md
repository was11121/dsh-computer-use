# dsh-computer-use X11 helper

A small native helper that owns the X11 connection (window enumeration,
screenshots, XTest input, AT-SPI/clipboard are partially stubbed).

## Build

```sh
sudo apt install build-essential libx11-dev libxtst-dev libxext-dev zlib1g-dev
make
```

## Run

The Node provider spawns `dsh-computer-use-x11-helper` (override with an
absolute `DSH_COMPUTER_USE_X11_HELPER` path). The helper speaks JSON-lines on
stdio. Every response echoes the request `id` — the provider matches strictly
by id and drops id-less responses:

```text
> {"id":1,"method":"listWindows"}
< {"id":1,"ok":true,"value":[...]}
```

Meta/Super/Hyper keys and raw numeric keycodes are refused by the helper, and
`activateWindow` reports success only after the target is verified active via
`_NET_ACTIVE_WINDOW`.

## Status

- Implemented: window enumeration, getWindow, PNG capture, activation, XTest
  mouse/keyboard, scroll, drag.
- TODO: AT-SPI2 accessibility tree, clipboard selection owner, Wayland
  integration (see `../wayland/`).
