# Icons

The extension swaps the toolbar icon to show state, the same way the desktop
tool swapped its tray icon:

| State | Files | When |
|---|---|---|
| Idle | `idle16/32/48/128.png` | Installed and ready. Green dot. |
| Recording | `recording16/32/48/128.png` | A session is running. Red dot. |

The files currently in this folder are **placeholders**. Replace them with the
real artwork.

## What to hand over

Your existing set maps across like this:

- **Idle 378x376 PNG (green dot)** -> `idle16/32/48/128.png`
- **Recording 378x376 PNG (red dot)** -> `recording16/32/48/128.png`
- **Monitoring 378x376 PNG** -> not used. See below.
- **32x32 ICO** -> not used. Chrome does not read `.ico`; the 32px PNG replaces it.

Only PNG is needed, and only these four sizes. Chrome picks the closest size and
scales, so a missing size is not fatal, but supplying all four avoids soft edges
on high-DPI screens and in the extensions list.

## Idle vs monitoring

The desktop tool had three states because it had a third thing to say: it sat in
the tray watching Sipgate whether or not you were doing anything, so "installed"
and "watching for calls" were genuinely different. This extension has no call
watcher yet, so those two states would be the same picture with different
colours -- a distinction the operator cannot act on.

So for now: **use your monitoring icon (green dot) as the idle icon** and keep
the plain idle one aside. When the Sipgate/n8n trigger lands, we add the third
state back and the plain idle icon becomes "installed but not watching calls".

## Generating the sizes

From your 378x376 source, square it first so nothing is squashed:

```bash
magick monitoring.png -background none -gravity center -extent 378x378 sq.png
for s in 16 32 48 128; do
  magick sq.png -resize ${s}x${s} icons/idle${s}.png
done
```

Same for the red-dot file into `recording${s}.png`.

Two things to check at 16px, where these icons actually live: the dot must still
read as a distinct dot rather than a smudge on the edge of the glyph, and the
artwork needs a transparent background, since Chrome draws it on both light and
dark toolbars.
