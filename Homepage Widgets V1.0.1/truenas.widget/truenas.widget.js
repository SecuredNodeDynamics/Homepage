/* =====================================================
   TRUENAS STORAGE WIDGET
===================================================== */
(function () {
  const TN_CONFIG = {
    groupName: "TRUENAS - STORAGE",
    baseUrl: "https://YOUR_TUNNEL_HOSTNAME",
    fallbackUrl: "http://YOUR_LOCAL_IP",
    activeUrl: null,
    username: "",
    password: "",
    apiKey: "PASTE_YOUR_TRUENAS_API_KEY",
    apiVersion: 2,
    pollMs: 60 * 1000,
    debug: false,
  };

  let _tab = "overview";
  let _data = { system: null, pools: [], alerts: [] };
  let _host = null;
  let _rendering = false;
  let _lastUpdated = null;

  function log(...args) {
    if (TN_CONFIG.debug) console.log("[Homepage TrueNAS]", ...args);
  }

  function normText(v) { return (v || "").replace(/\s+/g, " ").trim(); }

  function escH(s = "") {
    return String(s ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function hasCredentials() {
    return !!(TN_CONFIG.apiKey && !TN_CONFIG.apiKey.includes("PASTE_YOUR"))
      || !!(TN_CONFIG.username && TN_CONFIG.password);
  }

  function openUrl() {
    return TN_CONFIG.activeUrl || TN_CONFIG.baseUrl;
  }

  function isPrivateHost(hostname = "") {
    if (!hostname || hostname === "localhost" || hostname === "127.0.0.1") return true;
    const m = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (!m) return false;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    return false;
  }

  function urlCandidates() {
    const out = [];
    const pageIsHttps = typeof window !== "undefined" && window.location.protocol === "https:";
    const pageIsLan = typeof window !== "undefined" && isPrivateHost(window.location.hostname);
    const add = (url) => {
      if (!url || out.includes(url)) return;
      if (pageIsHttps && url.startsWith("http://")) return;
      out.push(url);
    };
    add(TN_CONFIG.activeUrl);
    if (pageIsLan) {
      add(TN_CONFIG.fallbackUrl);
      add(TN_CONFIG.baseUrl);
    } else {
      add(TN_CONFIG.baseUrl);
      add(TN_CONFIG.fallbackUrl);
    }
    return out;
  }

  function wsUrlFrom(base) {
    const u = new URL(base);
    const secure = u.protocol === "https:" || !!TN_CONFIG.apiKey;
    u.protocol = secure ? "wss:" : "ws:";
    u.pathname = "/api/current";
    u.search = "";
    u.hash = "";
    return u.toString();
  }

  function fmtBytes(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return "—";
    if (n >= 1e12) return (n / 1e12).toFixed(2) + " TB";
    if (n >= 1e9) return (n / 1e9).toFixed(2) + " GB";
    if (n >= 1e6) return (n / 1e6).toFixed(1) + " MB";
    return (n / 1e3).toFixed(0) + " KB";
  }

  function fmtUptime(secs) {
    const s = Number(secs);
    if (!Number.isFinite(s) || s <= 0) return "—";
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  function fmtLoad(loadavg) {
    if (!Array.isArray(loadavg) || !loadavg.length) return "—";
    return loadavg.slice(0, 3).map(v => Number(v).toFixed(2)).join(" / ");
  }

  function findGroup(name) {
    const hd = Array.from(document.querySelectorAll(
      "h2,h3,.group-title,.service-group-name"
    )).find(el => normText(el.textContent) === name);
    if (!hd) return null;
    return hd.closest("section")
      || hd.closest("div[class*='group']")
      || hd.parentElement?.parentElement
      || hd.parentElement;
  }

  function ensureHost(group) {
    let row = group.querySelector(".hp-widget-row, .tn-flex-row");
    if (!row) {
      const list = group.querySelector("ul.services-list, ul");
      if (list) list.style.display = "none";
      row = document.createElement("div");
      row.className = "hp-widget-row tn-flex-row";
      group.appendChild(row);
    }
    let host = row.querySelector(".tn-host");
    if (host) return host;
    host = document.createElement("div");
    host.className = "tn-host";
    row.appendChild(host);
    return host;
  }

  function createWsClient(wsUrl) {
    let ws = null;
    let nextId = 1;
    const pending = new Map();

    function connect() {
      return new Promise((resolve, reject) => {
        ws = new WebSocket(wsUrl);
        const timer = setTimeout(() => {
          try { ws.close(); } catch (_) { /* noop */ }
          reject(new Error("TrueNAS WebSocket connection timed out"));
        }, 10000);

        ws.onopen = () => {
          clearTimeout(timer);
          resolve();
        };
        ws.onerror = () => {
          clearTimeout(timer);
          reject(new Error("TrueNAS WebSocket connection failed"));
        };
        ws.onmessage = (ev) => {
          let msg;
          try { msg = JSON.parse(ev.data); } catch (_) { return; }
          if (!msg?.id || !pending.has(msg.id)) return;
          const handlers = pending.get(msg.id);
          pending.delete(msg.id);
          clearTimeout(handlers.timer);
          if (msg.error) handlers.reject(new Error(msg.error?.message || "TrueNAS RPC error"));
          else handlers.resolve(msg.result);
        };
      });
    }

    function call(method, params = []) {
      return new Promise((resolve, reject) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          reject(new Error("TrueNAS WebSocket is not connected"));
          return;
        }
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`TrueNAS RPC timeout: ${method}`));
        }, 12000);
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      });
    }

    function close() {
      if (ws && ws.readyState === WebSocket.OPEN) ws.close();
      ws = null;
      pending.forEach(({ reject, timer }) => {
        clearTimeout(timer);
        reject(new Error("TrueNAS WebSocket closed"));
      });
      pending.clear();
    }

    return { connect, call, close };
  }

  async function wsAuthenticate(client) {
    if (TN_CONFIG.apiKey && !TN_CONFIG.apiKey.includes("PASTE_YOUR")) {
      try {
        const ok = await client.call("auth.login_with_api_key", [TN_CONFIG.apiKey]);
        if (ok === true) return;
      } catch (err) {
        log("auth.login_with_api_key failed", err);
      }
      if (TN_CONFIG.username) {
        try {
          const resp = await client.call("auth.login_ex", [{
            mechanism: "API_KEY_PLAIN",
            username: TN_CONFIG.username,
            api_key: TN_CONFIG.apiKey,
          }]);
          if (resp?.response_type === "SUCCESS") return;
        } catch (err) {
          log("auth.login_ex failed", err);
        }
      }
    }
    if (TN_CONFIG.username && TN_CONFIG.password) {
      const ok = await client.call("auth.login", [TN_CONFIG.username, TN_CONFIG.password]);
      if (ok === true) return;
    }
    throw new Error("TrueNAS authentication failed — check API key or username/password");
  }

  async function wsFetchAll(base) {
    const client = createWsClient(wsUrlFrom(base));
    await client.connect();
    try {
      await wsAuthenticate(client);
      const [system, pools, alerts] = await Promise.all([
        client.call("system.info"),
        client.call("pool.query"),
        client.call("alert.list"),
      ]);
      const poolList = Array.isArray(pools) ? pools : [];
      const enriched = await Promise.all(poolList.map(async (pool) => {
        const name = pool?.name || pool?.id;
        if (!name) return { ...pool, usedBytes: null, availBytes: null };
        try {
          const datasets = await client.call("pool.dataset.query", [
            [["name", "=", name]],
          ]);
          const root = Array.isArray(datasets) ? datasets[0] : null;
          const used = root?.used?.parsed ?? root?.used?.rawval ?? null;
          const avail = root?.available?.parsed ?? root?.available?.rawval ?? null;
          return { ...pool, usedBytes: used, availBytes: avail };
        } catch (_) {
          return { ...pool, usedBytes: null, availBytes: null };
        }
      }));
      return {
        system: system || null,
        pools: enriched,
        alerts: Array.isArray(alerts) ? alerts : [],
      };
    } finally {
      client.close();
    }
  }

  async function restFetch(base, path) {
    const headers = { Accept: "application/json" };
    if (TN_CONFIG.apiKey && !TN_CONFIG.apiKey.includes("PASTE_YOUR")) {
      headers.Authorization = `Bearer ${TN_CONFIG.apiKey}`;
    }
    const res = await fetch(`${base.replace(/\/$/, "")}/api/v2.0/${path}`, {
      headers,
      signal: (() => { const c = new AbortController(); setTimeout(() => c.abort(), 10000); return c.signal; })(),
    });
    if (!res.ok) throw new Error(`TrueNAS REST ${res.status}: ${path}`);
    return res.json();
  }

  async function restFetchAll(base) {
    const [system, pools, alerts] = await Promise.all([
      restFetch(base, "system/info"),
      restFetch(base, "pool"),
      restFetch(base, "alert/list"),
    ]);
    const poolList = Array.isArray(pools) ? pools : [];
    const enriched = await Promise.all(poolList.map(async (pool) => {
      const name = pool?.name;
      if (!name) return { ...pool, usedBytes: null, availBytes: null };
      try {
        const datasets = await restFetch(base, `pool/dataset?id=${encodeURIComponent(name)}`);
        const root = Array.isArray(datasets)
          ? datasets.find(d => d.name === name) || datasets[0]
          : datasets;
        const used = root?.used?.parsed ?? null;
        const avail = root?.available?.parsed ?? null;
        return { ...pool, usedBytes: used, availBytes: avail };
      } catch (_) {
        return { ...pool, usedBytes: null, availBytes: null };
      }
    }));
    return {
      system: system || null,
      pools: enriched,
      alerts: Array.isArray(alerts) ? alerts : [],
    };
  }

  async function fetchAll() {
    let lastErr = null;
    for (const base of urlCandidates()) {
      try {
        const data = Number(TN_CONFIG.apiVersion) >= 2
          ? await wsFetchAll(base)
          : await restFetchAll(base);
        TN_CONFIG.activeUrl = base;
        return data;
      } catch (err) {
        lastErr = err;
        log("fetch failed for", base, err);
        if (Number(TN_CONFIG.apiVersion) >= 2) {
          try {
            const data = await restFetchAll(base);
            TN_CONFIG.activeUrl = base;
            return data;
          } catch (restErr) {
            lastErr = restErr;
          }
        }
      }
    }
    throw lastErr || new Error("All TrueNAS URLs failed");
  }

  function activeAlerts() {
    return (_data.alerts || []).filter(a => a && a.dismissed === false);
  }

  function buildOverview() {
    const sys = _data.system || {};
    const pools = _data.pools || [];
    const alerts = activeAlerts();
    const healthyPools = pools.filter(p => p.healthy !== false).length;
    const hostname = sys.hostname || sys.host_name || "TrueNAS";
    const version = sys.version || sys.full_version || "—";

    return `
      <div class="tn-stats-grid">
        <div class="tn-stat-card">
          <div class="tn-stat-num">${escH(hostname)}</div>
          <div class="tn-stat-label">Hostname</div>
        </div>
        <div class="tn-stat-card">
          <div class="tn-stat-num">${fmtUptime(sys.uptime_seconds || sys.uptime)}</div>
          <div class="tn-stat-label">Uptime</div>
        </div>
        <div class="tn-stat-card">
          <div class="tn-stat-num">${fmtLoad(sys.loadavg)}</div>
          <div class="tn-stat-label">Load Avg</div>
        </div>
        <div class="tn-stat-card">
          <div class="tn-stat-num">${healthyPools}/${pools.length}</div>
          <div class="tn-stat-label">Healthy Pools</div>
        </div>
      </div>
      <div class="tn-meta-row">
        <span>Version ${escH(version)}</span>
        <span class="${alerts.length ? "tn-badge tn-badge--warn" : "tn-badge tn-badge--ok"}">
          ${alerts.length} active alert${alerts.length === 1 ? "" : "s"}
        </span>
      </div>`;
  }

  function buildPools() {
    const pools = _data.pools || [];
    if (!pools.length) return `<div class="tn-empty">No storage pools found</div>`;

    return `<div class="tn-list">` + pools.map(pool => {
      const name = escH(pool.name || "Pool");
      const healthy = pool.healthy !== false;
      const used = pool.usedBytes;
      const avail = pool.availBytes;
      const total = (used != null && avail != null) ? used + avail : null;
      const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : null;
      return `
      <div class="tn-row">
        <span class="tn-dot ${healthy ? "tn-dot--ok" : "tn-dot--bad"}"></span>
        <div class="tn-row-body">
          <div class="tn-row-title">${name}</div>
          <div class="tn-row-sub">${escH(pool.status || (healthy ? "HEALTHY" : "DEGRADED"))}</div>
          ${pct != null ? `
          <div class="tn-bar-track"><div class="tn-bar-fill" style="width:${pct}%"></div></div>
          <div class="tn-row-sub">${fmtBytes(used)} used · ${fmtBytes(avail)} free</div>` : ""}
        </div>
      </div>`;
    }).join("") + `</div>`;
  }

  function buildAlerts() {
    const alerts = activeAlerts().slice(0, 20);
    if (!alerts.length) return `<div class="tn-empty">No active alerts</div>`;

    return `<div class="tn-list">` + alerts.map(alert => {
      const level = String(alert.level || alert.severity || "INFO").toUpperCase();
      const cls = level.includes("CRIT") || level.includes("ERROR") ? "tn-dot--bad"
        : level.includes("WARN") ? "tn-dot--warn" : "tn-dot--ok";
      const text = alert.message || alert.text || alert.title || "Alert";
      const time = alert.datetime?.$date
        ? new Date(alert.datetime.$date).toLocaleString()
        : alert.date ? new Date(alert.date * 1000).toLocaleString() : "";
      return `
      <div class="tn-row">
        <span class="tn-dot ${cls}"></span>
        <div class="tn-row-body">
          <div class="tn-row-title">${escH(text)}</div>
          <div class="tn-row-sub">${escH(level)}${time ? ` · ${escH(time)}` : ""}</div>
        </div>
      </div>`;
    }).join("") + `</div>`;
  }

  function buildShell(contentHtml, loading) {
    const tabs = [
      { key: "overview", label: "Overview" },
      { key: "pools", label: "Pools" },
      { key: "alerts", label: "Alerts" },
    ];
    const tabsHtml = tabs.map(t => `
      <button class="tn-tab${_tab === t.key ? " tn-tab--active" : ""}" data-tab="${t.key}" type="button">
        ${t.label}
      </button>`).join("");

    return `
      <div class="tn-shell">
        <div class="tn-hdr">
          <div class="tn-hdr-left">
            <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/webp/truenas.webp"
              alt="TrueNAS" class="tn-icon" />
            <span class="tn-title">TrueNAS</span>
          </div>
          <div class="tn-hdr-right">
            <div class="tn-tabs">${tabsHtml}</div>
            <a class="tn-open-link" href="${escH(openUrl())}" target="_blank" rel="noopener noreferrer">Open</a>
          </div>
        </div>
        <div class="tn-body">
          ${loading
        ? `<div class="tn-loading"><div class="tn-spinner"></div><span>Connecting to TrueNAS…</span></div>`
        : contentHtml}
        </div>
        <div class="tn-footer">TrueNAS · ${_lastUpdated ? _lastUpdated.toLocaleTimeString() : "—"}</div>
      </div>`;
  }

  function buildSetupShell() {
    return `
      <div class="tn-shell tn-shell--setup">
        <div class="tn-hdr">
          <div class="tn-hdr-left">
            <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/webp/truenas.webp"
              alt="TrueNAS" class="tn-icon" />
            <span class="tn-title">TrueNAS</span>
          </div>
        </div>
        <div class="tn-setup">
          Add your API key in <span>TN_CONFIG.apiKey</span>
          <div class="tn-setup-sub">TrueNAS → top-right user menu → My API Keys → Add API Key</div>
          <div class="tn-setup-sub">Use HTTPS/WSS — API keys are revoked over plain HTTP.</div>
        </div>
      </div>`;
  }

  function renderContent() {
    if (_tab === "pools") return buildPools();
    if (_tab === "alerts") return buildAlerts();
    return buildOverview();
  }

  function paint(loading = false) {
    if (!_host) return;
    _host.innerHTML = buildShell(loading ? "" : renderContent(), loading);
    bindEvents();
  }

  function bindEvents() {
    if (!_host) return;
    _host.querySelectorAll(".tn-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        _tab = btn.dataset.tab;
        paint();
      });
    });
  }

  async function refresh() {
    if (_rendering) return;
    if (!_host) {
      const group = findGroup(TN_CONFIG.groupName);
      if (!group) return;
      _host = ensureHost(group);
    }
    if (!hasCredentials()) {
      _host.innerHTML = buildSetupShell();
      return;
    }
    _rendering = true;
    paint(true);
    try {
      _data = await fetchAll();
      _lastUpdated = new Date();
      paint(false);
    } catch (err) {
      console.error("[TrueNASWidget]", err);
      if (_host) {
        _host.innerHTML = buildShell(
          `<div class="tn-empty" style="color:#f87171">${escH(err.message)}</div>`, false);
      }
    } finally {
      _rendering = false;
    }
  }

  HpWidgetBoot.watch("truenas", {
    ready: () => !!document.querySelector(".tn-host .tn-shell"),
    setup: () => setInterval(() => { if (!document.hidden) refresh(); }, TN_CONFIG.pollMs),
    mount: () => {
      const group = findGroup(TN_CONFIG.groupName);
      if (!group) return;
      _host = ensureHost(group);
      refresh();
    },
  });
})();
