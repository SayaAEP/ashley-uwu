# Browser Engine

Ashley UwU drives WhatsApp Web through `puppeteer-core`. The browser is
resolved at startup from a primary path, a fallback path, `browser-bin/`, or
well-known system locations.

Two engines are supported:

| Engine | Status | Browsers |
|---|---|---|
| `chromium` | Supported | Chrome, Chromium, Edge, Brave, Vivaldi, Opera, Thorium, Natrium, ungoogled-chromium |
| `firefox` | **Experimental** | Firefox, Firefox ESR, LibreWolf, Waterfox, IceCat, Iceweasel, Basilisk, Pale Moon, Tor Browser |

> `whatsapp-web.js` officially supports Chromium only. Firefox runs through
> Puppeteer's WebDriver BiDi implementation. Basic use and media commands are
> verified (see [Firefox compatibility](#firefox-compatibility)), but future
> WhatsApp Web changes or untested Puppeteer features may break it.

## Requirements

- **Chromium engine:** any recent Chromium-based browser.
- **Firefox engine:** a Firefox build with WebDriver BiDi support. The project
  was verified against Firefox `153.7.0`.
- `puppeteer-core` does not ship a browser, so an executable path is required
  unless auto-detection finds one.

## Quick start

### Chromium (default)

Install Chrome/Chromium (or any supported fork) and run the bot. Auto-detection
usually finds it. To point at a specific build:

```env
BROWSER_ENGINE=auto
BROWSER_EXECUTABLE_PATH=E:/ungoogled-chromium-portable/app/chrome.exe
```

### Firefox

1. Install Firefox (or a Firefox family build such as LibreWolf).
2. Add to `.env`:

   ```env
   BROWSER_ENGINE=auto
   BROWSER_EXECUTABLE_PATH=C:/Program Files/Mozilla Firefox/firefox.exe
   # Optional: Chromium used if Firefox fails to start
   BROWSER_FALLBACK_EXECUTABLE_PATH=E:/ungoogled-chromium-portable/app/chrome.exe
   ```

3. Restart the bot.
4. Scan the QR code **once** for Firefox. Chromium and Firefox session formats
   are not interchangeable, so each engine has its own login (see
   [Sessions](#sessions)).

Expected log:

```text
[INFO] Browser: using firefox (configured path) → C:/Program Files/Mozilla Firefox/firefox.exe
[INFO] Auth: LocalAuth → .../.wwebjs_auth
[INFO] Browser: firefox → C:/Program Files/Mozilla Firefox/firefox.exe
[ OK ] Authentication successful!
```

## Configuration reference

All settings live under one `BROWSER_*` namespace.

| Key | Default | Description |
|---|---|---|
| `BROWSER_ENGINE` | `auto` | `auto`, `chromium`, or `firefox`. |
| `BROWSER_EXECUTABLE_PATH` | — | Primary browser executable. |
| `BROWSER_FALLBACK_EXECUTABLE_PATH` | — | Second path, used when the primary is missing or fails to start. |
| `BROWSER_CHROMIUM_ARGS` | low-RAM flags from `config.js` | Chromium command line flags (comma-separated or JSON array). |
| `BROWSER_FIREFOX_ARGS` | empty | Firefox command line flags. Never put Chromium flags here. |
| `BROWSER_PROTOCOL_TIMEOUT` | `300000` | Puppeteer protocol timeout in ms; applies to both engines. `0` disables it. |

`BROWSER_CHROMIUM_ARGS` and `BROWSER_FIREFOX_ARGS` are separate because
Chromium flags (`--no-sandbox`, `--disable-gpu`, …) are meaningless — and
sometimes harmful — to Firefox.

### Migration from older versions

These names are **no longer read**:

| Old | New |
|---|---|
| `BROWSER_PATH` | `BROWSER_EXECUTABLE_PATH` |
| `PUPPETEER_EXECUTABLE_PATH` | `BROWSER_EXECUTABLE_PATH` or `BROWSER_FALLBACK_EXECUTABLE_PATH` |
| `PUPPETEER_ARGS` | `BROWSER_CHROMIUM_ARGS` |
| `PUPPETEER_PROTOCOL_TIMEOUT` | `BROWSER_PROTOCOL_TIMEOUT` |

## Engine detection (`auto`)

The engine is inferred from the resolved path:

- The path contains `firefox`, `librewolf`, `waterfox`, `icecat`, `iceweasel`,
  `basilisk`, `palemoon`, `tor-browser`, or `torbrowser` → **firefox**.
- Anything else → **chromium**.

Chromium is the default, so forks with non-obvious names (Thorium, Natrium,
Vivaldi, Opera, …) work without being listed. A renamed Firefox binary is the
one case that needs `BROWSER_ENGINE=firefox`.

## Resolution order

1. `BROWSER_EXECUTABLE_PATH`
2. `BROWSER_FALLBACK_EXECUTABLE_PATH`
3. `browser-bin/<name>/` — any executable file; helper binaries such as
   `chrome_crashpad_handler` are skipped
4. Well-known system locations + `PATH`

With a forced engine, configured paths belonging to the other engine are
skipped (with an `ignoring it` warning), so `BROWSER_ENGINE=chromium` picks the
Chromium fallback even when the primary is Firefox.

A path found by auto-detection is written back to `.env` as
`BROWSER_EXECUTABLE_PATH`.

## Fallback

- The fallback is **lazy**: it is only resolved after the primary engine fails
  to launch or initialize, so a successful start produces no fallback warnings.
- Fallback applies to the **initial start** only. Once an engine is running,
  reconnects keep using it to avoid flapping between profiles.
- If neither engine can start, the process exits with an error instead of
  retrying forever.

## Sessions

Both engines share `.wwebjs_auth/session`. Chromium keeps its login under
`Default/`; Firefox writes its own profile files alongside, and neither touches
the other's data.

Session formats are still engine-specific: each engine needs a one-time QR
login. After that both logins persist side by side, so switching back to a
previously used engine reuses its session.

## Firefox compatibility

### What the BiDi shim does

Puppeteer's WebDriver BiDi serializer (used by Firefox) only accepts plain
objects. `whatsapp-web.js` passes `MessageMedia` **class instances** into
`page.evaluate()` when sending media, which Chromium's CDP serializer tolerates
but BiDi rejects:

```text
Custom object serialization not possible. Use plain objects instead.
```

`utils/bidiCompat.js`, loaded automatically from `main.js`, fixes this by:

1. teaching `instanceof MessageMedia` to accept plain media objects, and
2. converting `MessageMedia` arguments (`content` and `options.media`) to plain
   objects inside `Client.prototype.sendMessage` before Puppeteer serializes
   them.

Plugins do not need to do anything — see
[PLUGINS.md](PLUGINS.md#cross-engine-firefox-notes).

### Verified

- QR login and `ready`.
- Text commands (`.menu`, `.ping`, `.echo`).
- Media sends: `.sticker` / `.s` (image and video), `.smeme`, `.toimg`.
- Fallback from Firefox to Chromium.

### Caveats

- Upstream support is Chromium-only; treat Firefox as a test engine.
- Chromium-only Puppeteer options (proxy authentication, `bypassCSP`) are not
  used by this project but would not work on Firefox.
- Interactive messages/buttons remain unsupported on both engines (unrelated
  to the browser choice).
- New WhatsApp Web releases can break BiDi behavior before Chromium.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Custom object serialization not possible` | `utils/bidiCompat.js` was not loaded, or a plugin calls `client.pupPage.evaluate()` directly with a class instance. | Keep the `require("./utils/bidiCompat")` in `main.js`; send media through `client.sendMessage` / `message.reply`. |
| `Browser engine "firefox" failed: …` | Firefox could not launch or initialize (bad path, incompatible build, BiDi error). | Check the path, update Firefox, or rely on the Chromium fallback. |
| `No Firefox-based browser found` | `BROWSER_ENGINE=firefox` with no Firefox path. | Set `BROWSER_EXECUTABLE_PATH` or install Firefox. |
| QR code appears on every start | Each engine has its own session format. | Expected after switching engines; scan once per engine. |
| `Configured path looks like firefox, but BROWSER_ENGINE=chromium; ignoring it` | Forced engine encountered a path of the other engine. | Expected during fallback; change `BROWSER_ENGINE` or the path if unintended. |
| Chromium flags appear to have no effect on Firefox | Chromium and Firefox use different flags. | Use `BROWSER_FIREFOX_ARGS`, not `BROWSER_CHROMIUM_ARGS`. |
