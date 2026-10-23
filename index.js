/**
 * ego-liveview — host half.
 *
 * Streams the ego browser's rendering surface into the DSH sidebar.
 *
 * Architecture (validated by measurement, see liveview-feasibility.md):
 *
 *   ego browser compositor
 *     → Page.startScreencast inside the `ego-browser nodejs` host
 *       → named pipe, frames framed as [1B type][4B LE length][payload]
 *         → this plugin (named-pipe client)
 *           → HTTP multipart/x-mixed-replace on the DSH web server
 *             → <img src="…/stream.mjpg"> in a sidebar tab
 *
 * Why a named pipe and not a TCP port: the pump lives inside the ego
 * NodeService host, where a listening socket cannot be closed again (module
 * scope ends, no handle survives), so a TCP port would leak for the lifetime
 * of the browser. A pipe server has the same lifetime problem, but the name is
 * disposable, so each launch simply takes a fresh name.
 *
 * Why screencast and not screenshots: `Page.captureScreenshot` throws
 * "Cannot capture a screenshot while the window is minimized" and additionally
 * kills an in-flight screencast on the same target. Screencast keeps producing
 * frames while minimized (measured 38–54 fps across 5 fresh spaces, and 59 fps
 * while another call was driving the same page).
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const name = 'ego-liveview';
export const inject = ['webServer'];

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Where the generated runtime scripts live. Must be an ASCII path: the ego
 * `-e` entry point mangles non-ASCII characters, and the workspace path can
 * contain them (`…/插件/…`). */
const RUNTIME_DIR = path.join(os.tmpdir(), 'ego-liveview-runtime');

const FRAME_ROUTE = '/ego-live/frame.jpg';
const STREAM_ROUTE = '/ego-live/stream.mjpg';
const STATUS_ROUTE = '/ego-live/status';

/** Wire protocol shared with bridge/bridge.mjs. */
const TYPE_FRAME = 1;
const TYPE_META = 2;
const HEADER_BYTES = 5;
const MAX_PAYLOAD = 8 * 1024 * 1024;

/** How long a single MJPEG part may sit unflushed before the viewer is unmuted. */
const WRITE_STALL_MS = 1_000;

/**
 * How long after the last polled frame the viewer still counts as present.
 *
 * The client polls /frame.jpg every 120 ms, so anything above that keeps it
 * continuously "present"; the extra margin covers a slow request or a briefly
 * backgrounded tab. It also bounds how long ego stays up after a tab closes.
 */
const DEMAND_GRACE_MS = 10_000;

/**
 * Minimum gap between bridge launch attempts.
 *
 * A polling client asks for a frame every ~120 ms, so without this a failing
 * launch (ego missing, ego crashing on start) would be retried thousands of
 * times a minute. One second is invisible to a user and harmless to ego.
 */
const RETRY_FLOOR_MS = 1_000;

const DEFAULTS = {
  quality: 60,
  maxWidth: 960,
  maxHeight: 600,
  /** Name or numeric id of the ego task space to watch. Empty = auto-follow. */
  space: '',
  /** Restart the bridge if no metadata heartbeat arrives for this long. */
  idleTimeoutMs: 20_000,
  /** How often the watchdog re-checks the bridge. 0 disables it. */
  healthCheckMs: 5_000,
  /**
   * Reveal hidden ego windows so the compositor starts submitting frames.
   *
   * Only relevant on ego builds that launch their service instance with a
   * hidden window (0.6.0.16 did; 0.6.0.20 starts visible and the script finds
   * nothing to show). Off by default: touching another app's window visibility
   * is not something a sidebar viewer should do uninvited.
   */
  showWindow: false,
  egoBinary: 'ego-browser',
};

/** Radix-36 suffix so a fresh pipe name never collides with a stale pump. */
const stamp = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

