# Custom font for `.smeme`

This folder stores fonts used by the `.smeme` command.

## Usage

1. Place a font file here named **`impact.ttf`**, for example:

   ```
   assets/ttf/impact.ttf
   ```

2. Or point to a different path in `.env`:

   ```dotenv
   SMEME_FONT_PATH=assets/ttf/another-font.ttf
   ```

3. Restart the bot (or run the terminal `restart` command) after changing the font.

The font is registered directly by `@napi-rs/canvas` through
`GlobalFonts.registerFromPath()`. This means the font does **not** need to be
installed in Windows/Linux/macOS. If the file is missing or cannot be read, the
bot falls back to the system `Impact` font (then `Arial Black`/sans-serif).

## Licensing

No font files are included in this repository. `Impact` is a Microsoft font and
must not be committed without an appropriate license.

If you want to use another font, choose one whose license allows distribution
(for example, a font under the SIL Open Font License such as Anton), then place
it in this folder or point `SMEME_FONT_PATH` at it.
