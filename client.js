/**
 * ego-liveview — client half.
 *
 * Registers one sidebar tab that shows the live view of the ego browser as a
 * plain `<img>`. The image is an HTTP MJPEG stream served by the host half on
 * the DSH web server, so the browser does the decoding and the frame rate is
 * whatever the host pushes (measured 55–60 fps end to end).
 *
 * Everything visible here is a host theme token; nothing is copied from the
 * host's own components. The tab unmounts its `<img>` when it is not visible,
 * which closes the MJPEG connection and stops the host from encoding frames
 * for a pane nobody is looking at.
 */
window.__ModuleLoader__.load({
  id: '@local/ego-liveview',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const STREAM_URL = '/ego-live/stream.mjpg';
    const FRAME_URL = '/ego-live/frame.jpg';
    const STATUS_URL = '/ego-live/status';
    const STATUS_POLL_MS = 1500;
    const POLL_MS = 120;
    /** Consecutive unhealthy status polls before the <img> is remounted. */
    const STALL_TICKS = 4;

    /** Read the active locale so text follows the host's language. */
    function pick(ctx, zh, en) {
      try {
        const locale = ctx.get('locale');
        const active = locale ? String(locale.getLocale().active || '') : '';
        return active.toLowerCase().startsWith('zh') ? zh : en;
      } catch {
        return en;
      }
    }

    /** Re-render when the host switches language (uSES over the locale face). */
    function useLocaleRevision(ctx) {
      const locale = ctx.get('locale');
      const subscribe = React.useCallback(
        (onChange) => (locale && typeof locale.subscribe === 'function' ? locale.subscribe(onChange) : () => {}),
        [locale],
      );
      const snapshot = React.useCallback(() => {
        try {
          return locale ? locale.getLocale().revision : 0;
        } catch {
          return 0;
        }
      }, [locale]);
      return React.useSyncExternalStore(subscribe, snapshot, () => 0);
    }

    const S = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
      },
      stage: {
        position: 'relative',
        flex: '1 1 auto',
        minHeight: 0,
        overflow: 'hidden',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      frame: {
        position: 'absolute',
        inset: '0',
        width: '100%',
        height: '100%',
        objectFit: 'contain',
        display: 'block',
      },
      center: {
        position: 'absolute',
        inset: '0',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '8px',
        padding: '16px',
        textAlign: 'center',
        fontSize: '12px',
        color: 'var(--dsw-alias-label-secondary)',
      },
      bar: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        flex: '0 0 auto',
        padding: '4px 8px',
        borderTop: '1px solid var(--dsw-alias-border-l1)',
        fontSize: '11px',
        lineHeight: '16px',
        color: 'var(--dsw-alias-label-secondary)',
      },
      label: {
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      meta: {
        flex: '0 0 auto',
        fontVariantNumeric: 'tabular-nums',
        color: 'var(--dsw-alias-label-secondary)',
      },
      dot: (on) => ({
        flex: '0 0 auto',
        width: '6px',
        height: '6px',
        borderRadius: '50%',
        background: on ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-idle-primary)',
      }),
      button: {
        flex: '0 0 auto',
        appearance: 'none',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: '4px',
        padding: '1px 6px',
        font: 'inherit',
        cursor: 'pointer',
      },
    };

    /** Rendered when the img element cannot keep a connection alive. */
    function ErrorBoundary(props) {
      const [error, setError] = React.useState(null);
      React.useEffect(() => {
        // Clear the boundary when the child identity changes (a retry).
        setError(null);
      }, [props.resetKey]);
      if (error) {
        return h(
          'div',
          { style: S.center },
          h('div', null, props.label),
          h(
            'button',
            {
              type: 'button',
              style: S.button,
              onClick: () => {
                setError(null);
                props.onRetry();
              },
            },
            props.retryLabel,
          ),
        );
      }
      return h(ErrorBoundaryInner, { onError: setError }, props.children);
    }

    class ErrorBoundaryInner extends React.Component {
      constructor(innerProps) {
        super(innerProps);
        this.state = { failed: false };
      }
      static getDerivedStateFromError() {
        return { failed: true };
      }
      componentDidCatch(err) {
        this.props.onError(err);
      }
      render() {
        if (this.state.failed) return null;
        return this.props.children;
      }
    }

    function LiveView(props) {
      const ctx = props.ctx;
      const visible = props.visible !== false;
      const localeRev = useLocaleRevision(ctx);
      const [nonce, setNonce] = React.useState(0);
      const [mode, setMode] = React.useState('mjpeg');
      const [status, setStatus] = React.useState(null);
      const imageRef = React.useRef(null);
      const t = React.useCallback((zh, en) => pick(ctx, zh, en), [ctx, localeRev]);

      const retry = React.useCallback(() => {
        setMode('mjpeg');
        setNonce((n) => n + 1);
      }, []);

      // Ask the host once per interval what it is showing; cheap JSON, and the
      // only way the user learns which page the stream belongs to.
      React.useEffect(() => {
        if (!visible) return undefined;
        let alive = true;
        let deadTicks = 0;
        const tick = async () => {
          try {
            const res = await fetch(`${STATUS_URL}?n=${Date.now()}`, { cache: 'no-store' });
            if (!res.ok) throw new Error(String(res.status));
            const body = await res.json();
            if (!alive) return;
            setStatus(body);
            // The host restarts a dead bridge on its own, but the <img> is
            // already bound to one long-lived response that may have been torn
            // down with it. Remount the image after a sustained outage so a
            // wedged stream recovers without the user clicking anything.
            deadTicks = body && body.ok ? 0 : deadTicks + 1;
            if (deadTicks >= STALL_TICKS) {
              deadTicks = 0;
              setNonce((n) => n + 1);
            }
          } catch {
            if (!alive) return;
            setStatus(null);
            deadTicks += 1;
            if (deadTicks >= STALL_TICKS) {
              deadTicks = 0;
              setNonce((n) => n + 1);
            }
          }
        };
        void tick();
        const id = setInterval(tick, STATUS_POLL_MS);
        return () => {
          alive = false;
          clearInterval(id);
        };
      }, [visible]);

      // Fallback transport: some engines refuse MJPEG in <img>. Poll single
      // frames instead, driven by a ref so React does not re-render per frame.
      React.useEffect(() => {
        if (!visible || mode !== 'poll') return undefined;
        let alive = true;
        const tick = () => {
          const el = imageRef.current;
          if (!el || !alive) return;
          el.src = `${FRAME_URL}?n=${Date.now()}`;
        };
        tick();
        const id = setInterval(tick, POLL_MS);
        return () => {
          alive = false;
          clearInterval(id);
        };
      }, [visible, mode]);

      if (!visible) {
        // Not the active tab, or the panel is closed: stop pulling frames.
        return h('div', { style: S.root });
      }

      const url = status && status.ok !== false && typeof status === 'object' ? status : null;
      const live = Boolean(url && url.ok);
      const bytes = url && typeof url.lastFrameBytes === 'number' ? url.lastFrameBytes : 0;
      const watched = (url && url.watched) || {};
      const fps = typeof watched.fps === 'number' ? Math.round(watched.fps) : 0;
      // What the stream belongs to: the page title is the useful part, the URL
      // is the fallback when a page has no title yet.
      const subject = String(watched.title || watched.url || '');
      const spaceName = watched.space ? String(watched.space) : '';
      // A reachable host with no page to watch is not a broken connection: ego
      // may simply have restarted and dropped every task space. Say so instead
      // of showing an empty black stage that looks like a hang.
      const idle = live && !subject;
      const known = url && Array.isArray(url.spaces) ? url.spaces.length : 0;

      return h(
        'div',
        { style: S.root },
        h(
          'div',
          { style: S.stage },
          h(ErrorBoundary, {
            label: t('实时画面连接中断', 'The live view connection was lost.'),
            retryLabel: t('重新连接', 'Reconnect'),
            onRetry: retry,
            resetKey: nonce,
          }, mode === 'mjpeg'
            ? h('img', {
                alt: t('ego 浏览器实时画面', 'Live view of the ego browser'),
                src: `${STREAM_URL}?n=${nonce}`,
                style: S.frame,
                draggable: false,
                onError: () => {
                  // One failed MJPEG attempt is enough: switch transports.
                  setMode('poll');
                },
              })
            : h('img', {
                alt: t('ego 浏览器实时画面', 'Live view of the ego browser'),
                ref: imageRef,
                style: S.frame,
                draggable: false,
                onError: () => setStatus(null),
              })),
          idle
            ? h(
                'div',
                { style: S.center },
                h(
                  'div',
                  null,
                  t(
                    known > 0 ? 'ego 里有页面，但还没有可显示的内容。' : 'ego 里还没有打开的网页。',
                    known > 0 ? 'ego has a page, but nothing to show yet.' : 'No page is open in ego yet.',
                  ),
                ),
                h(
                  'div',
                  null,
                  t(
                    '让 dsh 用 ego 打开一个网页，这里会自动显示。',
                    'Ask dsh to open a page in ego and it will appear here.',
                  ),
                ),
              )
            : null,
        ),
        h(
          'div',
          { style: S.bar },
          h('span', { style: S.dot(live), 'aria-hidden': true }),
          h(
            'span',
            {
              style: S.label,
              title: [subject, spaceName].filter(Boolean).join(' — '),
            },
            live
              ? subject || t('ego 浏览器', 'ego browser')
              : t('正在连接 ego 浏览器…', 'Connecting to the ego browser…'),
          ),
          h('span', { style: { flex: '1 1 auto' } }),
          live
            ? h(
                'span',
                { style: S.meta, title: t('帧率和单帧大小', 'Frame rate and frame size') },
                `${fps > 0 ? `${fps} fps · ` : ''}${Math.round(bytes / 1024)} KB`,
              )
            : null,
          h(
            'button',
            {
              type: 'button',
              style: S.button,
              title: t('丢弃当前连接并重新取一帧', 'Drop the current connection and reattach'),
              onClick: retry,
            },
            t('重连', 'Reconnect'),
          ),
        ),
      );
    }

    return {
      apply(ctx) {
        // The sidebar service may be published after this module runs, so wait
        // for it instead of failing at load: `ctx.inject` re-runs the callback
        // whenever the dependency appears (or reappears after HMR).
        ctx.inject(['betterSidebar'], (scoped) => {
          const sidebar = scoped.betterSidebar || scoped.get('betterSidebar');
          if (!sidebar || typeof sidebar.registerTab !== 'function') return;

          const handle = sidebar.registerTab({
            id: 'ego-liveview',
            title: () => pick(scoped, 'ego 浏览器', 'ego browser'),
            description: () =>
              pick(scoped, '显示 ego 浏览器当前画面的实时视图。', 'Live view of what the ego browser is showing.'),
            order: 55,
            single: true,
            component: LiveView,
            icon: (size) =>
              h(
                'svg',
                {
                  width: size,
                  height: size,
                  viewBox: '0 0 16 16',
                  fill: 'none',
                  'aria-hidden': true,
                  style: { display: 'block' },
                },
                h('rect', {
                  x: '1.5',
                  y: '2.5',
                  width: '13',
                  height: '9',
                  rx: '1.5',
                  stroke: 'currentColor',
                  strokeWidth: '1.2',
                }),
                h('path', { d: 'M5.5 14h5', stroke: 'currentColor', strokeWidth: '1.2', strokeLinecap: 'round' }),
                h('circle', { cx: '8', cy: '7', r: '1.8', fill: 'currentColor' }),
              ),
          });

          scoped.effect(() => () => {
            try {
              handle();
            } catch {}
          });
        });
      },
    };
  },
});
