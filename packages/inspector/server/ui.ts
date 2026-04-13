/**
 * Inline UI bundle for the inspector.
 *
 * This is intentionally a single HTML+JS bundle (no build step): the plan
 * calls for a Vite+React SPA, but for MVP we ship a small vanilla JS client
 * that talks to the same API endpoints. The React SPA is tracked as deferred
 * polish — upgrading to it is a drop-in swap (same API).
 *
 * Exported strings so the HTTP server can hand them out without reading from
 * disk (and so no build step or packaged assets are required).
 */

export function renderIndexHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>code-mode inspector</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
           margin: 0; padding: 0; background: #f6f7f9; color: #222; }
    header { padding: 12px 16px; background: #1f2937; color: #fff; font-weight: 600; }
    #layout { display: grid; grid-template-columns: 240px 1fr; height: calc(100vh - 44px); }
    #sidebar { border-right: 1px solid #e2e4e8; overflow-y: auto; background: #fff; }
    #sidebar .item { padding: 10px 14px; border-bottom: 1px solid #eef0f3; cursor: pointer; }
    #sidebar .item.active { background: #eef2ff; font-weight: 600; }
    #sidebar .item .transport { font-size: 11px; color: #6b7280; }
    #main { overflow-y: auto; padding: 16px; }
    #tabs { display: flex; gap: 4px; margin-bottom: 12px; }
    .tab { padding: 6px 12px; background: #e5e7eb; border-radius: 4px; cursor: pointer; font-size: 13px; }
    .tab.active { background: #1f2937; color: #fff; }
    pre { background: #0b1220; color: #e6edf3; padding: 12px; border-radius: 4px; overflow: auto;
          font-size: 12px; line-height: 1.5; }
    .tool-card { background: #fff; border: 1px solid #e2e4e8; border-radius: 6px;
                 padding: 12px; margin-bottom: 12px; }
    .tool-card h3 { margin: 0 0 4px; font-size: 14px; }
    .tool-card .desc { color: #4b5563; font-size: 13px; margin-bottom: 8px; white-space: pre-wrap; }
    textarea { width: 100%; height: 120px; font-family: ui-monospace, Menlo, monospace;
               font-size: 12px; padding: 8px; border: 1px solid #d1d5db; border-radius: 4px; }
    button { padding: 6px 12px; background: #2563eb; color: #fff; border: 0;
             border-radius: 4px; cursor: pointer; font-size: 13px; }
    button:hover { background: #1d4ed8; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .result { margin-top: 8px; }
    .error { color: #b91c1c; }
    .ok { color: #047857; }
    .empty { color: #6b7280; padding: 40px; text-align: center; }
  </style>
</head>
<body>
  <header>code-mode inspector</header>
  <div id="layout">
    <aside id="sidebar"><div class="empty">loading…</div></aside>
    <main id="main"><div class="empty">select an MCP server on the left</div></main>
  </div>
  <script src="/app.js"></script>
</body>
</html>`;
}

export const INDEX_CLIENT_JS = `
(() => {
  const state = { servers: [], activeServer: null, activeTab: 'tools', toolsCache: {}, sdkCache: {} };
  const sidebar = document.getElementById('sidebar');
  const main = document.getElementById('main');

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === 'onClick') el.addEventListener('click', v);
      else if (k === 'class') el.className = v;
      else el.setAttribute(k, v);
    }
    for (const c of children) {
      if (c == null) continue;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  }

  async function loadServers() {
    try {
      const resp = await fetch('/api/servers').then(r => r.json());
      state.servers = resp.servers || [];
      renderSidebar();
    } catch (err) {
      sidebar.innerHTML = '';
      sidebar.appendChild(h('div', { class: 'empty error' }, 'failed: ' + err.message));
    }
  }

  function renderSidebar() {
    sidebar.innerHTML = '';
    if (!state.servers.length) {
      sidebar.appendChild(h('div', { class: 'empty' }, 'no MCP servers configured'));
      return;
    }
    for (const s of state.servers) {
      const item = h('div', {
        class: 'item' + (state.activeServer === s.name ? ' active' : ''),
        onClick: () => { state.activeServer = s.name; state.activeTab = 'tools'; renderSidebar(); renderMain(); }
      }, s.name, h('div', { class: 'transport' }, s.transport));
      sidebar.appendChild(item);
    }
  }

  async function renderMain() {
    if (!state.activeServer) {
      main.innerHTML = '';
      main.appendChild(h('div', { class: 'empty' }, 'select an MCP server on the left'));
      return;
    }
    main.innerHTML = '';
    const tabs = h('div', { id: 'tabs' },
      tabButton('tools', 'Tools'),
      tabButton('sdk', 'Generated SDK'));
    main.appendChild(tabs);
    if (state.activeTab === 'tools') await renderToolsTab();
    else if (state.activeTab === 'sdk') await renderSdkTab();
  }

  function tabButton(id, label) {
    return h('div', {
      class: 'tab' + (state.activeTab === id ? ' active' : ''),
      onClick: () => { state.activeTab = id; renderMain(); }
    }, label);
  }

  async function renderToolsTab() {
    const server = state.activeServer;
    let data = state.toolsCache[server];
    if (!data) {
      main.appendChild(h('div', { class: 'empty' }, 'loading tools…'));
      try {
        data = await fetch('/api/tools/' + encodeURIComponent(server)).then(r => r.json());
      } catch (err) {
        data = { ok: false, error: err.message };
      }
      state.toolsCache[server] = data;
      main.lastChild?.remove();
    }
    if (!data.ok) {
      main.appendChild(h('div', { class: 'error' }, 'error: ' + data.error));
      return;
    }
    if (!data.tools || !data.tools.length) {
      main.appendChild(h('div', { class: 'empty' }, 'no tools'));
      return;
    }
    for (const tool of data.tools) {
      main.appendChild(renderToolCard(server, tool));
    }
  }

  function renderToolCard(server, tool) {
    const card = h('div', { class: 'tool-card' });
    card.appendChild(h('h3', null, tool.name));
    if (tool.description) card.appendChild(h('div', { class: 'desc' }, tool.description));
    card.appendChild(h('div', null, 'Input schema:'));
    card.appendChild(h('pre', null, JSON.stringify(tool.inputSchema || {}, null, 2)));
    card.appendChild(h('div', null, 'Arguments (JSON):'));
    const ta = h('textarea', { id: 'args-' + server + '-' + tool.name }, '{}');
    card.appendChild(ta);
    const resultEl = h('div', { class: 'result' });
    const btn = h('button', {
      onClick: async () => {
        btn.disabled = true;
        resultEl.innerHTML = '';
        let args;
        try { args = JSON.parse(ta.value || '{}'); }
        catch (err) {
          resultEl.appendChild(h('div', { class: 'error' }, 'invalid JSON: ' + err.message));
          btn.disabled = false;
          return;
        }
        try {
          const r = await fetch('/api/invoke', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ server, tool: tool.name, args })
          }).then(r => r.json());
          resultEl.appendChild(h('div', { class: r.ok ? 'ok' : 'error' },
            r.ok ? 'ok' : ('error: ' + r.error)));
          if (r.ok) resultEl.appendChild(h('pre', null, JSON.stringify(r.result, null, 2)));
        } catch (err) {
          resultEl.appendChild(h('div', { class: 'error' }, 'network: ' + err.message));
        } finally {
          btn.disabled = false;
        }
      }
    }, 'Invoke');
    card.appendChild(btn);
    card.appendChild(resultEl);
    return card;
  }

  async function renderSdkTab() {
    const server = state.activeServer;
    let data = state.sdkCache[server];
    if (!data) {
      main.appendChild(h('div', { class: 'empty' }, 'loading SDK…'));
      try {
        data = await fetch('/api/generated/' + encodeURIComponent(server)).then(r => r.json());
      } catch (err) {
        data = { ok: false, error: err.message };
      }
      state.sdkCache[server] = data;
      main.lastChild?.remove();
    }
    if (!data.ok) {
      main.appendChild(h('div', { class: 'error' }, data.error || 'no SDK generated yet — run \\'code-mode reindex\\''));
      return;
    }
    main.appendChild(h('div', null, data.path));
    main.appendChild(h('pre', null, data.contents));
  }

  loadServers();
})();
`;