export function apply(ctx, config) {
  const conf = { ...DEFAULTS, ...(config || {}) };
  ctx.logger?.info?.('ego-liveview: host half ready');

  /** Latest frame, kept so a newly attached viewer paints immediately. */
  let lastFrame = null;
  let frameSeq = 0;
  let lastFrameAt = 0;
  /** Metadata from the bridge: what it is watching, and which spaces exist. */
  let meta = { url: '', title: '', label: null, spaceId: null, spaceName: null, viewport: null, fps: 0, spaces: [] };
  /** Last time the bridge proved it was alive. The meta loop ticks every 2 s
   * whether or not the page is producing frames, so this — not `lastFrameAt` —
   * is the heartbeat. */
  let lastMetaAt = 0;
  const viewers = new Set();
  /**
   * Last time any route was asked for a frame.
   *
   * MJPEG viewers are tracked directly, but the image endpoint is stateless
   * polling: the client re-requests /frame.jpg every 120 ms without ever
   * becoming a viewer. Without this, the watchdog would tear the bridge down
   * mid-poll and the two would fight each other forever.
   */
  let lastDemandAt = 0;
  /** When startBridge() was last attempted, to keep retries off a hot loop. */
  let lastAttemptAt = 0;

  /** One bridge instance: the child process plus its pipe client. */
  const bridge = {
    child: null,
    socket: null,
    pipe: null,
    starting: null,
    startedAt: 0,
    framesSeen: 0,
    errors: [],
  };

  const note = (msg) => {
    if (bridge.errors.length < 20) bridge.errors.push(`${new Date().toISOString()} ${msg}`);
    ctx.logger?.debug?.(`ego-liveview: ${msg}`);
  };

  /**
   * Write the ego-side scripts into the ASCII runtime directory.
   *
   * The bridge source is copied verbatim; only the configuration differs per
   * launch, so it is embedded as a leading assignment in the bootstrap.
   */
  function prepareRuntime(pipe, space) {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    const src = path.join(HERE, 'bridge', 'bridge.mjs');
    const bundled = fs.readFileSync(src, 'utf8');
    const runtimeBridge = path.join(RUNTIME_DIR, 'bridge.mjs');
    fs.writeFileSync(runtimeBridge, bundled, 'utf8');

    const wakeSrc = path.join(HERE, 'bridge', 'wake-windows.ps1');
    const runtimeWake = path.join(RUNTIME_DIR, 'wake-windows.ps1');
    if (fs.existsSync(wakeSrc)) fs.copyFileSync(wakeSrc, runtimeWake);

    const cfg = {
      pipe,
      // null lets the bridge pick the space DSH is working in; a name or id
      // pins it instead.
      space: space || null,
      quality: conf.quality,
      maxWidth: conf.maxWidth,
      maxHeight: conf.maxHeight,
      everyNthFrame: 1,
      idleRefreshMs: 2000,
      // ego's host inherits no environment and buffers stderr until the child
      // exits, so the bridge can only report through a file it opens itself.
      logFile: path.join(RUNTIME_DIR, 'bridge.log'),
      // Omitted entirely unless asked for: the bridge skips the wake entirely
      // when the key is absent, so ego's window is never touched by default.
      wakeScript: conf.showWindow ? runtimeWake : null,
    };
    const boot = `globalThis.__EGO_LIVE_CONFIG = ${JSON.stringify(cfg)};
await import(${JSON.stringify('file:///' + runtimeBridge.replace(/\\/g, '/'))});
`;
    const runtimeBoot = path.join(RUNTIME_DIR, 'boot.mjs');
    fs.writeFileSync(runtimeBoot, boot, 'utf8');
    return runtimeBoot;
  }

  /** Read [1B type][4B LE length][payload] envelopes off the pipe. */
  function attachPipe(socket) {
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      while (buf.length >= HEADER_BYTES) {
        const type = buf.readUInt8(0);
        const len = buf.readUInt32LE(1);
        // Guard against a desynchronised stream rather than allocating wildly.
        if (len === 0 || len > MAX_PAYLOAD) {
          note(`bad payload length ${len} (type ${type}); dropping pipe`);
          socket.destroy();
          return;
        }
        if (buf.length < HEADER_BYTES + len) break;
        const payload = buf.subarray(HEADER_BYTES, HEADER_BYTES + len);
        buf = buf.subarray(HEADER_BYTES + len);

        if (type === TYPE_META) {
          try {
            const next = JSON.parse(payload.toString('utf8'));
            meta = { ...meta, ...next };
            lastMetaAt = Date.now();
          } catch (err) {
            note(`bad metadata: ${err.message}`);
          }
          continue;
        }
        if (type !== TYPE_FRAME) {
          // Unknown type: the framing still advances, so just skip it.
          continue;
        }
        lastFrame = payload;
        lastFrameAt = Date.now();
        frameSeq += 1;
        bridge.framesSeen += 1;
        for (const res of viewers) {
          if (res.__egoBusy) {
            // A viewer that cannot keep up gets frames dropped, never queued:
            // MJPEG is a live view, stale frames are worthless.
            res.__egoPending = payload;
            continue;
          }
          writePart(res, payload);
        }
      }
    });
    socket.on('error', (err) => note(`pipe client error: ${err.message}`));
    socket.on('close', () => {
      if (bridge.socket === socket) bridge.socket = null;
    });
  }

  function writePart(res, jpeg) {
    res.__egoBusy = true;
    res.__egoPending = null;
    const head = Buffer.from(
      `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`,
      'ascii',
    );
    // If a client stops draining for good, the write callback never fires and
    // __egoBusy stays true, muting that viewer forever. Release the flag on a
    // timer as well so a stalled consumer self-heals on the next frame.
    const release = () => {
      if (!res.__egoBusy) return;
      res.__egoBusy = false;
      const pending = res.__egoPending;
      if (pending) writePart(res, pending);
    };
    const timer = setTimeout(release, WRITE_STALL_MS);
    timer.unref?.();
    res.write(Buffer.concat([head, jpeg, Buffer.from('\r\n', 'ascii')]), () => {
      clearTimeout(timer);
      release();
    });
  }

  /** Start ego + the pipe pump. Idempotent; concurrent callers share one run. */
  function startBridge() {
    if (bridge.starting) return bridge.starting;
    const pipe = `\\\\.\\pipe\\ego-liveview-${stamp()}`;
    bridge.pipe = pipe;
    bridge.startedAt = Date.now();
    bridge.framesSeen = 0;

    bridge.starting = (async () => {
      const bootPath = prepareRuntime(pipe, conf.space);
      const evalArg = `await import(${JSON.stringify('file:///' + bootPath.replace(/\\/g, '/'))})`;

      note(`launching ${conf.egoBinary} (pipe ${pipe}, space ${conf.space || 'auto'})`);
      const child = spawn(conf.egoBinary, ['nodejs', '-e', evalArg], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      bridge.child = child;

      // A spawn that fails outright (binary missing, no permission) emits
      // 'error' and never creates the pipe. Waiting out the connect deadline
      // would just stall the watchdog's next retry behind a pointless 20 s
      // poll, so fail fast instead.
      let spawnFailed = null;
      child.on('error', (err) => {
        spawnFailed = err;
        note(`failed to spawn ${conf.egoBinary}: ${err.message}`);
      });
      // The CLI's own stdout is closed by the host once the module returns;
      // stderr is buffered until exit. Neither is a reliable log channel.
      child.stdout?.on('data', () => {});
      child.stderr?.on('data', (d) => note(`ego stderr: ${String(d).slice(0, 400).trim()}`));
      child.on('exit', (code) => note(`ego cli exited (${code}); pump may still run in-host`));

      // Retry connecting: the pipe exists only after the host has loaded the
      // module and called listen(), which takes a few hundred ms.
      const deadline = Date.now() + 20_000;
      let socket = null;
      while (Date.now() < deadline) {
        if (spawnFailed) break;
        socket = await new Promise((resolve) => {
          const s = net.connect(pipe);
          const fail = () => {
            s.destroy();
            resolve(null);
          };
          s.once('connect', () => {
            s.removeListener('error', fail);
            resolve(s);
          });
          s.once('error', fail);
        });
        if (socket) break;
        await new Promise((r) => setTimeout(r, 150));
      }
      if (!socket) {
        note(spawnFailed ? `giving up: ${conf.egoBinary} did not start` : 'pipe never became connectable');
        return false;
      }
      bridge.socket = socket;
      attachPipe(socket);
      note('pipe connected');
      return true;
    })().finally(() => {
      bridge.starting = null;
    });

    return bridge.starting;
  }

  /**
   * Ensure a live bridge exists.
   *
   * The test is the metadata heartbeat, never frame arrival: a static page
   * legitimately produces no screencast frames at all (Chromium only emits on
   * compositor changes), so gating on frames would restart the bridge forever
   * on any quiet site. The bridge writes metadata every ~2 s regardless.
   */
  async function ensureBridge() {
    if (bridge.socket && Date.now() - lastMetaAt < conf.idleTimeoutMs) return true;
    // A polling client re-requests ~8×/s, and the watchdog fires too. Without a
    // floor between attempts, a failing launch would be retried in a hot loop;
    // with it, retries stay at a human pace while a healthy start never waits.
    if (Date.now() - lastAttemptAt < RETRY_FLOOR_MS) return false;
    if (bridge.socket) {
      note(`bridge heartbeat stale (${Math.round((Date.now() - lastMetaAt) / 1000)}s); restarting`);
      const old = bridge.socket;
      bridge.socket = null;
      old.destroy();
    }
    // A fresh launch gets a full grace period: lastMetaAt is otherwise still
    // 0 (or long stale) and the watchdog would restart the bridge it just
    // started, forever, before the first metadata tick ever arrives.
    lastMetaAt = Date.now();
    lastAttemptAt = Date.now();
    return startBridge();
  }

  /**
   * Drop our connection to the bridge, and stop the CLI we started.
   *
   * The ego process itself is deliberately left alone: it may be a browser the
   * user is using for their own work, and a sidebar viewer has no business
   * killing it. Only the pipe and the child we spawned are ours to close.
   */
  function shutdownBridge(reason) {
    if (!bridge.socket && !bridge.child) return;
    note(`releasing bridge (${reason})`);
    try {
      bridge.socket?.destroy();
    } catch {}
    try {
      bridge.child?.kill();
    } catch {}
    bridge.socket = null;
    bridge.child = null;
    bridge.pipe = null;
    bridge.startedAt = 0;
    // Frames belong to the bridge that produced them; keeping them would show a
    // stale picture as if it were live.
    lastFrame = null;
    frameSeq = 0;
    lastFrameAt = 0;
    lastMetaAt = 0;
    meta = { ...meta, url: '', title: '', label: null, spaceId: null, spaceName: null, viewport: null, fps: 0, spaces: [] };
  }

  /**
   * Is anyone watching right now?
   *
   * True while an MJPEG response is open, or for a short grace period after the
   * last polled frame — long enough that a polling client never looks absent
   * between requests, short enough that a closed tab stops keeping ego alive.
   */
  function demandActive() {
    if (viewers.size > 0) return true;
    return lastDemandAt > 0 && Date.now() - lastDemandAt < DEMAND_GRACE_MS;
  }

  /** Only loopback callers; the stream exposes whatever the browser shows. */
  function isLoopback(req) {
    const host = String(req.headers.host || '');
    const hostname = host.split(':')[0].replace(/^\[|\]$/g, '').toLowerCase();
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  }

  function guard(req, res) {
    if (!isLoopback(req)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('ego-liveview: loopback only');
      return false;
    }
    return true;
  }

  const disposers = [];

  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: STREAM_ROUTE,
      async handler(req, res) {
        if (!guard(req, res)) return;
        lastDemandAt = Date.now();
        res.writeHead(200, {
          'content-type': 'multipart/x-mixed-replace; boundary=frame',
          'cache-control': 'no-store, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        const viewer = res;
        viewer.__egoBusy = false;
        viewer.__egoPending = null;
        viewers.add(viewer);
        // Paint something within one frame time even on a static page.
        if (lastFrame) writePart(viewer, lastFrame);
        const drop = () => {
          if (!viewers.delete(viewer)) return;
          // Nobody left watching: release the bridge rather than keeping a pump
          // (and ego's window) alive for nobody. The next open restarts it. The
          // watchdog would also notice, but doing it here frees ego immediately.
          if (!demandActive()) shutdownBridge('last viewer left');
        };
        req.on('close', drop);
        req.on('error', drop);
        res.on('error', drop);
        res.on('close', drop);
        ensureBridge().catch((err) => note(`ensureBridge: ${err.message}`));
      },
    }),
  );

  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: FRAME_ROUTE,
      async handler(req, res) {
        if (!guard(req, res)) return;
        lastDemandAt = Date.now();
        if (!lastFrame) await ensureBridge().catch(() => {});
        if (!lastFrame) {
          res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('ego-liveview: no frame yet');
          return;
        }
        res.writeHead(200, {
          'content-type': 'image/jpeg',
          'content-length': String(lastFrame.length),
          'cache-control': 'no-store',
        });
        res.end(lastFrame);
      },
    }),
  );

  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: STATUS_ROUTE,
      async handler(req, res) {
        if (!guard(req, res)) return;
        const body = JSON.stringify({
          // `ok` only ever meant "a pipe is attached", which stayed true while
          // producing nothing (empty ego, no watchable page). `watching` is the
          // honest signal: attached AND following a real page.
          ok: Boolean(bridge.socket),
          watching: Boolean(bridge.socket && meta.spaceId !== null),
          seq: frameSeq,
          framesSeen: bridge.framesSeen,
          viewers: viewers.size,
          lastFrameAgeMs: lastFrameAt ? Date.now() - lastFrameAt : null,
          lastFrameBytes: lastFrame ? lastFrame.length : 0,
          pipe: bridge.pipe,
          uptimeMs: bridge.startedAt ? Date.now() - bridge.startedAt : 0,
          watched: {
            space: meta.spaceName ?? null,
            spaceId: meta.spaceId ?? null,
            label: meta.label ?? null,
            url: meta.url ?? '',
            title: meta.title ?? '',
            fps: meta.fps ?? 0,
            viewport: meta.viewport ?? null,
          },
          spaces: meta.spaces ?? [],
          size: `${conf.maxWidth}x${conf.maxHeight}`,
          errors: bridge.errors,
        });
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(body);
      },
    }),
  );

  // Deliberately no warm-up call here. Launching the bridge means launching
  // ego (`ego-browser` starts an `ego.exe --startup-ego-browser-service` if
  // none is running), so warming it would make DSH's own start-up spawn a
  // browser nobody asked for. Both routes below call ensureBridge() on demand.

  // MJPEG viewers hold one long-lived response and never re-request, so nothing
  // calls ensureBridge() after the initial attach. Without this watchdog a pipe
  // that dies (ego closed the connection, ego restarted, the CLI exited) leaves
  // the sidebar frozen forever — the <img> has no way to trigger a restart.
  //
  // It only ever revives a bridge while someone is actually watching. With no
  // viewers, a dead bridge is the user having closed ego, and restarting it
  // would fight them: that exact loop (spawn → user closes → spawn) is what
  // made the plugin relaunch ego forever.
  let watchdog = null;
  if (conf.healthCheckMs > 0) {
    watchdog = setInterval(() => {
      if (!demandActive()) {
        shutdownBridge('idle: nobody watching');
        return;
      }
      ensureBridge().catch((err) => note(`watchdog: ${err.message}`));
    }, conf.healthCheckMs);
    watchdog.unref?.();
  }

  ctx.effect(() => () => {
    if (watchdog) clearInterval(watchdog);
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {}
    }
    for (const res of viewers) {
      try {
        res.destroy();
      } catch {}
    }
    viewers.clear();
    // Killing the CLI does not stop the pump inside the ego host (it was
    // started by a call that already returned); a fresh pipe name per launch
    // is what keeps old pumps harmless.
    shutdownBridge('plugin unloading');
  });
}
