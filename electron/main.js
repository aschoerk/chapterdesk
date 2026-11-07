const { app, BrowserWindow, Menu, dialog, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');

let mainWindow = null;
let serverInstance = null;
/** Pending debounced write of the window position/size. */
let windowStateTimer = null;

// ------------------------------------------------------------------
// Window position / size persistence
//
// The bounds live in a JSON file in the Electron userData dir (per user,
// survives app upgrades), so the next start reopens the window exactly where
// it was — including on a second monitor. See ./window-state.js for the
// geometry rules (an off-screen position is ignored, sizes are clamped).
// ------------------------------------------------------------------

const windowState = require('./window-state');

/**
 * Wayland compositors place windows themselves — a client cannot choose its
 * own screen position there (Electron ignores `x`/`y`). Only under X11 (or
 * XWayland) does restoring the position actually work, so on Wayland the size
 * is remembered but the position is neither read nor written, and a one-time
 * hint explains how to get positioning back.
 */
let canPosition = true;
let positionHintLogged = false;

/** Path of the persisted window state file. */
function windowStateFile() {
  return windowState.windowStatePath(app.getPath('userData'));
}

/**
 * The BrowserWindow bounds to open with: the stored size/position when it is
 * still usable, else the default size (Electron then centers the window).
 */
function initialWindowBounds(savedState) {
  return windowState.resolveWindowBounds(
    // On Wayland the saved x/y is meaningless — keep the SIZE, drop the
    // position (x/y = null makes resolveWindowBounds return size-only bounds,
    // so Electron centers the window itself).
    savedState && !canPosition ? { ...savedState, x: null, y: null } : savedState,
    screen.getPrimaryDisplay().workArea,
    screen.getAllDisplays(),
  );
}

/** Write the current window position / size (no-op when the window is gone). */
function saveWindowState(win = mainWindow) {
  if (!win || win.isDestroyed()) return;
  // While maximized / full screen the "normal" bounds are what we want to
  // restore to after un-maximizing on the next start.
  const bounds = win.isMaximized() || win.isFullScreen()
    ? win.getNormalBounds()
    : win.getBounds();
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;
  // On Wayland only the size is meaningful (see `canPosition`).
  const ok = windowState.saveWindowState(
    windowStateFile(),
    { ...bounds, maximized: win.isMaximized() },
    canPosition,
  );
  if (!ok) console.warn('Could not save the window state.');
}

/** Coalesce rapid resize/move events into one write. */
function scheduleSaveWindowState() {
  if (windowStateTimer) clearTimeout(windowStateTimer);
  windowStateTimer = setTimeout(() => {
    windowStateTimer = null;
    saveWindowState();
  }, 400);
}

/**
 * Finds a free port starting from the preferred one.
 */
function findFreePort(startPort = 3847) {
  return new Promise((resolve) => {
    const tester = net.createServer();

    tester.once('error', () => {
      // Port is taken → try next
      resolve(findFreePort(startPort + 1));
    });

    tester.once('listening', () => {
      const { port } = tester.address();
      tester.close(() => resolve(port));
    });

    tester.listen(startPort, '127.0.0.1');
  });
}

/**
 * Starts the chapterdesk-api-server on a free port.
 *
 * The server is written in TypeScript and shipped as compiled ESM in
 * chapterdesk-api-server/dist (see Dockerfile.dev, which runs `node dist/server.js`).
 * We run it in-process: createPersistence() picks the sqlite store (kept under
 * the Electron userData dir), then createApp(store) serves the REST API and,
 * if present, the built Angular SPA.
 */
async function startServer() {
  const port = await findFreePort(3847);

  // Important: set the port before the server is created so every part of the
  // process that reads process.env.PORT (store, server, SPA query param) agrees.
  process.env.PORT = String(port);

  // Electron owns where the DB lives — it must survive app upgrades,
  // so use userData (the per-user config dir), not the install dir.
  const dbFile = path.join(app.getPath('userData'), 'data', 'chapterdesk.sqlite');
  process.env.SQLITE_PATH = dbFile;
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });

  const serverDist = path.join(__dirname, '..', 'chapterdesk-api-server', 'dist', 'http', 'create-app.js');
  const factoryDist = path.join(__dirname, '..', 'chapterdesk-api-server', 'dist', 'persistence', 'factory.js');

  if (!fs.existsSync(serverDist) || !fs.existsSync(factoryDist)) {
    throw new Error(
      'chapterdesk-api-server/dist is missing or incomplete.\n' +
      'Build it first with:  cd chapterdesk-api-server && npm run build'
    );
  }

  // chapterdesk-api-server is an ES module ("type": "module") — load it with a
  // dynamic import instead of require().
  const { createPersistence } = await import(`file://${factoryDist}`);
  const { createApp } = await import(`file://${serverDist}`);

  const store = await createPersistence();
  const expressApp = createApp(store);

  const server = expressApp.listen(port, '127.0.0.1', () => {
    console.log(`✅ chapterdesk-api-server running on http://localhost:${port} (${store.kind}) (started by Electron)`);
  });

  return { port, server };
}

