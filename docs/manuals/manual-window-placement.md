# Window size and position

ChapterDesk remembers the size of its main window, and — where the operating
system allows it — its position on screen. The state is stored per user in

| OS | Location |
|----|----------|
| Linux (Electron) | `~/.config/chapterdesk/window-state.json` |
| Windows | `%APPDATA%\ChapterDesk\window-state.json` |
| macOS | `~/Library/Application Support/ChapterDesk/window-state.json` |

```json
{ "x": 120, "y": 80, "width": 1280, "height": 860, "maximized": false }
```

The file is written when the window is moved, resized, maximized or closed, and
read again on the next start. Delete it to fall back to the default size
(1280 × 860, centered).

## Wayland (KDE Plasma, GNOME, sway, …): the position is not restored

On a **Wayland** session a program is not allowed to place its own window —
the compositor decides. Electron ignores the requested `x`/`y`, and it does not
even learn where the window ended up, so ChapterDesk only remembers the
**size** there (nothing is written for the position, so the file stays clean).
That is not a bug in ChapterDesk; it is how Wayland is designed.

You can check your session type:

```bash
echo $XDG_SESSION_TYPE     # "wayland" or "x11"
```

### Option 1 — a KWin window rule (recommended on Plasma)

KWin can pin a window to a fixed position on every start:

1. Start ChapterDesk, right-click its title bar → **More Actions → Configure
   Special Application Settings…**
2. On the **Size & Position** tab set **Position** to *Apply initially* and
   enter the desired coordinates.
3. Make sure the rule matches the window: the window class is `ChapterDesk`
   (the `StartupWMClass` in the desktop entry). In a development run the class
   is `electron`.

This survives restarts and works for every future version.

### Option 2 — run through XWayland

Chromium (and therefore Electron) can be forced onto the X11 backend, where
clients may position themselves again:

```bash
ELECTRON_OZONE_PLATFORM_HINT=x11 ChapterDesk
```

`packaging/ChapterDesk-x11.desktop` is a ready-made launcher entry doing exactly
that — copy it to `~/.local/share/applications/` if you want it in the menu.
The trade-off is that the window is then drawn by XWayland (fractional scaling
and some input features can behave slightly differently).

### Option 3 — log in to an X11 session

KDE Plasma still offers a “Plasma (X11)” session at the login screen. There the
remembered position is restored as expected.

## Notes

- A saved position that would end up completely outside all connected displays
  (e.g. a second monitor was unplugged) is discarded and the window opens
  centered, so it can never become unreachable.
- The window cannot be resized below 900 × 600, and it never opens larger than
  the primary screen's work area.
