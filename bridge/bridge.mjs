/**
 * ego-liveview bridge — runs INSIDE the `ego-browser nodejs` host.
 *
 * Responsibilities:
 *   1. FIND the task space DSH is working in (auto-follow), without the user
 *      configuring a name;
 *   2. own `Page.startScreencast` + the per-frame ack loop — the CDP session
 *      does NOT survive the call that started it, so the pump must live here;
 *   3. serve frames over a Windows named pipe as [1B type][4B LE length][payload],
 *      type 1 = JPEG frame, type 2 = JSON metadata.
 *
 * Two hard-won rules are baked in:
 *   - NEVER call `Page.captureScreenshot` on a page we screencast. A timed-out
 *     screenshot (which always happens while the ego window is minimized)
 *     permanently stops that target from producing screencast frames.
 *   - A static page produces no frames. Chromium's screencast only emits when
 *     the compositor changes something, so silence is not proof of failure.
 *
 * The pump deliberately outlives this module's top-level by chaining
 * `setTimeout`: the ego host keeps pending work alive after the script returns.
 * The DSH side therefore starts it once and then only reads the pipe.
 */
import net from 'node:net';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

/**
 * Configuration. `ego-browser nodejs` runs inside a long-lived host that does
 * NOT inherit our environment variables (verified: a marker env var reads back
 * as null), so the DSH-side host passes a bootstrap module that assigns
 * `globalThis.__EGO_LIVE_CONFIG` before importing this file. A JSON file is
 * accepted as a fallback for manual testing.
 */
function readConfig() {
  const injected = globalThis.__EGO_LIVE_CONFIG;
  if (injected && typeof injected === 'object') return injected;
  const fromEnv = process.env.EGO_LIVE_CONFIG_FILE;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    try {
      return JSON.parse(fs.readFileSync(fromEnv, 'utf8'));
    } catch (err) {
      // `trace` reads CONF, which is still in its temporal dead zone here.
      try { process.stderr.write(`[ego-liveview] config file unreadable: ${err?.message ?? err}\n`); } catch {}
    }
  }
  return {};
}

const CONF = readConfig();
const PIPE = CONF.pipe;
const PIN_SPACE = CONF.space ?? null;        // name or numeric id; null = auto-follow
const QUALITY = Number(CONF.quality ?? 60);
const MAXW = Number(CONF.maxWidth ?? 960);
const MAXH = Number(CONF.maxHeight ?? 600);
const EVERY_NTH = Number(CONF.everyNthFrame ?? 1);
const IDLE_REFRESH_MS = Number(CONF.idleRefreshMs ?? 2000);
const SCAN_MS = Number(CONF.scanMs ?? 10_000);
const IDLE_RETARGET_MS = Number(CONF.idleRetargetMs ?? 20_000);

if (typeof PIPE !== 'string' || PIPE.length === 0) {
  throw new Error('ego-liveview bridge: no pipe configured (set globalThis.__EGO_LIVE_CONFIG.pipe)');
}

/**
 * Diagnostics go to a file, not stderr: `ego-browser nodejs` buffers stderr
 * until the child exits (a probe showed 22 s of silence then a single flush),
 * which makes it useless for live debugging.
 */
function trace(msg) {
  const line = `[${new Date().toISOString()}] [ego-liveview] ${msg}\n`;
  try { process.stderr.write(line); } catch {}
  const dest = CONF.logFile;
  if (typeof dest === 'string' && dest.length > 0) {
    try { fs.appendFileSync(dest, line); } catch {}
  }
}

/** Frame types on the wire. Keep in sync with the host-side reader. */
const TYPE_FRAME = 1;
const TYPE_META = 2;

/** Connected DSH-side readers. */
const readers = new Set();
let seq = 0;
let lastFrame = null;   // Buffer — replayed to a reader that connects mid-stream
let metaSent = null;    // last metadata envelope, replayed to a new reader
let stats = { frames: 0, bytes: 0, startedAt: Date.now() };

/** What we are currently watching. */
let watch = {
  spaceId: null,
  spaceName: null,
  page: null,
  label: null,
  targetId: null,
  url: '',
  title: '',
  viewport: null,
  screencasting: false,
  fps: 0,
};

let candidates = [];    // [{id, name, ownership, titles}] — cheap, for the sidebar
let lastFrameAt = Date.now();
let lastScanAt = 0;
/** Raised by the pump, drained by metaLoop: the pump must never await a scan. */
let needScan = true;
let ticks = 0;

