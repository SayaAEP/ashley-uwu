# Plugin Development Guide

This guide matches the current Ashley UwU codebase: recursive plugin loading,
subfolders (`plugins/owner/`), the shared media toolkit, and the owner runtime
commands.

## Plugin Structure

A plugin is a single `.js` file anywhere inside `plugins/`, including
subfolders:

```
plugins/
├── ping.js                 → plugins/ping.js
├── sticker.js              → plugins/sticker.js
└── owner/
    ├── reload.js           → plugins/owner/reload.js
    └── reconnect.js        → plugins/owner/reconnect.js
```

The loader walks `plugins/` recursively (maximum depth 5), skips dot-folders,
`node_modules`, and symlinks. Paths are tracked relative to `plugins/`, so
`plugins/owner/reload.js` is `owner/reload.js`.

> Import depth depends on the file location:
>
> - top-level plugin: `require('../config')`, `require('../utils/media')`
> - plugin in `owner/`: `require('../../config')`, `require('../../utils/media')`

### Template

```js
/**
 * Plugin: YourPluginName
 * Short description of what this plugin does
 *
 * Usage:
 *   - .yourcommand — what it does
 *   - .yourcommand <args> — what it does with arguments
 */

const config = require('../config');

// ═══════════════════════════════════════════════════════
//  CONFIGURATION — Edit values below to customize
// ═══════════════════════════════════════════════════════
let someVariable = config.botName;
let anotherVariable = 'default value';
// ═══════════════════════════════════════════════════════

module.exports = {
    name: 'yourcommand',
    aliases: ['yc', 'shortcut'],
    description: 'Short description of the command',
    usage: `${config.prefix}yourcommand <args>`,
    category: 'General',
    ownerOnly: false,
    groupOnly: false,

    async handler(client, message, args) {
        // Your logic here
        await message.reply('Hello!');
    },
};
```

---

## Rules

### 1. Config Variables at the Top

If your plugin has customizable values, place them at the top of the file
(after imports), inside the `═══` border block.

- **Default:** `let name = config.botName;` (references config)
- **Custom:** `let name = 'My Custom Name';` (hardcoded string)

Users can edit these values without understanding the rest of the code.

### 2. Required Fields

| Field         | Type           | Required | Description                                  |
|---------------|----------------|----------|----------------------------------------------|
| `name`        | string         | Yes      | Command name (lowercase, unique)             |
| `handler`     | async function | Yes      | `handler(client, message, args)`             |
| `aliases`     | string[]       | No       | Alternative command names                    |
| `description` | string         | No       | Short description for the help menu          |
| `usage`       | string         | No       | Usage example                                 |
| `category`    | string         | No       | Category for grouping in `.menu`             |
| `ownerOnly`   | boolean        | No       | Restrict to the bot owner                     |
| `groupOnly`   | boolean        | No       | Restrict to group chats                       |

`handler` is called with:

- `client` — the `whatsapp-web.js` client (already wrapped by the bot)
- `message` — the incoming `Message`
- `args` — array of whitespace-separated arguments, prefix already removed

### 3. File Naming and Subfolders

| Path                              | Status                            |
|-----------------------------------|-----------------------------------|
| `plugins/ping.js`                 | **Active** — loaded               |
| `plugins/ping.unload.js`          | **Disabled** — skipped            |
| `plugins/owner/reload.js`         | **Active** — loaded               |
| `plugins/owner/reload.unload.js`  | **Disabled** — skipped            |

Rename `plugin.js` to `plugin.unload.js` to disable it without deleting.
Rename it back to re-enable. This works at any depth.

Convention: owner-only/system commands live in `plugins/owner/`, for example
`plugins/owner/reload.js`. The folder name is a convention only — permissions
still come from `ownerOnly`.

### 4. Hot-Reload

The bot watches `plugins/` recursively:

- **Edit a file** — plugin reloads automatically
- **Add a new file** — plugin loads instantly
- **Delete a file** — plugin unloads
- **Rename to `.unload.js`** — plugin disabled
- **Rename back to `.js`** — plugin re-enabled
- **Subfolder changes** — `plugins/owner/…` is watched too

No bot restart is needed for plugin files.

Limitations:

