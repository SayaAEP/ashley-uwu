# Data and Privacy

## Where Is Data Stored?

### Session Data (`.wwebjs_auth/`)

When you scan the QR code, the WhatsApp Web session is stored locally:

```
ashley-uwu/
└── .wwebjs_auth/
    └── session/
        ├── Default/          WhatsApp session keys, cookies, localStorage
        ├── Local State       Chrome encryption keys
        └── ...               Browser profile data (~300MB+)
```

**Contents:**

| Data           | Description                      | Risk     |
|----------------|----------------------------------|----------|
| Session keys   | WhatsApp encryption keys         | HIGH — full WhatsApp access |
| Cookies        | WhatsApp Web login cookies       | HIGH — session hijack risk  |
| IndexedDB      | Message history, contacts        | MEDIUM — personal data      |
| Browser cache  | Cached images, scripts           | LOW — WhatsApp Web assets   |

> **Warning:** Anyone with access to `.wwebjs_auth/` can log into your WhatsApp without scanning QR. Treat this folder like a password.

### Cache Data (`.wwebjs_cache/`)

Puppeteer/Chrome browser cache. Contains downloaded WhatsApp Web assets.
Can be safely deleted — it regenerates on next start.

### Log Data (terminal / process output)

The bot logs to the console only; it does not create log files by itself.
Command activity is logged at normal level and includes:

- the command text you (or anyone allowed to use the bot) send,
- the sender's pushname and, for groups, the group name.

With `DEBUG=true`, logs additionally include connection-state details, extra
media diagnostics, and error stack traces that may contain message or file
details.

If you run under PM2, systemd, Docker, or redirect output to a file, those
platforms may persist the logs. Treat that output as personal data: restrict
file permissions, rotate/delete it, and turn `DEBUG` off when it is not needed.

---

## Security Recommendations

### 1. Never share `.wwebjs_auth/`

This folder is in `.gitignore` by default. Never commit it to version control, share it, or upload it.

### 2. Use a dedicated WhatsApp number

Do not use your personal WhatsApp for the bot. Use a separate number or SIM card.

### 3. File permissions (Linux/Mac)

Restrict access to the auth folder:

```bash
chmod 700 .wwebjs_auth/
```

### 4. Encrypt at rest (optional)

On Windows, enable BitLocker. On Linux, use LUKS. This protects session data if the disk is compromised.

### 5. Clear session when done

If you stop using the bot, delete the session:

```bash
rm -rf .wwebjs_auth/

# Windows:
rmdir /s /q .wwebjs_auth
```

You can also unlink from WhatsApp: Settings > Linked Devices > remove "Chrome".

---

## Auth Strategies

Ashley UwU supports three auth strategies, configured in `config.js`:

### LocalAuth (Default)

```js
authStrategy: 'local',
```

- Session saved to disk (`.wwebjs_auth/`)
- Simple, no external dependencies
- Not suitable for platforms without persistent disk (Heroku, serverless)

### RemoteAuth (MongoDB)

```js
authStrategy: 'remote',
mongoUri: 'mongodb://localhost:27017/ashley-uwu',
```

- Session saved to MongoDB
- Survives server restarts, supports multi-server
- Requires MongoDB setup and `wwebjs-mongo` package

### NoAuth

```js
authStrategy: 'none',
```

- No session persistence, QR scan required on every restart
- Most private — nothing stored on disk
- Inconvenient for frequent restarts

---

## FAQ

**Q: Can the bot read personal messages?**
A: Yes. The bot has access to all messages on the linked account. It only processes messages starting with the configured prefix, but it technically sees everything.

**Q: Is data sent anywhere?**
A: No. Ashley UwU runs entirely on your machine. No data is sent externally unless you configure RemoteAuth with an external database.

**Q: What if someone steals the `.wwebjs_auth/` folder?**
A: They can access your WhatsApp. Immediately go to WhatsApp > Settings > Linked Devices and remove all linked devices.

**Q: How do I remove all bot data?**
A: Delete these folders and unlink from WhatsApp:

```bash
rm -rf .wwebjs_auth/ .wwebjs_cache/
```