function envelope(type, payload) {
  const head = Buffer.allocUnsafe(5);
  head.writeUInt8(type, 0);
  head.writeUInt32LE(payload.length, 1);
  return [head, payload];
}

function send(sock, type, payload) {
  const [head, body] = envelope(type, payload);
  try {
    sock.write(head);
    sock.write(body);
  } catch {
    readers.delete(sock);
  }
}

/**
 * Reveal ego's hidden top-level window once so the compositor starts
 * submitting frames.
 *
 * ego.exe runs with --startup-ego-browser-service, which leaves its window at
 * IsWindowVisible=false. In that state Page.screencastFrame never fires (and
 * Page.captureScreenshot times out) even though the page itself is alive:
 * requestAnimationFrame runs, LayoutCount climbs, document.visibilityState
 * reports "visible". After one SW_SHOWMINNOACTIVE the same target streams
 * 60–78 fps, and it keeps streaming when minimized afterwards, so this only
 * has to happen once per browser launch.
 *
 * Prefers the host-provided PowerShell script; skips silently where there is
 * no PowerShell or no script configured.
 */
let wakeDone = false;
async function wakeWindows(reason) {
  if (wakeDone) return;
  wakeDone = true;
  const script = CONF.wakeScript;
  if (typeof script !== 'string' || script.length === 0) return;
  try {
    fs.accessSync(script);
  } catch {
    trace('wake: script missing, skipping');
    return;
  }
  await new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let out = '';
    child.stdout?.on('data', (d) => { out += String(d); });
    child.stderr?.on('data', (d) => trace(`wake stderr: ${String(d).slice(0, 200).trim()}`));
    child.on('error', (err) => {
      trace(`wake failed to spawn: ${err.message}`);
      resolve();
    });
    child.on('exit', (code) => {
      trace(`wake (${reason}): exit=${code} ${out.trim()}`);
      resolve();
    });
  });
}

function writeFrame(buf) {
  seq += 1;
  lastFrame = buf;
  lastFrameAt = Date.now();
  stats.frames += 1;
  stats.bytes += buf.length;
  if (readers.size === 0) return;
  for (const sock of readers) send(sock, TYPE_FRAME, buf);
}

/**
 * Metadata describes the watched page AND the spaces available to follow, so
 * the sidebar can show what is going on (and, later, offer a picker).
 */
function writeMeta() {
  const payload = Buffer.from(
    JSON.stringify({
      url: watch.url,
      title: watch.title,
      label: watch.label,
      spaceId: watch.spaceId,
      spaceName: watch.spaceName,
      viewport: watch.viewport,
      screencasting: watch.screencasting,
      fps: Math.round(watch.fps * 10) / 10,
      seq,
      spaces: candidates,
    }),
    'utf8',
  );
  metaSent = payload;
  for (const sock of readers) send(sock, TYPE_META, payload);
}

/** Page labels and space ids are the only stable handles across calls. */
async function readTab(t) {
  try {
    const tabs = (await t.tabs()) || [];
    const usable = tabs.filter((x) => {
      const url = String(x.url ?? '');
      return url.length > 0 && !url.startsWith('chrome://');
    });
    const active = usable.find((x) => x.active) ?? usable[0];
    if (!active) return null;
    return {
      url: String(active.url ?? ''),
      title: String(active.title ?? ''),
      label: active.label ?? null,
      targetId: active.targetId ?? null,
      active: Boolean(active.active),
    };
  } catch {
    return null;
  }
}

/**
 * Discover what to watch.
 *
 * Ranking, in order:
 *   1. an explicit `space` in the config wins outright;
 *   2. otherwise keep the space we already watch, while it still has a usable
 *      page — switching would make the picture jump for no reason;
 *   3. otherwise prefer a space whose tab is `active`, then the newest space id
 *      (ids are monotonic, so the highest id is the most recently created).
 */