- Only plugin files under `plugins/` are purged from the require cache. Editing
  `utils/`, `config.js`, or `.env` still needs a full restart.
- If the platform does not support recursive watching, hot-reload is disabled
  and the log says so. Use the owner command `.reload` (or terminal `reload`)
  to reload manually.

### 5. Cooldown

Every command uses the per-user, per-command cooldown from `config.js`:

```js
cooldownMs: 3000,
```

The cooldown slot is reserved before the handler runs, so two messages arriving
together cannot both execute. There is no per-plugin cooldown override.

### 6. Permissions

- `ownerOnly: true` — only `OWNER_NUMBER` can run it. The bot normalizes
  `@c.us`/`@lid`, device suffixes, `+`, and spaces; in groups it checks the
  message author.
- `groupOnly: true` — only works when `(await message.getChat()).isGroup` is
  true.

If `OWNER_NUMBER` is empty or still the placeholder, owner-only commands are
denied and the bot warns at startup.

### 7. Command Parsing

Commands come from `message.body` using `PREFIX` and `SECOND_PREFIX`
(default `.` and `!`):

- The longest matching prefix wins.
- The command name is lowercased.
- Arguments are split on whitespace; quotes are not special.
- Media captions are parsed the same way (`image + caption ".sticker"` works).
- Messages sent by the bot itself are ignored, so replies cannot re-trigger a
  command.

### 8. Errors and Replies

- If your handler throws, the dispatcher logs the error and sends a generic
  "An error occurred…" reply.
- For expected failures, reply yourself and return (do not throw):

```js
if (!input) {
    await message.reply('Send an image or video first.');
    return;
}
```

- `message.reply(text)` quotes the incoming message; `client.sendMessage(chatId,
  text)` sends without quoting.

---

## Media Plugins

Do **not** import `sharp`, `child_process`, `fs`, or `os` directly for media
work. Use the shared toolkit so queueing, temporary files, and FFmpeg errors are
handled in one place:

```js
const media = require('../utils/media'); // '../../utils/media' in a subfolder

const sticker = await media.toSticker(input);
const result = await media.stickerToVisual(stickerMedia); // { kind, media }
await media.run(() => heavyTask(), { label: 'my-plugin' });
media.stats();
```

Error codes you can branch on:

| `err.code` | Meaning |
|---|---|
| `MEDIA_BUSY` | Queue is full; ask the user to retry |
| `MEDIA_UNSUPPORTED` | Media type is not supported |
| `MEDIA_FFMPEG_MISSING` | FFmpeg is not installed/configured |
| `MEDIA_CONVERT_FAILED` | FFmpeg/sharp failed |

Concurrency is controlled by `MEDIA_CONCURRENCY` (default 2) and is shared by
every media plugin. Full API and extension guide:
[docs/MEDIA.md](MEDIA.md).

---

## Owner / System Plugins

Owner-only runtime commands live in `plugins/owner/`:

| Command | Alias | Action |
|---|---|---|
| `.reload` | `.rl` | Reload all plugins |
| `.reconnect` | `.rc` | Rebuild the WhatsApp client (same session) |
| `.restart` | `.rs` | Reload plugins + reconnect (soft restart) |

They call the registry in `utils/botControl.js`; plugins must never
`require('../main')` because main starts the bot on import:

```js
const botControl = require('../../utils/botControl');

module.exports = {
    name: 'reload',
    aliases: ['rl'],
    description: 'Reload all plugins without restarting the process',
    usage: '.reload',
    category: 'System',
    ownerOnly: true,
    groupOnly: false,

    async handler(client, message) {
        if (!botControl.isAvailable('reloadPlugins')) {
            await message.reply('Reload is not available yet.');
            return;
        }

        const result = await botControl.reloadPlugins();
        await message.reply(`Reloaded ${result.loaded} plugin(s).`);
    },
};
```

Available hooks: `reloadPlugins()`, `reconnect(reason)`,
`restart(reason)`, `status()`, `isAvailable(action)`.

Do **not** call `process.exit()` from a chat handler. Use `botControl.restart()`
for a soft restart, or the terminal `exit` command for a full stop. A hard
process restart needs an external supervisor (NSSM/Task Scheduler/PM2).

---

## Loading and Conflicts

