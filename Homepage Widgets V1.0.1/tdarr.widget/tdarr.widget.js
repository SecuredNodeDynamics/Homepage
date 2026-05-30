/* =====================================================
   TDARR WIDGET
   Media Tab → group: ARR — TDARR
===================================================== */
(function () {

  const TDR_CONFIG = {
    groupName: "ARR — TDARR",
    url: "http://YOUR_LOCAL_IP:PORT",
    apiBase: "http://YOUR_LOCAL_IP:PORT",
    fallbackUrl: "https://YOUR_TUNNEL_URL", // or null if not using a tunnel
    activeUrl: null,
    key: "YOUR_API_KEY_HERE",
    pollMs: 120 * 1000,
  };

  /* ── Utilities ─────────────────────────────────── */
  function normText(v) { return (v || "").replace(/\s+/g, " ").trim(); }
  function escH(s = "") {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function fmtNum(n) { return n == null ? "—" : Number(n).toLocaleString(); }
  function fmtPct(n) { return n == null ? "—" : `${Number(n).toFixed(1)}%`; }
  function fmtSizeGB(gb) {
    if (gb == null || isNaN(gb)) return "—";
    return `${Number(gb).toFixed(1)} GB`;
  }
  function fmtEta(secs) {
    if (!secs || isNaN(secs)) return null;
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = Math.floor(secs % 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

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
    let host = group.querySelector(".tdr-host");
    if (host) return host;
    const list = group.querySelector("ul.services-list, ul");
    if (list) list.style.display = "none";
    host = document.createElement("div");
    host.className = "tdr-host";
    group.appendChild(host);
    return host;
  }

  /* ── API ───────────────────────────────────────── */
  // Tdarr requires the API key as x-api-key header
  async function tdrFetch(path, method = "GET", body = null) {
    const candidates = [];
    if (TDR_CONFIG.activeUrl) candidates.push(TDR_CONFIG.activeUrl);
    if (!candidates.includes(TDR_CONFIG.apiBase)) candidates.push(TDR_CONFIG.apiBase);
    if (TDR_CONFIG.fallbackUrl && !candidates.includes(TDR_CONFIG.fallbackUrl)) candidates.push(TDR_CONFIG.fallbackUrl);

    const opts = {
      method,
      signal: AbortSignal.timeout(10000),
      headers: {
        "Content-Type": "application/json",
        "x-api-key": TDR_CONFIG.key,
      },
    };
    if (body) opts.body = JSON.stringify(body);

    let lastErr = null;
    for (const base of candidates) {
      try {
        const res = await fetch(`${base}${path}`, opts);
        if (!res.ok) throw new Error(`Tdarr ${res.status}: ${path}`);
        TDR_CONFIG.activeUrl = base;
        return res.json();
      } catch (err) {
        TDR_CONFIG.activeUrl = null;
        lastErr = err;
      }
    }
    throw lastErr || new Error(`All URLs failed for Tdarr`);
  }

  async function fetchAll() {
    const [statsRes, nodesRes] = await Promise.allSettled([
      tdrFetch("/api/v2/cruddb", "POST", {
        data: {
          collection: "StatisticsJSONDB",
          mode: "getById",
          docID: "statistics",
          obj: {},
        },
      }),
      tdrFetch("/api/v2/get-nodes"),
    ]);

    /* ── Parse statistics ── */
    let queueStats = {
      totalFiles: 0,
      transcodeQueue: 0,
      healthCheckQueue: 0,
      transcodeError: 0,
      healthCheckError: 0,
      transcodeSuccess: 0,
      sizeDiff: 0,
    };

    if (statsRes.status === "fulfilled" && statsRes.value) {
      const s = statsRes.value;
      queueStats = {
        totalFiles: s.totalFileCount ?? 0,
        transcodeSuccess: s.totalTranscodeCount ?? 0,
        transcodeQueue: s.table3Count ?? 0,
        healthCheckQueue: s.table4Count ?? 0,
        transcodeError: s.table6Count ?? 0,
        healthCheckError: s.table6Count ?? 0,
        sizeDiff: s.sizeDiff ?? 0,
      };
    }

    /* ── Parse nodes / workers ── */
    const nodeList = [];
    if (nodesRes.status === "fulfilled" && nodesRes.value) {
      const raw = nodesRes.value;
      Object.values(raw).forEach(node => {
        if (!node || typeof node !== "object") return;
        nodeList.push({
          name: node.nodeName || node.name || node._id || "Unknown Node",
          status: node.status || "unknown",
          paused: !!node.nodePaused,
          queueLengths: node.queueLengths || {},
          workerLimits: node.workerLimits || {},
        });
      });
    }

    return { queueStats, nodeList };
  }

  /* ── State ─────────────────────────────────────── */
  let _tab = "overview";
  let _data = { queueStats: {}, nodeList: [] };
  let _host = null;
  let _rendering = false;
  let _lastUpdated = null;
  let _error = null;

  /* ── Shell ─────────────────────────────────────── */
  function buildShell(contentHtml, loading) {
    const tabs = [
      { key: "overview", label: "Overview" },
      { key: "workers", label: "Workers" },
      { key: "queue", label: "Queue" },
    ];

    const tabsHtml = tabs.map(t => {
      const qs = _data.queueStats;
      const errorCount = (qs.transcodeError || 0) + (qs.healthCheckError || 0);
      const badge = t.key === "queue" && errorCount
        ? ` <span class="tdr-tab-badge">${errorCount}</span>` : "";
      return `
        <button class="tdr-tab ${_tab === t.key ? "tdr-tab--active" : ""}" data-tab="${t.key}">
          ${t.label}${badge}
        </button>`;
    }).join("");

    const updatedStr = _lastUpdated ? _lastUpdated.toLocaleTimeString() : "";

    return `
      <div class="tdr-shell">
        <div class="tdr-hdr">
          <div class="tdr-hdr-left">
            <img src="/icons/tdarr.png" alt="Tdarr" class="tdr-icon">
            <span class="tdr-title">Tdarr</span>
          </div>
          <div class="tdr-hdr-right">
            <div class="tdr-tabs">${tabsHtml}</div>
            <a class="tdr-open-link" href="${escH(TDR_CONFIG.url)}" target="_blank" rel="noopener">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
              </svg>
              Open
            </a>
          </div>
        </div>
        <div class="tdr-body">
          ${loading
        ? `<div class="tdr-loading">
                <svg class="tdr-spin" width="16" height="16" viewBox="0 0 24 24" fill="none"
                     stroke="rgba(99,202,183,0.8)" stroke-width="2">
                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
                </svg> Loading…</div>`
        : `<div class="tdr-scroll">${contentHtml}</div>`}
        </div>
        <div class="tdr-footer">Tdarr · ${updatedStr}</div>
      </div>`;
  }

  /* ── Overview ──────────────────────────────────── */
  function buildOverview() {
    const qs = _data.queueStats;
    const activeWorkers = _data.nodeList.reduce((acc, n) => acc + (n.workers?.length || 0), 0);
    const sizeDiff = qs.sizeDiff ?? 0;
    const showSize = sizeDiff !== 0;

    return `
      <div class="tdr-stat-grid">
        <div class="tdr-stat">
          <div class="tdr-stat-value">${fmtNum(qs.totalFiles)}</div>
          <div class="tdr-stat-label">Total Files</div>
        </div>
        <div class="tdr-stat tdr-stat--good">
          <div class="tdr-stat-value">${fmtNum(qs.transcodeSuccess)}</div>
          <div class="tdr-stat-label">Transcoded</div>
        </div>
        <div class="tdr-stat tdr-stat--warn">
          <div class="tdr-stat-value">${fmtNum(qs.transcodeQueue)}</div>
          <div class="tdr-stat-label">Transcode Queue</div>
        </div>
        <div class="tdr-stat tdr-stat--warn">
          <div class="tdr-stat-value">${fmtNum(qs.healthCheckQueue)}</div>
          <div class="tdr-stat-label">Health Queue</div>
        </div>
        <div class="tdr-stat ${(qs.transcodeError || qs.healthCheckError) ? "tdr-stat--error" : ""}">
          <div class="tdr-stat-value">${fmtNum((qs.transcodeError || 0) + (qs.healthCheckError || 0))}</div>
          <div class="tdr-stat-label">Errors</div>
        </div>
        <div class="tdr-stat tdr-stat--active">
          <div class="tdr-stat-value">${fmtNum(activeWorkers)}</div>
          <div class="tdr-stat-label">Active Workers</div>
        </div>
        <div class="tdr-stat ${showSize ? "tdr-stat--good" : ""}" style="grid-column: span 3">
          <div class="tdr-stat-value">${showSize ? fmtSizeGB(Math.abs(sizeDiff)) : "—"}</div>
          <div class="tdr-stat-label">Space Saved</div>
        </div>
      </div>`;
  }

  /* ── Workers ───────────────────────────────────── */
  function buildWorkers() {
    const nodes = _data.nodeList;
    if (!nodes.length) {
      return `<div class="tdr-empty">No nodes connected</div>`;
    }

    return nodes.map(node => {
      const ql = node.queueLengths || {};
      const wl = node.workerLimits || {};

      const slots = [
        { label: "Transcode CPU", active: ql.transcodecpu || 0, limit: wl.transcodecpu || 0 },
        { label: "Transcode GPU", active: ql.transcodegpu || 0, limit: wl.transcodegpu || 0 },
        { label: "Health Check CPU", active: ql.healthcheckcpu || 0, limit: wl.healthcheckcpu || 0 },
        { label: "Health Check GPU", active: ql.healthcheckgpu || 0, limit: wl.healthcheckgpu || 0 },
      ].filter(s => s.limit > 0 || s.active > 0);

      const totalActive = (ql.transcodecpu || 0) + (ql.transcodegpu || 0) +
        (ql.healthcheckcpu || 0) + (ql.healthcheckgpu || 0);

      const slotRows = slots.length ? slots.map(s => `
      <div class="tdr-worker-row">
        <span class="tdr-dot ${s.active > 0 ? "tdr-dot--active" : "tdr-dot--neutral"}" style="margin-top:4px;flex-shrink:0"></span>
        <div class="tdr-row-body">
          <div class="tdr-row-title">${escH(s.label)}</div>
          <div class="tdr-row-sub">${s.active} active${s.limit ? ` · ${s.limit} max` : ""}</div>
          ${s.limit ? `
          <div class="tdr-progress-bar">
            <div class="tdr-progress-fill" style="width:${Math.min(100, (s.active / s.limit) * 100)}%"></div>
          </div>` : ""}
        </div>
        <div class="tdr-row-meta">
          <span class="tdr-badge ${s.active > 0 ? "tdr-badge--active" : "tdr-badge--neutral"}">${s.active}/${s.limit || "∞"}</span>
        </div>
      </div>`).join("")
        : `<div class="tdr-worker-idle">No worker slots configured</div>`;

      const statusDot = node.paused ? "tdr-dot--warn"
        : totalActive > 0 ? "tdr-dot--active"
          : "tdr-dot--good";

      return `
      <div class="tdr-node-block">
        <div class="tdr-node-hdr">
          <span class="tdr-dot ${statusDot}"></span>
          <span class="tdr-node-name">${escH(node.name)}</span>
          <span class="tdr-badge ${node.paused ? "tdr-badge--warn" : totalActive > 0 ? "tdr-badge--active" : "tdr-badge--good"}" style="margin-left:auto">
            ${node.paused ? "Paused" : totalActive > 0 ? "Working" : "Online"}
          </span>
          <span class="tdr-badge tdr-badge--neutral">${totalActive} active</span>
        </div>
        <div class="tdr-node-workers">${slotRows}</div>
      </div>`;
    }).join("");
  }

  /* ── Queue ─────────────────────────────────────── */
  function buildQueue() {
    const qs = _data.queueStats;
    const rows = [
      { label: "Awaiting Transcode", value: qs.transcodeQueue, dot: "tdr-dot--warn", badge: "tdr-badge--warn" },
      { label: "Awaiting Health Check", value: qs.healthCheckQueue, dot: "tdr-dot--neutral", badge: "tdr-badge--neutral" },
      { label: "Transcode Errors", value: qs.transcodeError, dot: "tdr-dot--error", badge: "tdr-badge--error" },
      { label: "Health Check Errors", value: qs.healthCheckError, dot: "tdr-dot--error", badge: "tdr-badge--error" },
      { label: "Transcoded Successfully", value: qs.transcodeSuccess, dot: "tdr-dot--good", badge: "tdr-badge--good" },
    ];

    if (!Object.values(qs).some(v => v)) {
      return `<div class="tdr-empty">No queue data — Tdarr may be idle or queue is empty</div>`;
    }

    return rows.map(r => `
      <div class="tdr-row">
        <span class="tdr-dot ${r.dot}"></span>
        <div class="tdr-row-body">
          <div class="tdr-row-title">${escH(r.label)}</div>
        </div>
        <div class="tdr-row-meta">
          <span class="tdr-badge ${r.badge}">${fmtNum(r.value ?? 0)}</span>
        </div>
      </div>`).join("");
  }

  /* ── Render ────────────────────────────────────── */
  function renderContent() {
    if (_tab === "overview") return buildOverview();
    if (_tab === "workers") return buildWorkers();
    if (_tab === "queue") return buildQueue();
    return buildOverview();
  }

  function paint(loading = false) {
    if (!_host) return;
    _host.innerHTML = buildShell(loading ? "" : renderContent(), loading);
    if (!loading && _tab === "workers") {
      const scroll = _host.querySelector(".tdr-scroll");
      if (scroll) scroll.classList.add("tdr-scroll--scrollable");
    }
    bindEvents();
  }

  function bindEvents() {
    if (!_host) return;
    _host.querySelectorAll(".tdr-tab").forEach(btn => {
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
      _data = await fetchAll();
      _error = null;
      _lastUpdated = new Date();
      paint(false);
    } catch (err) {
      _error = err.message;
      console.error("[TdarrWidget]", err);
      if (_host) _host.innerHTML = buildShell(
        `<div class="tdr-empty" style="color:#f87171">Failed to load Tdarr data<br>
         <span style="font-size:0.62rem;opacity:0.6">${escH(err.message)}</span></div>`, false);
    } finally {
      _rendering = false;
    }
  }

  /* ── Init ──────────────────────────────────────── */
  function init() {
    const start = () => setTimeout(() => {
      const group = findGroup(TDR_CONFIG.groupName);
      if (!group) return;
      _host = ensureHost(group);
      refresh();
      setInterval(() => {
        if (document.hidden) return;
        refresh();
      }, TDR_CONFIG.pollMs);
    }, 1400);

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
        if (!document.querySelector(".tdr-host .tdr-shell")) {
          const group = findGroup(TDR_CONFIG.groupName);
          if (!group) return;
          _host = ensureHost(group);
          refresh();
        }
      }, 700);
    }).observe(document.body, { childList: true, subtree: true });
  }

  init();
})();