async function scan() {
  lastScanAt = Date.now();
  let all = [];
  try {
    all = (await listTaskSpaces()) || [];
  } catch (err) {
    trace(`listTaskSpaces failed: ${err?.message ?? err}`);
    return;
  }

  const visible = all
    .filter((s) => s && s.id !== undefined)
    .filter((s) => PIN_SPACE === null || String(s.id) === String(PIN_SPACE) || String(s.name) === String(PIN_SPACE))
    .sort((a, b) => b.id - a.id);

  // Metadata for the sidebar: cheap fields only, no CDP round trips.
  candidates = visible.map((s) => ({
    id: s.id,
    name: String(s.name ?? ''),
    ownership: String(s.ownership ?? ''),
    titles: Array.isArray(s.recentTabTitles) ? s.recentTabTitles.slice(0, 3) : [],
  }));

  if (visible.length === 0) return;

  // Ask the space we already watch first, then the newest ones. A scan runs
  // every SCAN_MS, and `tabs()` is a CDP round trip we do not want to pay for
  // every historical space on every tick.
  const order = [];
  if (watch.spaceId !== null) {
    const current = visible.find((s) => s.id === watch.spaceId);
    if (current) order.push(current);
  }
  for (const s of visible) if (!order.includes(s)) order.push(s);

  for (const s of order) {
    let t;
    try {
      t = await taskSpace(s.id);
    } catch {
      continue;
    }
    const tab = await readTab(t);
    // `readTab` skips chrome:// and blank pages, so a space with nothing worth
    // showing falls through to the next candidate instead of blanking the view.
    if (!tab) continue;

    if (s.id === watch.spaceId && tab.label === watch.label) {
      watch.spaceName = String(s.name ?? watch.spaceName ?? '');
      watch.url = tab.url;
      watch.title = tab.title;
      return;
    }

    await retarget({ id: s.id, name: String(s.name ?? ''), ...tab });
    return;
  }

  trace('no space with a usable page');
}

/** Move the screencast to a different page: stop the old one, start the new. */
async function retarget(pick) {
  await stopScreencast();
  watch.spaceId = pick.id;
  watch.spaceName = pick.name;
  watch.label = pick.label;
  watch.targetId = pick.targetId;
  watch.url = pick.url;
  watch.title = pick.title;
  watch.page = null;
  try {
    const t = await taskSpace(pick.id);
    const pages = (await t.pages()) || [];
    const page = (pick.label ? pages.find((p) => p.label === pick.label) : null) ?? pages[0];
    if (!page) {
      trace(`no page in space ${pick.id}`);
      return;
    }
    watch.page = page;
    watch.label = page.label ?? watch.label;
    await startScreencast();
  } catch (err) {
    trace(`retarget failed: ${err?.message ?? err}`);
  }
  // A fresh target starts quiet: give the new page a full grace window before
  // the "no frames for a while" rule can ask for another rescan.
  lastFrameAt = Date.now();
  writeMeta();
}

async function startScreencast() {
  const p = watch.page;
  if (!p) return;
  await p.cdp('Page.enable', {});
  await p.cdp('Page.startScreencast', {
    format: 'jpeg',
    quality: QUALITY,
    maxWidth: MAXW,
    maxHeight: MAXH,
    everyNthFrame: EVERY_NTH,
  });
  watch.screencasting = true;
  trace(`screencast started on ${watch.spaceName ?? watch.spaceId}/${watch.label}`);
}

async function stopScreencast() {
  const p = watch.page;
  watch.screencasting = false;
  if (!p) return;
  try { await p.cdp('Page.stopScreencast', {}); } catch {}
}

/** Drain buffered CDP events, ack every frame, forward the newest one. */
let drainDebug = 0;
async function drain() {
  const p = watch.page;
  if (!p) return;
  let events;
  try {
    events = await p.events();
  } catch (err) {
    if (drainDebug < 3) {
      drainDebug += 1;
      trace(`events() threw: ${err?.message ?? err}`);
    }
    return;
  }
  const list = events || [];
  if (list.length > 0 && drainDebug < 6) {
    drainDebug += 1;
    trace(`drain got ${list.length} events: ${list.map((e) => e?.method).join(',')}`);
  }
  for (const ev of list) {
    if (ev?.method !== 'Page.screencastFrame') continue;
    const params = ev.params || {};
    const data = params.data;
    if (typeof data === 'string' && data.length > 0) {
      writeFrame(Buffer.from(data, 'base64'));
    }
    if (params.sessionId !== undefined) {
      try {
        await p.cdp('Page.screencastFrameAck', { sessionId: params.sessionId });
      } catch {}
    }
  }
}

