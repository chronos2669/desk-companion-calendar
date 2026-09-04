const { app, Tray, Menu, BrowserWindow, ipcMain, nativeImage, screen, shell } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const isDev = process.env.NODE_ENV === "development";

const CACHE_DIR = path.join(
  process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
  "desk-companion"
);
const CACHE_FILE = path.join(CACHE_DIR, "events.json");

const WINDOW_WIDTH = 360;
const WINDOW_HEIGHT = 440;
const SOON_THRESHOLD_MINUTES = 15;

let tray = null;
let popover = null;
let isQuitting = false;
let cache = { events: [], generated_at: null, error: null, stale: false };

// --------------------------------------------------------------------------
// Cache reading
// --------------------------------------------------------------------------

function readCache() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    cache = {
      events: Array.isArray(parsed.events) ? parsed.events : [],
      generated_at: parsed.generated_at ?? null,
      error: parsed.error ?? null,
      stale: parsed.stale ?? false
    };
  } catch (err) {
    if (err.code === "ENOENT") {
      cache = {
        events: [],
        generated_at: null,
        error: "No calendar data yet. Run the fetch script to get started.",
        stale: false
      };
    } else {
      cache = { events: [], generated_at: null, error: `Cache unreadable: ${err.message}`, stale: true };
    }
  }
}

function upcomingEvents() {
  const now = Date.now();
  return cache.events.filter((event) => new Date(event.end).getTime() > now);
}

function minutesUntil(isoString) {
  return (new Date(isoString).getTime() - Date.now()) / 60000;
}

// --------------------------------------------------------------------------
// Formatting helpers for the tray surface
// --------------------------------------------------------------------------

function formatClock(isoString) {
  return new Date(isoString).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function isToday(isoString) {
  const then = new Date(isoString);
  const now = new Date();
  return then.toDateString() === now.toDateString();
}

function describeEvent(event) {
  if (event.all_day) {
    return isToday(event.start) ? `All day — ${event.title}` : `${dayLabel(event.start)} — ${event.title}`;
  }
  const prefix = isToday(event.start) ? formatClock(event.start) : `${dayLabel(event.start)} ${formatClock(event.start)}`;
  return `${prefix}  ${event.title}`;
}

function dayLabel(isoString) {
  return new Date(isoString).toLocaleDateString([], { weekday: "short" });
}

// --------------------------------------------------------------------------
// Tray
// --------------------------------------------------------------------------

function trayIconPath(name) {
  // Packaging determines where the PNGs are, not NODE_ENV. electron-builder's
  // extraResources puts them under resourcesPath; unpackaged runs — dev or
  // `npm start` — read them straight out of the repo.
  const base = app.isPackaged
    ? path.join(process.resourcesPath, "build")
    : path.join(__dirname, "..", "build");

  const iconPath = path.join(base, name);

  // createFromPath fails silently on a missing file, which shows up as an
  // empty tray slot with nothing in the logs. Say so instead.
  if (!fs.existsSync(iconPath)) {
    console.error(`Tray icon missing: ${iconPath}`);
  }

  return iconPath;
}
function refreshTray() {
  if (!tray) {
    return;
  }

  const events = upcomingEvents();
  const next = events[0];

  // Icon state: amber when something starts within the threshold.
  const imminent = next && !next.all_day && minutesUntil(next.start) <= SOON_THRESHOLD_MINUTES;
  const icon = nativeImage.createFromPath(trayIconPath(imminent ? "tray-soon.png" : "tray-idle.png"));
  tray.setImage(icon);

  // Tooltip is the only place text can live on Linux.
  if (cache.error) {
    tray.setToolTip(`Desk Companion — ${cache.error}`);
  } else if (next) {
    tray.setToolTip(`Next: ${describeEvent(next)}`);
  } else {
    tray.setToolTip("Desk Companion — nothing scheduled");
  }

  tray.setContextMenu(buildMenu(events));
}

function buildMenu(events) {
  const template = [
    { label: "Show agenda", click: togglePopover },
    { type: "separator" }
  ];

  if (cache.error) {
    template.push({ label: cache.error, enabled: false });
  } else if (events.length === 0) {
    template.push({ label: "Nothing scheduled", enabled: false });
  } else {
    // The next three inline, so a glance at the menu is often enough.
    for (const event of events.slice(0, 3)) {
      template.push({ label: describeEvent(event), enabled: false });
    }
  }

  template.push(
    { type: "separator" },
    { label: "Refresh now", click: triggerRefresh },
    { label: "Open calendar in browser", click: () => shell.openExternal("https://www.icloud.com/calendar") },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  );

  return Menu.buildFromTemplate(template);
}

function triggerRefresh() {
  // Ask systemd to run the fetch unit rather than invoking Python directly.
  // One definition of how the fetch runs, one place to change it, and the
  // run gets logged to the journal like every scheduled run does.
  const child = spawn("systemctl", ["--user", "start", "desk-companion-calendar.service"], {
    stdio: "ignore",
    detached: true
  });
  child.on("error", (err) => {
    console.error("Could not trigger refresh:", err.message);
  });
  child.unref();
}

// --------------------------------------------------------------------------
// Popover window
// --------------------------------------------------------------------------

function createPopover() {
  popover = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: "#1b2027",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  if (isDev) {
    popover.loadURL("http://localhost:5173");
  } else {
    popover.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  popover.on("blur", () => {
    if (!popover.webContents.isDevToolsOpened()) {
      popover.hide();
    }
  });

  popover.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      popover.hide();
    }
  });
}