/**
 * Creates the main application window.
 */
async function createWindow() {
  let port;
  try {
    const started = await startServer();
    port = started.port;
    serverInstance = started.server;
  } catch (err) {
    console.error('❌ Failed to start chapterdesk-api-server:', err);
    dialog.showErrorBox(
      'ChapterDesk',
      `Could not start the local API server:\n\n${err.message}`
    );
    app.quit();
    return;
  }

  // In-app nav already has Stories / Read / … — hide the native File/Window menu
  // that otherwise sits on top of the ChapterDesk header.
  Menu.setApplicationMenu(null);

  const iconCandidates = [
    path.join(__dirname, 'icon.png'),
    path.join(__dirname, '..', 'public', 'favicon.png'),
    path.join(__dirname, 'renderer', 'browser', 'favicon.png'),
    path.join(__dirname, '..', 'public', 'favicon.svg'),
  ];
  const icon = iconCandidates.find(candidate => fs.existsSync(candidate));
  if (!icon) {
    console.warn('ChapterDesk window icon not found. Looked in:', iconCandidates);
  } else {
    console.log('ChapterDesk window icon:', icon);
  }

  // Wayland: the compositor decides the placement, so only the SIZE is
  // restored there. (Run with --ozone-platform=x11 / XWayland to restore the
  // position too.)
  canPosition = windowState.canPositionWindows(process.env, process.argv);
  if (!canPosition && !positionHintLogged) {
    positionHintLogged = true;
    console.log(
      'Wayland session detected: the window position is chosen by the compositor, ' +
        'so only the window size is restored. To restore the position as well, start ' +
        'ChapterDesk with ELECTRON_OZONE_PLATFORM_HINT=x11 (XWayland), or use a ' +
        'KWin window rule (System Settings → Window Management → Window Rules).',
    );
  }

  // Reopen where the user left the window last time (size + position on the
  // same monitor). An unusable saved position falls back to a centered window.
  const savedState = windowState.loadWindowState(windowStateFile());
  const bounds = initialWindowBounds(savedState);

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: windowState.MIN_WIDTH,
    minHeight: windowState.MIN_HEIGHT,
    show: true,
    title: 'ChapterDesk',
    autoHideMenuBar: true,
    icon: icon || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Remember position / size: coalesced on move+resize, immediate on close.
  mainWindow.on('resize', scheduleSaveWindowState);
  mainWindow.on('move', scheduleSaveWindowState);
  mainWindow.on('maximize', scheduleSaveWindowState);
  mainWindow.on('unmaximize', scheduleSaveWindowState);
  mainWindow.on('enter-full-screen', scheduleSaveWindowState);
  mainWindow.on('leave-full-screen', scheduleSaveWindowState);
  mainWindow.on('close', () => {
    if (windowStateTimer) {
      clearTimeout(windowStateTimer);
      windowStateTimer = null;
    }
    saveWindowState(mainWindow);
  });

  if (savedState?.maximized) {
    mainWindow.maximize();
  }

  const isDev = !app.isPackaged;

  if (isDev) {
    // ---------- Development ----------
    await mainWindow.loadURL(`http://localhost:4200?port=${port}`);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    // ---------- Production ----------
    // Angular is built into: electron/renderer/
    const indexPath = path.join(__dirname, 'renderer', 'browser', 'index.html');

    if (!fs.existsSync(indexPath)) {
      console.error('❌ index.html not found at:', indexPath);
      app.quit();
      return;
    }

    console.log('✅ Loading frontend from:', indexPath);

    await mainWindow.loadFile(indexPath, {
      query: { port: String(port) },
    });
  }

  // Extra safety
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

// Also force it after a short delay
  setTimeout(() => {
    if (mainWindow && !mainWindow.isVisible()) {
      console.log('Window was not visible – forcing show()');
      mainWindow.show();
      mainWindow.focus();
    }
  }, 800);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// --------------------------------------------------
// App lifecycle
// --------------------------------------------------

app.whenReady().then(createWindow);

function cleanup() {
  if (serverInstance) {
    try {
      serverInstance.close();
      console.log('chapterdesk-api-server closed');
    } catch (e) {
      console.warn('Error closing server:', e);
    }
    serverInstance = null;
  }
}

app.on('window-all-closed', () => {
  cleanup();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', cleanup);
app.on('will-quit', cleanup);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// Optional: clean shutdown
app.on('before-quit', () => {
  if (serverInstance) {
    serverInstance.close();
  }
});