const fpsWindow = [];
function sampleFps() {
  const now = Date.now();
  fpsWindow.push({ at: now, seq });
  while (fpsWindow.length > 2 && now - fpsWindow[0].at > 2000) fpsWindow.shift();
  if (fpsWindow.length < 2) return;
  const first = fpsWindow[0];
  const dt = now - first.at;
  if (dt > 250) watch.fps = ((seq - first.seq) * 1000) / dt;
}

/**
 * The pump. Chained timers (not setInterval) so a slow drain cannot stack.
 *
 * Scanning never happens here: `tabs()` is a CDP round trip that would stall
 * the drain loop and drop frames. The pump only raises a flag; `metaLoop`
 * (which already runs on a slow cadence) performs the scan.
 */
async function pump() {
  ticks += 1;
  try {
    if (watch.page === null) {
      needScan = true;
    } else {
      await drain();
      sampleFps();

      // A page we watch can be closed, replaced, or navigated away by its
      // owner. Silence alone is ambiguous — static pages legitimately produce
      // no frames — so only a long quiet spell asks for a rescan, and the scan
      // itself decides whether anything changed.
      if (watch.screencasting && Date.now() - lastFrameAt > IDLE_RETARGET_MS) {
        needScan = true;
      }
    }
  } catch (err) {
    trace(`pump error: ${err?.message ?? err}`);
  }

  if (ticks % 120 === 0) {
    trace(
      `tick ${ticks} frames=${stats.frames} readers=${readers.size} ` +
        `watch=${watch.spaceName ?? '-'}/${watch.label ?? '-'} fps=${Math.round(watch.fps)} ` +
        `last=${lastFrame ? lastFrame.length : 'none'}`,
    );
  }
  setTimeout(pump, 16);
}

async function metaLoop() {
  // Refresh url/title without touching the screencast.
  const p = watch.page;
  if (p) {
    try {
      const info = await p.info();
      if (info) {
        watch.url = info.url ?? watch.url;
        watch.title = info.title ?? watch.title;
        if (info.w && info.h) watch.viewport = { w: info.w, h: info.h };
      }
    } catch {}
  }

  // Rescans live here, not in the pump: `tabs()` is a CDP round trip, and the
  // drain loop must never wait on it.
  if (needScan || Date.now() - lastScanAt > SCAN_MS) {
    needScan = false;
    try {
      await scan();
    } catch (err) {
      trace(`scan failed: ${err?.message ?? err}`);
    }
  }

  writeMeta();
  // Re-send the last frame so a reader that just attached paints immediately.
  if (readers.size > 0 && lastFrame !== null) {
    for (const sock of readers) send(sock, TYPE_FRAME, lastFrame);
    lastFrameAt = Date.now();
  }
  setTimeout(metaLoop, IDLE_REFRESH_MS);
}

/** Named-pipe server: the DSH host connects as a client. */
const server = net.createServer((sock) => {
  sock.setNoDelay?.(true);
  readers.add(sock);
  trace(`reader attached (${readers.size} total)`);
  if (metaSent !== null) send(sock, TYPE_META, metaSent);
  if (lastFrame !== null) send(sock, TYPE_FRAME, lastFrame);
  const drop = () => {
    readers.delete(sock);
    trace(`reader detached (${readers.size} left)`);
  };
  sock.on('close', drop);
  sock.on('error', drop);
  sock.on('end', drop);
  // Swallow whatever the host sends; the channel is one-way.
  sock.on('data', () => {});
});

server.on('error', (err) => {
  trace(`pipe server error: ${err?.message ?? err}`);
});

server.listen(PIPE, () => {
  trace(`listening on ${PIPE} pin=${PIN_SPACE ?? 'auto'}`);
  (async () => {
    // Un-hide ego's window before the first screencast: a hidden window never
    // emits Page.screencastFrame (see wakeWindows).
    await wakeWindows('startup');
    await scan();
    if (watch.page === null) trace('no watchable page yet; scanning until one appears');
    pump();
    metaLoop();
  })();
});

// Expose a tiny status surface for debugging from another ego-browser call.
globalThis.__egoLiveViewStats = () => ({
  ...stats,
  seq,
  readers: readers.size,
  watch: {
    spaceId: watch.spaceId,
    spaceName: watch.spaceName,
    label: watch.label,
    url: watch.url,
    title: watch.title,
    screencasting: watch.screencasting,
    fps: Math.round(watch.fps * 10) / 10,
    lastFrameAgeMs: Date.now() - lastFrameAt,
  },
  candidates,
  uptimeMs: Date.now() - stats.startedAt,
});
