'use strict';

/**
 * Persistence of the ChapterDesk window position / size (Electron only).
 *
 * The state is a small JSON file in the Electron userData directory, so it is
 * per user and survives app upgrades:
 *
 *   { "x": 120, "y": 80, "width": 1280, "height": 860, "maximized": false }
 *
 * `x`/`y` are only restored while the window would actually be visible on one
 * of the connected displays — a monitor may have been unplugged since the file
 * was written, and an off-screen window would be unreachable.
 *
 * The module is deliberately free of `electron` imports (the caller passes the
 * display list in), so the geometry rules can be checked with plain node.
 */

const fs = require('fs');
const path = require('path');

/** Default / minimum window size. */
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 860;
const MIN_WIDTH = 900;
const MIN_HEIGHT = 600;
/** How much of the window must be visible on a display to accept a saved x/y. */
const VISIBLE_MARGIN_X = 120;
const VISIBLE_MARGIN_Y = 80;

/** Path of the persisted window state file inside `userData`. */
function windowStatePath(userDataDir) {
  return path.join(userDataDir, 'window-state.json');
}

/**
 * Read a persisted state. Returns null when the file is missing, unreadable or
 * does not contain a usable size.
 */
function loadWindowState(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const width = Number(parsed.width);
  const height = Number(parsed.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  const x = Number(parsed.x);
  const y = Number(parsed.y);
  return {
    width,
    height,
    x: Number.isFinite(x) ? x : null,
    y: Number.isFinite(y) ? y : null,
    maximized: parsed.maximized === true,
  };
}

/**
 * Whether the compositor lets the client choose its own screen position.
 *
 * On WAYLAND a client cannot place its own toplevel window — the compositor
 * (KWin, Mutter, sway, …) decides, and Electron's `x`/`y` BrowserWindow
 * options are ignored (the window opens centered / per compositor policy).
 * Chromium's Wayland backend does not report a position either, so
 * `getBounds()` returns x/y = 0. Positioning only works under X11, or under
 * Wayland when Chromium runs through XWayland (`--ozone-platform=x11` /
 * `ELECTRON_OZONE_PLATFORM_HINT=x11`).
 *
 * @param {Record<string,string|undefined>} env usually `process.env`
 * @param {string[]} [argv] usually `process.argv` (checks --ozone-platform)
 */
function canPositionWindows(env = process.env, argv = process.argv ?? []) {
  const wayland =
    (env.XDG_SESSION_TYPE ?? '').toLowerCase() === 'wayland' ||
    !!env.WAYLAND_DISPLAY;
  if (!wayland) return true;
  // An explicit X11 choice means Chromium runs under XWayland → positioning works.
  const forcedX11 = argv.some(
    (arg) => arg === '--ozone-platform=x11' || arg === '--ozone-platform-hint=x11',
  );
  const hint = (env.ELECTRON_OZONE_PLATFORM_HINT ?? env.OZONE_PLATFORM ?? '').toLowerCase();
  return forcedX11 || hint === 'x11';
}

/**
 * Write a state (creating the directory when needed). Never throws.
 * `includePosition: false` stores only size + maximized (Wayland) so a stale
 * 0/0 never travels to an X11 session later.
 */
function saveWindowState(file, state, includePosition = true) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const payload = {
      width: Math.round(state.width),
      height: Math.round(state.height),
      maximized: state.maximized === true,
    };
    if (includePosition) {
      payload.x = Math.round(state.x);
      payload.y = Math.round(state.y);
    }
    fs.writeFileSync(file, JSON.stringify(payload, null, 2));
    return true;
  } catch {
    return false;
  }
}

/** True when at least VISIBLE_MARGIN_* px of `bounds` lies on a display. */
function isVisibleOnSomeDisplay(bounds, displays) {
  for (const display of displays ?? []) {
    const area = display.workArea ?? display.bounds;
    if (!area) continue;
    const overlapX = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
    const overlapY = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
    if (overlapX >= VISIBLE_MARGIN_X && overlapY >= VISIBLE_MARGIN_Y) return true;
  }
  return false;
}

/**
 * Turn a stored state into BrowserWindow bounds: the size is clamped into the
 * primary work area, and the position is only used while it is still on a
 * connected display (otherwise the window opens centered — i.e. no x/y).
 *
 * @param {{width:number,height:number,x:number|null,y:number|null}|null} state
 * @param {{x:number,y:number,width:number,height:number}} primaryWorkArea
 * @param {{workArea?:{x:number,y:number,width:number,height:number},bounds?:{x:number,y:number,width:number,height:number}}[]} displays
 */
function resolveWindowBounds(state, primaryWorkArea, displays) {
  const area = primaryWorkArea ?? { x: 0, y: 0, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
  const width = Math.max(
    MIN_WIDTH,
    Math.min(Math.round(state?.width ?? DEFAULT_WIDTH), area.width),
  );
  const height = Math.max(
    MIN_HEIGHT,
    Math.min(Math.round(state?.height ?? DEFAULT_HEIGHT), area.height),
  );
  if (
    state &&
    state.x !== null &&
    state.y !== null &&
    isVisibleOnSomeDisplay({ x: state.x, y: state.y, width, height }, displays)
  ) {
    return { width, height, x: Math.round(state.x), y: Math.round(state.y) };
  }
  return { width, height };
}

module.exports = {
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  MIN_WIDTH,
  MIN_HEIGHT,
  VISIBLE_MARGIN_X,
  VISIBLE_MARGIN_Y,
  windowStatePath,
  loadWindowState,
  saveWindowState,
  canPositionWindows,
  isVisibleOnSomeDisplay,
  resolveWindowBounds,
};