function positionPopover() {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const { bounds, workArea } = display;
  const margin = 8;

  // KDE reserves a strip for the panel, so the gap between the full screen
  // and the usable area tells us which edge it's on — no cursor needed.
  const reserved = {
    bottom: (bounds.y + bounds.height) - (workArea.y + workArea.height),
    top: workArea.y - bounds.y,
    left: workArea.x - bounds.x,
    right: (bounds.x + bounds.width) - (workArea.x + workArea.width)
  };

  // Ties go to "bottom", which is both the KDE default and the sane
  // fallback when the panel is set to auto-hide and reserves nothing.
  const [panelEdge] = Object.entries(reserved).reduce((best, entry) =>
    entry[1] > best[1] ? entry : best
  );

  // Default: bottom-right, where the system tray lives on a bottom panel.
  let x = workArea.x + workArea.width - WINDOW_WIDTH - margin;
  let y = workArea.y + workArea.height - WINDOW_HEIGHT - margin;

  if (panelEdge === "top") {
    y = workArea.y + margin;
  } else if (panelEdge === "left") {
    x = workArea.x + margin;
  }

  // Only centre on the cursor if it gave a believable reading. Under
  // Wayland it reports (0, 0) when the pointer is over the tray, which is
  // how the window ended up in the wrong corner.
  const cursorUsable = cursor.x > bounds.x && cursor.y > bounds.y;
  if (cursorUsable && (panelEdge === "top" || panelEdge === "bottom")) {
    x = Math.min(
      Math.max(cursor.x - WINDOW_WIDTH / 2, workArea.x + margin),
      workArea.x + workArea.width - WINDOW_WIDTH - margin
    );
  }

  popover.setPosition(Math.round(x), Math.round(y), false);
}

function togglePopover() {
  if (!popover) {
    return;
  }
  if (popover.isVisible()) {
    popover.hide();
    return;
  }
  readCache();
  positionPopover();
  popover.show();
  popover.focus();
  sendCacheToRenderer();
}

function sendCacheToRenderer() {
  if (popover && !popover.isDestroyed()) {
    popover.webContents.send("events:update", cache);
  }
}

// --------------------------------------------------------------------------
// Watching the cache
// --------------------------------------------------------------------------

function watchCache() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  // fs.watchFile polls stat() rather than watching an inode, which matters:
  // the Python side writes atomically via rename, so the inode changes on
  // every update and an inode-based fs.watch would silently stop firing.
  fs.watchFile(CACHE_FILE, { interval: 2000 }, () => {
    readCache();
    refreshTray();
    sendCacheToRenderer();
  });
}

// --------------------------------------------------------------------------
// Lifecycle
// --------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", togglePopover);

  app.whenReady().then(() => {
    readCache();

    tray = new Tray(nativeImage.createFromPath(trayIconPath("tray-idle.png")));
    refreshTray();

    // Attached for completeness. On KDE this won't fire while a context
    // menu is set, but it makes the app behave correctly on desktops
    // where that restriction doesn't apply.
    tray.on("click", togglePopover);

    createPopover();
    watchCache();

    // Re-evaluate every 30s so the "starting soon" icon and the relative
    // times in the menu stay accurate between fetches.
    setInterval(refreshTray, 30_000);
  });

  ipcMain.handle("events:get", () => {
    readCache();
    return cache;
  });

  ipcMain.on("events:refresh", triggerRefresh);
  ipcMain.on("window:hide", () => popover && popover.hide());

  // Closing the popover must not end the process — the tray is the app.
  app.on("window-all-closed", (event) => {
    event.preventDefault();
  });

  app.on("before-quit", () => {
    isQuitting = true;
    fs.unwatchFile(CACHE_FILE);
  });
}