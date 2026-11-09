/*
 * The host Studio asks for (studio/ui/src/lib/host.ts, StudioHost version 1), for Studio served to a browser: the
 * desktop app gives Studio its chat panel and a place for the project's media; a browser has neither. This one gives
 * both, drawn in Studio's page: a panel on the left under the top bar, where the media pool opens above its composer.
 * Loaded before Studio's own script (index.html), and only where no app gave Studio a host already.
 * deploy/agent-web/CONCEPTION.md says where the agent itself comes in.
 */
(function () {
  if (globalThis.openfilmHost) return;
  var KEY = 'openfilm.webHost.panel';
  var saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { saved = {}; }
  var COMPOSER = 132;
  var state = {
    open: saved.open !== false,
    width: saved.width || 380,
    assets: { open: saved.assetsOpen !== false, bottom: COMPOSER },
  };
  var listeners = [];
  var el = null;
  var keep = function () {
    try { localStorage.setItem(KEY, JSON.stringify({ open: state.open, width: state.width, assetsOpen: state.assets.open })); } catch (e) { /* private window */ }
  };
  var tell = function () {
    keep();
    draw();
    var shown = { open: state.open, width: state.open ? state.width : 0, preferredWidth: state.width, assets: { open: state.assets.open, bottom: COMPOSER } };
    listeners.forEach(function (l) { try { l(shown); } catch (e) { /* a listener's own failure */ } });
  };
  var bounds = null;
  function draw() {
    if (!document.body) return;
    if (!el) {
      el = document.createElement('aside');
      el.setAttribute('data-studio-host-panel', '');
      el.setAttribute('aria-label', 'Agent');
      el.style.cssText = 'position:fixed;z-index:30;display:flex;flex-direction:column;justify-content:flex-end;box-sizing:border-box;'
        + 'background:var(--bg,#151515);color:var(--text,#e8e8e8);border-right:1px solid var(--border,#2a2a2a);font:13px/1.45 system-ui,sans-serif';
      el.innerHTML = '<div data-composer style="box-sizing:border-box;height:' + COMPOSER + 'px;padding:12px;border-top:1px solid var(--border,#2a2a2a)">'
        + '<div style="font-weight:600;margin-bottom:6px">Agent du DGX</div>'
        + '<textarea disabled rows="3" placeholder="La conversation avec l\'agent arrive à l\'étape suivante." '
        + 'style="width:100%;box-sizing:border-box;resize:none;border-radius:8px;border:1px solid var(--border,#333);background:transparent;color:inherit;padding:8px;font:inherit"></textarea></div>';
      document.body.appendChild(el);
    }
    var top = 40;
    var b = bounds || { left: 0, top: top, width: state.width, height: window.innerHeight - top };
    el.style.display = state.open ? 'flex' : 'none';
    el.style.left = b.left + 'px';
    el.style.top = b.top + 'px';
    el.style.width = b.width + 'px';
    el.style.height = b.height + 'px';
  }
  window.addEventListener('resize', draw);
  document.addEventListener('DOMContentLoaded', draw);
  globalThis.openfilmHost = {
    version: 1,
    name: 'OpenFilm (navigateur)',
    panel: {
      label: 'Agent',
      get open() { return state.open; },
      get width() { return state.open ? state.width : 0; },
      get preferredWidth() { return state.width; },
      get assets() { return { open: state.assets.open, bottom: COMPOSER }; },
      setOpen: function (open) { if (state.open === Boolean(open)) return; state.open = Boolean(open); tell(); },
      setAssetsOpen: function (open) { if (state.assets.open === Boolean(open)) return; state.assets.open = Boolean(open); tell(); },
      setWidth: function (width) { var w = Math.max(280, Math.min(720, Math.round(Number(width) || 380))); if (w === state.width) return; state.width = w; tell(); },
      setBounds: function (next) { bounds = next; draw(); },
      setPlacement: function () { /* the panel stays on the left, its media docked in it */ },
      onChange: function (listener) {
        listeners.push(listener);
        return function () { listeners = listeners.filter(function (l) { return l !== listener; }); };
      },
    },
  };
})();
