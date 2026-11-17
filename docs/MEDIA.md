# Media Toolkit

`utils/media` is the only media API plugins should use. It exists so plugins do
not need to know about the queue, FFmpeg, sharp, temporary files, or conversion
order.

## Why does it exist?

Previously `plugins/sticker.js` had to handle video conversion itself, and
`plugins/toimg.js` handled GIF/MP4. When every plugin does that, media code gets
scattered, resources compete, and testing becomes hard.

Now:

```
plugins/sticker.js ─┐
plugins/toimg.js  ──┼──► utils/media ──► queue ──► sharp / FFmpeg
new plugin        ──┘
```

Plugins only call high-level functions. All heavy work automatically enters the
same queue (default 2 concurrent jobs, at most 10 waiting).

## API

```js
const media = require("../utils/media");
```

### `media.toSticker(input, options?)`

Prepares media so it can be sent with `sendMediaAsSticker: true`.

- `image/*` → passed through as-is. WhatsApp Web performs the conversion, so
  the result stays the same as before.
- `video/*` → converted locally to animated WebP (FFmpeg), through the queue.
- other types → `MEDIA_UNSUPPORTED`.

Options: `maxDurationSec` (default 5, max 10), `fps` (default 10).

```js
const sticker = await media.toSticker(inputMedia);
await client.sendMessage(message.from, sticker, {
  sendMediaAsSticker: true,
  stickerAuthor: "Ashley UwU",
  stickerName: "Made with magic sparkle",
});
```

### `media.stickerToVisual(stickerMedia)`

Turns a WebP sticker into something viewable.

```js
const result = await media.stickerToVisual(stickerMedia);
// { kind: "image", media }     → PNG (alpha preserved, padding trimmed)
// { kind: "animation", media } → MP4 (sent as a GIF, padded canvas cropped)
```

`kind` is determined from the `ANIM` chunk in the WebP container.

Both outputs are cropped to the sticker's actual content, not WhatsApp's padded
512×512 canvas. Static images use sharp's `trim()`; animated stickers use the
union of visible (non-transparent) pixels across every frame, because sharp
refuses `trim()` on multi-page images.

Animated stickers can be converted to three formats via `options.animation`:

```js
await media.stickerToVisual(stickerMedia, { animation: "gif" });  // real GIF file
await media.stickerToVisual(stickerMedia, { animation: "webm" }); // WebM/VP9 with full alpha
await media.stickerToVisual(stickerMedia, { animation: "mp4" });  // H.264, plays inline
```

- **GIF** (`image/gif`) keeps 1-bit transparency and remains a real GIF file —
  but only if sent with `sendMediaAsDocument: true`. Sent as ordinary media,
  WhatsApp rewrites it to MP4 on its servers.
- **WebM** (`video/webm`, VP9 + `yuva420p`) keeps the full alpha plane, also to
  be sent as a document.
- **MP4** (H.264 + yuv420p) cannot carry alpha, so transparent pixels become a
  solid colour. It is the only format WhatsApp plays inline in the chat.

### `media.run(task, meta?)`

Runs other heavy work on the same media queue. Use it when a new plugin needs
sharp/FFmpeg (for example, a meme generator) without creating its own queue.

```js
const output = await media.run(() => sharp(buffer).resize(512).toBuffer(), {
  label: "sticker-smeme",
});
```

If the queue is full, `run()` throws a `MediaError` with code `MEDIA_BUSY`
(same as the other media operations). Errors thrown inside the task are passed
through unchanged so plugins can provide specific messages. A real example:
`plugins/sticker_smeme.js` renders meme text through `media.run()`.

### `media.stats()`

```js
{ name: "media", active: 1, queued: 3, concurrency: 2, maxPending: 10 }
```

## Engine compatibility

The toolkit returns `MessageMedia` objects. Both browser engines accept them:

- **Chromium** uses Puppeteer's CDP serializer, which handles class instances.
- **Firefox** uses WebDriver BiDi, which only accepts plain objects.

`utils/bidiCompat.js` (loaded automatically by `main.js`) bridges the gap by
converting `MessageMedia` instances to plain objects at send time and making
`instanceof MessageMedia` accept both forms. Plugin and toolkit APIs are
unchanged.

Send the result through `client.sendMessage()` or `message.reply()`. Do not
pass media to `client.pupPage.evaluate()` directly — that skips the conversion
and fails on Firefox.

## Errors

Every media failure is thrown as a `MediaError` with an `err.code`:

| Code | Meaning | Plugin suggestion |
|---|---|---|
| `MEDIA_BUSY` | queue is full | reply "try again in a moment" |
| `MEDIA_UNSUPPORTED` | unsupported media type | reply with supported formats |
| `MEDIA_FFMPEG_MISSING` | FFmpeg was not found | reply with install instructions |
| `MEDIA_CONVERT_FAILED` | conversion failed | reply that processing failed, log details |

```js
try {
  const sticker = await media.toSticker(input);
  // ...
} catch (err) {
  if (err.code === media.CODES.BUSY) {
    return message.reply("Media queue is full, try again in a moment.");
  }
  throw err; // handled by handlers/plugin.js
}
```

## Adding a new operation

Example: `.sticker` later gains a watermark.

1. Add the transformation in `utils/media/convert.js`:

   ```js
   async function addWatermark(buffer, text) {
     // sharp/FFmpeg
   }
   ```

2. Add a public wrapper in `utils/media/index.js`:

   ```js
   async function toStickerWithWatermark(input, text) {
     const prepared = await toSticker(input);
     const buffer = convert.decodeMedia(prepared);
     return enqueue("sticker-watermark", () => convert.addWatermark(buffer, text));
   }
   ```

3. Call it from the plugin (`plugins/sticker.js`), not from the plugin handler.

4. Verify it manually in chat and document it in this file.

General rules:

- **Media transformation** → `utils/media`.
- **Command behavior** (argument parsing, replies, captions, metadata) → plugin.
- **Non-media heavy work** that should share the queue → `media.run()`.

## Internal files

| File | Contents |
|---|---|
| `utils/media/index.js` | Public API, validation, queue, errors |
| `utils/media/convert.js` | video→WebP, WebP→PNG/GIF/MP4/WebM, animation detection, content cropping |
| `utils/media/ffmpegRunner.js` | FFmpeg execution, temp files, timeout, cleanup |
| `utils/bidiCompat.js` | Firefox/BiDi media serialization shim |
| `utils/taskQueue.js` | Generic queue (`createQueue`) for other needs |

The queue is created with `createQueue`, so other features can have their own
queues without blocking each other:

```js
const { createQueue } = require("../utils/taskQueue");
const downloadQueue = createQueue({ concurrency: 1, maxPending: 5, name: "download" });
```
