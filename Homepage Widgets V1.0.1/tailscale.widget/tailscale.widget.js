/* =====================================================
   TAILSCALE WIDGET
   Devices, Exit Nodes, Online/Offline Status
   group: TAILSCALE
===================================================== */
(function () {

  const TS_CONFIG = {
    groupName: "TAILSCALE-WIDGET",
    apiKey: "YOUR_TAILSCALE_API_KEY",
    tailnet: "_",
    proxyUrl: "https://tailscale.YOURTAILSCALEID.workers.dev/tailscale-proxy",
    publicUrl: "https://login.tailscale.com/admin/machines",
    pollMs: 60 * 1000,
    color: "#3b82f6",
  };

  /* ── Utilities ─────────────────────────────────── */
  function normText(v) { return (v || "").replace(/\s+/g, " ").trim(); }
  function escH(s = "") {
    return String(s ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function fmtNum(n) { return n == null ? "0" : Number(n).toLocaleString(); }

  function timeAgo(dateStr) {
    if (!dateStr) return "Never";
    const diff = Math.floor((Date.now() - new Date(dateStr)) / 1000);
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
    return new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  function isOnline(device) {
    // Tailscale marks online via LastSeen within ~2 minutes
    if (!device.lastSeen) return false;
    const diff = (Date.now() - new Date(device.lastSeen)) / 1000;
    return diff < 180;
  }

  function getDeviceIP(device) {
    const addrs = device.addresses || [];
    // Prefer IPv4 Tailscale address (100.x.x.x)
    const v4 = addrs.find(a => a.startsWith("100."));
    return v4 || addrs[0] || "—";
  }

  function getDeviceOS(device) {
    const os = (device.os || "").toLowerCase();
    if (os.includes("linux")) return "🐧";
    if (os.includes("windows")) return "🪟";
    if (os.includes("darwin") || os.includes("mac")) return "🍎";
    if (os.includes("ios") || os.includes("iphone")) return "📱";
    if (os.includes("android")) return "🤖";
    if (os.includes("freebsd") || os.includes("openbsd")) return "😈";
    return "💻";
  }

  function getTags(device) {
    const tags = device.tags || [];
    return tags.map(t => t.replace("tag:", ""));
  }

  /* ── DOM helpers ───────────────────────────────── */
  function findGroup(name) {
    const hd = Array.from(document.querySelectorAll(
      "h2,h3,.group-title,.service-group-name"
    )).find(el => normText(el.textContent) === name);
    if (!hd) return null;
    return hd.closest("section") ||
      hd.closest("div[class*='group']") ||
      hd.parentElement?.parentElement ||
      hd.parentElement;
  }

  function ensureHost(group) {
    // ── SHARED ROW IDENTIFIER ─────────────────────
    // Change to match another widget's row class if sharing a group.
    const SHARED_ROW_CLASS = "ts-flex-row";
    // ── HOST IDENTIFIER ───────────────────────────
    const HOST_CLASS = "ts-host";
    // ─────────────────────────────────────────────

    let row = group.querySelector("." + SHARED_ROW_CLASS);
    if (!row) {
      const list = group.querySelector("ul.services-list, ul");
      if (list) list.style.display = "none";
      row = document.createElement("div");
      row.className = SHARED_ROW_CLASS;
      group.appendChild(row);
    }
    let host = row.querySelector("." + HOST_CLASS);
    if (host) return host;
    host = document.createElement("div");
    host.className = HOST_CLASS;
    row.appendChild(host);
    return host;
  }

  /* ── API ───────────────────────────────────────── */
  async function tsFetch(path) {
    const url = `${TS_CONFIG.proxyUrl}${path}${path.includes("?") ? "&" : "?"}fields=all`;
    const res = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${TS_CONFIG.apiKey}`,
        "Accept": "application/json",
      },
      signal: (() => { const c = new AbortController(); setTimeout(() => c.abort(), 8000); return c.signal; })(),
    });
    if (!res.ok) throw new Error(`Tailscale ${res.status}: ${path}`);
    return res.json();
  }

  async function fetchDevices() {
    const data = await tsFetch(`/api/v2/tailnet/${TS_CONFIG.tailnet}/devices`);
    return (data.devices || []).map(d => ({
      id: d.id,
      nodeId: d.nodeId || "",
      name: d.name?.split(".")[0] || d.hostname || "Unknown",
      fqdn: d.name || "",
      hostname: d.hostname || "",
      os: d.os || "",
      addresses: d.addresses || [],
      tags: d.tags || [],
      lastSeen: d.lastSeen || null,
      isExitNode: !!(d.advertisedRoutes?.some(r => r === "0.0.0.0/0" || r === "::/0") ||
        d.enabledRoutes?.some(r => r === "0.0.0.0/0" || r === "::/0")),
      advertisedRoutes: d.advertisedRoutes || [],
      enabledRoutes: d.enabledRoutes || [],
      authorized: d.authorized ?? true,
      online: false, // will be computed below
      clientVersion: d.clientVersion || "",
      updateAvailable: d.updateAvailable || false,
    })).map(d => ({ ...d, online: isOnline(d) }));
  }

  /* ── State ─────────────────────────────────────── */
  let _tab = "overview";
  let _data = { devices: [] };
  let _host = null;
  let _rendering = false;
  let _lastUpdated = null;
  let _error = null;

  /* ── Overview panel ────────────────────────────── */
  function buildOverview() {
    const devices = _data.devices;
    const online = devices.filter(d => d.online).length;
    const offline = devices.length - online;
    const exitNodes = devices.filter(d => d.isExitNode).length;
    const updateAvailable = devices.filter(d => d.updateAvailable).length;
    const tags = [...new Set(devices.flatMap(d => getTags(d)))];

    return `
    <div class="ts-fixed">
      <div class="ts-stat-grid">
        <div class="ts-stat ts-stat--online">
          <div class="ts-stat-value">${fmtNum(online)}</div>
          <div class="ts-stat-label">Online</div>
        </div>
        <div class="ts-stat ts-stat--offline">
          <div class="ts-stat-value">${fmtNum(offline)}</div>
          <div class="ts-stat-label">Offline</div>
        </div>
        <div class="ts-stat">
          <div class="ts-stat-value">${fmtNum(devices.length)}</div>
          <div class="ts-stat-label">Total Devices</div>
        </div>
        <div class="ts-stat ${exitNodes > 0 ? "ts-stat--accent" : ""}">
          <div class="ts-stat-value">${fmtNum(exitNodes)}</div>
          <div class="ts-stat-label">Exit Nodes</div>
        </div>
        <div class="ts-stat ${updateAvailable > 0 ? "ts-stat--warn" : ""}">
          <div class="ts-stat-value">${fmtNum(updateAvailable)}</div>
          <div class="ts-stat-label">Updates</div>
        </div>
        <div class="ts-stat">
          <div class="ts-stat-value">${fmtNum(tags.length)}</div>
          <div class="ts-stat-label">Tags</div>
        </div>
      </div>
      ${tags.length ? `
        <div class="ts-tag-cloud">
          ${tags.map(t => `<span class="ts-tag">${escH(t)}</span>`).join("")}
        </div>` : ""}
    </div>

    <div class="ts-scroll">
      <div class="ts-section-label">Recently Seen</div>
      ${devices
        .filter(d => d.lastSeen)
        .sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen))
        .slice(0, 5)
        .map(d => buildDeviceRow(d))
        .join("") || `<div class="ts-empty">No devices found</div>`}
    </div>`;
  }

  /* ── Device row ────────────────────────────────── */
  function buildDeviceRow(d) {
    const ip = getDeviceIP(d);
    const os = getDeviceOS(d);
    const tags = getTags(d);
    const dotCls = d.online ? "ts-dot--online" : "ts-dot--offline";

    return `
      <div class="ts-row">
        <span class="ts-dot ${dotCls}"></span>
        <span class="ts-os-icon">${os}</span>
        <div class="ts-row-body">
          <div class="ts-row-title">
            ${escH(d.name)}
            ${d.isExitNode ? `<span class="ts-exit-badge">Exit Node</span>` : ""}
            ${d.updateAvailable ? `
              <span class="ts-update-badge">Update Available</span>
              <a class="ts-update-btn" href="https://login.tailscale.com/admin/machines/${escH(d.nodeId)}" target="_blank" rel="noopener">↑ Update</a>
            ` : ""}
            ${!d.authorized ? `<span class="ts-warn-badge">Unauthorized</span>` : ""}
          </div>
          <div class="ts-row-sub">
            <span class="ts-ip">${escH(ip)}</span>
            ${tags.length ? tags.map(t => `<span class="ts-tag ts-tag--sm">${escH(t)}</span>`).join("") : ""}
          </div>
        </div>
        <div class="ts-row-meta">
          <span class="ts-lastseen ${d.online ? "ts-lastseen--online" : ""}">${escH(timeAgo(d.lastSeen))}</span>
        </div>
      </div>`;
  }

  /* ── Devices panel ─────────────────────────────── */
  function buildDevices() {
    const devices = _data.devices;
    if (!devices.length) return `<div class="ts-scroll"><div class="ts-empty">No devices found</div></div>`;

    const online = devices.filter(d => d.online).sort((a, b) => a.name.localeCompare(b.name));
    const offline = devices.filter(d => !d.online).sort((a, b) => new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0));

    return `
    <div class="ts-scroll">
      ${online.length ? `
        <div class="ts-group-header">
          <span class="ts-dot ts-dot--online"></span>
          Online <span class="ts-group-count">${online.length}</span>
        </div>
        ${online.map(buildDeviceRow).join("")}
      ` : ""}
      ${offline.length ? `
        <div class="ts-group-header" style="margin-top:10px">
          <span class="ts-dot ts-dot--offline"></span>
          Offline <span class="ts-group-count">${offline.length}</span>
        </div>
        ${offline.map(buildDeviceRow).join("")}
      ` : ""}
    </div>`;
  }


  /* ── Exit Nodes panel ──────────────────────────── */
  function buildExitNodes() {
    const exitNodes = _data.devices.filter(d => d.isExitNode);
    if (!exitNodes.length) return `<div class="ts-empty">No exit nodes configured</div>`;

    return exitNodes.map(d => {
      const ip = getDeviceIP(d);
      const os = getDeviceOS(d);
      const dotCls = d.online ? "ts-dot--online" : "ts-dot--offline";
      const routes = [...(d.advertisedRoutes || []), ...(d.enabledRoutes || [])]
        .filter((r, i, arr) => arr.indexOf(r) === i)
        .filter(r => r !== "0.0.0.0/0" && r !== "::/0");

      return `
        <div class="ts-exit-card" style="margin-bottom:10px">
          <div class="ts-exit-card-header">
            <span class="ts-dot ${dotCls}"></span>
            <span class="ts-os-icon">${os}</span>
            <span class="ts-exit-card-name">${escH(d.name)}</span>
            <span class="ts-exit-badge" style="margin-left:auto">Exit Node</span>
            <span class="ts-lastseen ${d.online ? "ts-lastseen--online" : ""}">${escH(timeAgo(d.lastSeen))}</span>
          </div>
          <div class="ts-exit-card-body">
            <div class="ts-exit-detail">
              <span class="ts-exit-detail-label">Tailscale IP</span>
              <span class="ts-exit-detail-value ts-ip">${escH(ip)}</span>
            </div>
            <div class="ts-exit-detail">
              <span class="ts-exit-detail-label">Hostname</span>
              <span class="ts-exit-detail-value">${escH(d.hostname || d.name)}</span>
            </div>
            <div class="ts-exit-detail">
              <span class="ts-exit-detail-label">OS</span>
              <span class="ts-exit-detail-value">${escH(d.os || "Unknown")}</span>
            </div>
            ${routes.length ? `
              <div class="ts-exit-detail">
                <span class="ts-exit-detail-label">Routes</span>
                <span class="ts-exit-detail-value">${routes.map(r => `<span class="ts-route">${escH(r)}</span>`).join("")}</span>
              </div>` : ""}
          </div>
        </div>`;
    }).join("");
  }

  /* ── Shell ─────────────────────────────────────── */
  function buildShell(contentHtml, loading) {
    const tabs = [
      { key: "overview", label: "Overview" },
      { key: "devices", label: "Devices" },
      { key: "exitnodes", label: "Exit Nodes" },
    ];

    const online = _data.devices.filter(d => d.online).length;
    const total = _data.devices.length;
    const exitCount = _data.devices.filter(d => d.isExitNode).length;

    const tabsHtml = tabs.map(t => {
      let badge = "";
      if (t.key === "devices" && total > 0) {
        badge = `<span class="ts-tab-badge">${online}/${total}</span>`;
      }
      if (t.key === "exitnodes" && exitCount > 0) {
        badge = `<span class="ts-tab-badge">${exitCount}</span>`;
      }
      return `
      <button class="ts-tab ${_tab === t.key ? "ts-tab--active" : ""}" data-tab="${t.key}">
        ${t.label}${badge}
      </button>`;
    }).join("");

    const updatedStr = _lastUpdated ? _lastUpdated.toLocaleTimeString() : "";

    return `
    <div class="ts-shell">
      <div class="ts-hdr">
        <div class="ts-hdr-left">
          <img src="/icons/tailscale.png" alt="Tailscale" class="ts-icon"
               onerror="this.src='https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/webp/tailscale.webp'">
          <span class="ts-title">Tailscale</span>
        </div>
        <div class="ts-hdr-right">
          <div class="ts-tabs">${tabsHtml}</div>
          <a class="ts-open-link" href="${escH(TS_CONFIG.publicUrl)}" target="_blank" rel="noopener">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
              <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
            Open
          </a>
        </div>
      </div>

      <div class="ts-body">
        ${loading
        ? `<div class="ts-loading">
              <svg class="ts-spin" width="16" height="16" viewBox="0 0 24 24" fill="none"
                   stroke="${TS_CONFIG.color}" stroke-width="2">
                <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83
                         M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
              </svg> Loading…</div>`
        : contentHtml}
      </div>

      <div class="ts-footer">Tailscale · ${updatedStr}</div>
    </div>`;
  }

  /* ── Render ────────────────────────────────────── */
  function renderContent() {
    if (_tab === "overview") return buildOverview();
    if (_tab === "devices") return buildDevices();
    if (_tab === "exitnodes") return buildExitNodes();
    return buildOverview();
  }

  function paint(loading = false) {
    if (!_host) return;
    _host.innerHTML = buildShell(loading ? "" : renderContent(), loading);
    bindEvents();
  }

  function bindEvents() {
    if (!_host) return;
    _host.querySelectorAll(".ts-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        _tab = btn.dataset.tab;
        paint();
      });
    });
  }

  async function refresh() {
    if (_rendering) return;
    _rendering = true;
    paint(true);
    try {
      const devices = await fetchDevices();
      _data = { devices };
      _error = null;
      _lastUpdated = new Date();
      paint(false);
    } catch (err) {
      _error = err.message;
      console.error("[TailscaleWidget]", err);
      if (_host) _host.innerHTML = buildShell(
        `<div class="ts-empty" style="color:#f87171">
          Failed to load Tailscale data<br>
          <span style="font-size:0.62rem;opacity:0.6">${escH(err.message)}</span>
        </div>`, false);
    } finally {
      _rendering = false;
    }
  }

  /* ── Init ──────────────────────────────────────── */
  function init() {
    const start = () => {
      const run = () => setTimeout(() => {
        const group = findGroup(TS_CONFIG.groupName);
        if (!group) return;
        _host = ensureHost(group);
        refresh();
        setInterval(() => {
          if (document.hidden) return;
          refresh();
        }, TS_CONFIG.pollMs);
      }, 1400);

      if (document.readyState === "complete") {
        run();
      } else {
        window.addEventListener("load", run, { once: true });
      }
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }

    let pending = false;
    new MutationObserver(() => {
      if (pending) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        if (!document.querySelector(".ts-host .ts-shell")) {
          // Only act after page is fully loaded
          if (document.readyState !== "complete") return;
          const group = findGroup(TS_CONFIG.groupName);
          if (!group) return;
          _host = ensureHost(group);
          refresh();
        }
      }, 700);
    }).observe(document.body, { childList: true, subtree: true });
  }

  init();
})();