- Files are discovered in sorted order (recursive).
- `name` must be unique across all folders. If two files declare the same
  command name, the later one is skipped with a warning.
- Alias collisions are skipped with a warning; the original owner keeps the
  alias.
- Invalid plugins (no object export, missing `name`, non-function `handler`) are
  skipped and logged.
- Reloading a plugin removes the previous object and its aliases first, so
  aliases always point to the newest code.

---

## Examples

### Simple Command

```js
/**
 * Plugin: Ping
 * Check if the bot is alive
 */

module.exports = {
    name: 'ping',
    aliases: ['p'],
    description: 'Check if the bot is alive',
    usage: '.ping',
    category: 'General',
    ownerOnly: false,
    groupOnly: false,

    async handler(client, message) {
        const start = Date.now();
        await message.reply('Pong!');
        const latency = Date.now() - start;
        await client.sendMessage(message.from, `Response time: ${latency}ms`);
    },
};
```

### Command with Config Variables

```js
/**
 * Plugin: Sticker
 * Convert images to stickers
 */

const config = require('../config');

// ═══════════════════════════════════════════════════════
//  CONFIGURATION — Edit values below to customize
// ═══════════════════════════════════════════════════════
let stickerAuthor = config.botName;
let stickerName = config.stickerName;
// ═══════════════════════════════════════════════════════

module.exports = {
    name: 'sticker',
    aliases: ['s'],
    description: 'Convert an image or video to a sticker',
    usage: `${config.prefix}sticker`,
    category: 'Media',
    ownerOnly: false,
    groupOnly: false,

    async handler(client, message) {
        // ... download media, then:
        // const sticker = await require('../utils/media').toSticker(input);
    },
};
```

### Media Command Using the Toolkit

```js
const media = require('../utils/media');

module.exports = {
    name: 'sticker',
    aliases: ['s'],
    description: 'Convert an image or video to a sticker',
    usage: '.sticker',
    category: 'Media',
    ownerOnly: false,
    groupOnly: false,

    async handler(client, message) {
        if (!message.hasMedia) {
            await message.reply('Send an image or video.');
            return;
        }

        const input = await message.downloadMedia();

        try {
            const sticker = await media.toSticker(input);
            await client.sendMessage(message.from, sticker, {
                sendMediaAsSticker: true,
                stickerAuthor: 'Ashley UwU',
                stickerName: 'Made with magic sparkle',
            });
        } catch (err) {
            if (err.code === media.CODES.UNSUPPORTED) {
                await message.reply('Only images and videos can become stickers.');
                return;
            }
            throw err; // dispatcher logs and replies generically
        }
    },
};
```

### Owner-Only Command

```js
// plugins/owner/clearcache.js
const config = require('../../config');

module.exports = {
    name: 'clearcache',
    aliases: ['cc'],
    description: 'Example owner-only command',
    usage: `${config.prefix}clearcache`,
    category: 'System',
    ownerOnly: true,
    groupOnly: false,

    async handler(client, message) {
        await message.reply('Cache cleared (example).');
    },
};
```

### Group-Only Command

```js
module.exports = {
    name: 'tagall',
    aliases: ['everyone'],
    description: 'Mention every group member',
    usage: '.tagall',
    category: 'Group',
    ownerOnly: false,
    groupOnly: true,

    async handler(client, message) {
        const chat = await message.getChat();
        const mentions = chat.participants.map((participant) => participant.id._serialized);
        const text = chat.participants
            .map((participant) => `@${participant.id.user}`)
            .join(' ');

        await client.sendMessage(message.from, text, { mentions });
    },
};
```

---

## Checklist

Before considering a plugin done:

- [ ] File is inside `plugins/` or a subfolder, with `.js` extension.
- [ ] Imports use the correct depth (`../` vs `../../`).
- [ ] `name` is unique and lowercase; `handler` is a function.
- [ ] `usage` uses `config.prefix`, not a hardcoded prefix.
- [ ] Expected failures reply with `message.reply()` and return.
- [ ] Media work goes through `utils/media`, never direct FFmpeg/sharp.
- [ ] Permissions (`ownerOnly`/`groupOnly`) match the command's purpose.
- [ ] Tested via chat, `.menu`, and reload/disable (`.unload.js`).
