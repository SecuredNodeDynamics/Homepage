/* =====================================================
   PROWLARR WIDGET
===================================================== */
(function () {

  const PWR_CONFIG = {
    groupName: "ARR -- PROWLARR.BAZARR",
    url: "https://prowlarr.janzenmediagroup.com",
    fallbackUrl: "http://10.128.1.33:9696",
    activeUrl: null,
    key: "1eed4ac1961f4b82a64916b9ffa52fed",
    pollMs: 120 * 1000,
  };

  /* ── Utilities ─────────────────────────────────── */
  function normText(v) { return (v || "").replace(/\s+/g, " ").trim(); }
  function escH(s = "") {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function fmtDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    return isNaN(d) ? "—" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }
  function fmtTime(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    return isNaN(d) ? "—" : d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }
  function fmtNum(n) { return n == null ? "—" : Number(n).toLocaleString(); }

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
    let row = group.querySelector(".arr-flex-row");
    if (!row) {
      const list = group.querySelector("ul.services-list, ul");
      if (list) list.style.display = "none";
      row = document.createElement("div");
      row.className = "arr-flex-row";
      group.appendChild(row);
    }
    let host = row.querySelector(".pwr-host");
    if (host) return host;
    host = document.createElement("div");
    host.className = "pwr-host";
    row.appendChild(host);
    return host;
  }

  /* ── API ───────────────────────────────────────── */
  async function pwrFetch(path) {
    const candidates = [];
    if (PWR_CONFIG.activeUrl) candidates.push(PWR_CONFIG.activeUrl);
    if (!candidates.includes(PWR_CONFIG.url)) candidates.push(PWR_CONFIG.url);
    if (PWR_CONFIG.fallbackUrl && !candidates.includes(PWR_CONFIG.fallbackUrl)) candidates.push(PWR_CONFIG.fallbackUrl);

    let lastErr = null;
    for (const base of candidates) {
      try {
        const res = await fetch(`${base}${path}`, {
          headers: { "X-Api-Key": PWR_CONFIG.key },
          signal: (() => { const c = new AbortController(); setTimeout(() => c.abort(), 8000); return c.signal; })(),
        });
        if (!res.ok) throw new Error(`Prowlarr ${res.status}: ${path}`);
        PWR_CONFIG.activeUrl = base;
        return res.json();
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error("All URLs failed for Prowlarr");
  }

  async function fetchAll() {
    const [indexers, stats, history] = await Promise.allSettled([
      pwrFetch("/api/v1/indexer"),
      pwrFetch("/api/v1/indexerstats"),
      pwrFetch("/api/v1/history?pageSize=20&sortKey=date&sortDirection=descending"),
    ]);


    return {
      indexers: indexers.status === "fulfilled" ? (Array.isArray(indexers.value) ? indexers.value : []) : [],
      stats: stats.status === "fulfilled" ? stats.value : null,
      history: history.status === "fulfilled"
        ? (Array.isArray(history.value) ? history.value
          : Array.isArray(history.value?.records) ? history.value.records
            : Array.isArray(history.value?.data) ? history.value.data
              : [])
        : [],
    };
  }

  /* ── State ─────────────────────────────────────── */
  let _tab = "overview";
  let _data = { indexers: [], stats: null, history: [] };
  let _host = null;
  let _rendering = false;
  let _lastUpdated = null;

  /* ── Shell ─────────────────────────────────────── */
  function buildShell(contentHtml, loading) {
    const tabs = [
      { key: "overview", label: "Overview" },
      { key: "indexers", label: "Indexers" },
      { key: "history", label: "History" },
      { key: "stats", label: "Stats" },
    ];

    const tabsHtml = tabs.map(t => `
      <button class="pwr-tab ${_tab === t.key ? "pwr-tab--active" : ""}" data-tab="${t.key}">
        ${t.label}
      </button>`).join("");

    const updatedStr = _lastUpdated ? _lastUpdated.toLocaleTimeString() : "";

    return `
      <div class="pwr-shell">
        <div class="pwr-hdr">
          <div class="pwr-hdr-left">
            <img src="/icons/Prowlarr.png" alt="Prowlarr" class="pwr-icon">
            <span class="pwr-title">Prowlarr</span>
          </div>
          <div class="pwr-hdr-right">
            <div class="pwr-tabs">${tabsHtml}</div>
            <a class="pwr-open-link" href="${escH(PWR_CONFIG.url)}" target="_blank" rel="noopener">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
              </svg>
              Open
            </a>
          </div>
        </div>
        <div class="pwr-body">
          ${loading
        ? `<div class="pwr-loading">
                <svg class="pwr-spin" width="16" height="16" viewBox="0 0 24 24" fill="none"
                     stroke="rgba(249,115,22,0.8)" stroke-width="2">
                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
                </svg> Loading…</div>`
        : `<div class="pwr-scroll"><div class="pwr-scroll-inner">${contentHtml}</div></div>`}
        </div>
        <div class="pwr-footer">Prowlarr · ${updatedStr}</div>
      </div>`;
  }

  /* ── Overview ──────────────────────────────────── */
  function buildOverview() {
    const indexers = _data.indexers;
    const stats = _data.stats;
    const enabled = indexers.filter(i => i.enable).length;
    const disabled = indexers.length - enabled;
    const torrent = indexers.filter(i => i.protocol === "torrent").length;

    const totalGrabs = stats?.indexers?.reduce((a, s) => a + (s.numberOfGrabs || 0), 0) ?? 0;
    const totalQueries = stats?.indexers?.reduce((a, s) => a + (s.numberOfQueries || 0), 0) ?? 0;
    const totalFailedRss = stats?.indexers?.reduce((a, s) => a + (s.numberOfFailedRssQueries || 0), 0) ?? 0;
    const totalFails = totalFailedRss + _data.history.filter(h => !h.successful).length;
    const failedIndexers = stats?.indexers?.filter(s =>
      (s.numberOfFailedRssQueries || 0) > 0 ||
      (s.numberOfFailedQueries || 0) > 0
    ).length ?? 0;


    return `
      <div class="pwr-stat-grid">
        <div class="pwr-stat">
          <div class="pwr-stat-value">${fmtNum(indexers.length)}</div>
          <div class="pwr-stat-label">Indexers</div>
        </div>
        <div class="pwr-stat pwr-stat--good">
          <div class="pwr-stat-value">${fmtNum(enabled)}</div>
          <div class="pwr-stat-label">Enabled</div>
        </div>
        <div class="pwr-stat pwr-stat--warn">
          <div class="pwr-stat-value">${fmtNum(disabled)}</div>
          <div class="pwr-stat-label">Disabled</div>
        </div>
        <div class="pwr-stat">
          <div class="pwr-stat-value">${fmtNum(torrent)}</div>
          <div class="pwr-stat-label">Torrent</div>
        </div>
        <div class="pwr-stat pwr-stat--warn">
          <div class="pwr-stat-value">${fmtNum(failedIndexers)}</div>
          <div class="pwr-stat-label">Failed Indexers</div>
        </div>
        <div class="pwr-stat pwr-stat--active">
          <div class="pwr-stat-value">${fmtNum(totalGrabs)}</div>
          <div class="pwr-stat-label">Total Grabs</div>
        </div>
        <div class="pwr-stat">
          <div class="pwr-stat-value">${fmtNum(totalQueries)}</div>
          <div class="pwr-stat-label">Queries</div>
        </div>
        <div class="pwr-stat pwr-stat--warn">
          <div class="pwr-stat-value">${fmtNum(totalFails)}</div>
          <div class="pwr-stat-label">Failed Grabs</div>
        </div>
      </div>`;
  }

  /* ── Indexers ──────────────────────────────────── */
  function buildIndexers() {
    const indexers = _data.indexers;
    if (!indexers.length) return `<div class="pwr-empty">No indexers found</div>`;

    return `<div class="pwr-list">` + indexers.map(idx => {
      const proto = (idx.protocol || "").toLowerCase();
      const protoCls = proto === "torrent" ? "pwr-proto--torrent" : "pwr-proto--usenet";
      const statusCls = idx.enable ? "pwr-dot--enabled" : "pwr-dot--disabled";
      return `
      <div class="pwr-row">
        <span class="pwr-dot ${statusCls}"></span>
        <div class="pwr-row-body">
          <div class="pwr-row-title">${escH(idx.name)}</div>
          <div class="pwr-row-sub">${escH(idx.definitionName || "")}</div>
        </div>
        <div class="pwr-row-meta">
          <span class="pwr-proto ${protoCls}">${escH(proto)}</span>
        </div>
      </div>`;
    }).join("") + `</div>`;
  }

  /* ── History ──────────────────────────────────── */
  function buildHistory() {
    const history = _data.history;
    if (!history.length) return `<div class="pwr-empty">No history found</div>`;

    return `<div class="pwr-list">` + history.map(h => {
      const indexerName = _data.indexers.find(i => i.id === h.indexerId)?.name || `Indexer ${h.indexerId}`;
      const query = h.data?.query || "";
      const queryType = h.data?.queryType || h.eventType || "";
      const source = h.data?.source || "";
      const results = h.data?.queryResults != null ? `${h.data.queryResults} results` : "";
      const title = query
        ? `${query} (${queryType})`
        : queryType
          ? queryType.replace(/([a-z])([A-Z])/g, "$1 $2")
          : "RSS Fetch";
      const dotCls = h.successful ? "pwr-dot--enabled" : "pwr-dot--disabled";

      return `
      <div class="pwr-row">
        <span class="pwr-dot ${dotCls}"></span>
        <div class="pwr-row-body">
          <div class="pwr-row-title">${escH(title)}</div>
          <div class="pwr-row-sub">${escH(indexerName)} · ${escH(source)}${results ? ` · ${results}` : ""}</div>
        </div>
        <div class="pwr-row-meta">
          <span class="pwr-time">${fmtTime(h.date)}</span>
        </div>
      </div>`;
    }).join("") + `</div>`;
  }

  /* ── Stats ──────────────────────────────────── */
  function buildStats() {
    const indexerStats = _data.stats?.indexers || [];
    if (!indexerStats.length) return `<div class="pwr-empty">No stats available</div>`;

    const sorted = [...indexerStats].sort((a, b) => (b.numberOfGrabs || 0) - (a.numberOfGrabs || 0));
    const maxGrabs = Math.max(...sorted.map(s => s.numberOfGrabs || 0), 1);

    return `<div class="pwr-list">` + sorted.map(s => {
      const pct = Math.round(((s.numberOfGrabs || 0) / maxGrabs) * 100);
      return `
      <div class="pwr-stat-row">
        <div class="pwr-stat-row-name">${escH(s.indexerName || "Unknown")}</div>
        <div class="pwr-stat-row-bars">
          <div class="pwr-bar-track">
            <div class="pwr-bar-fill" style="width:${pct}%"></div>
          </div>
          <span class="pwr-stat-row-count">${fmtNum(s.numberOfGrabs)} grabs</span>
        </div>
        <div class="pwr-stat-row-detail">
          <span>${fmtNum(s.numberOfQueries)} queries</span>
          <span class="pwr-stat-fail">${fmtNum(s.numberOfFailedGrabs)} failed</span>
        </div>
      </div>`;
    }).join("") + `</div>`;
  }

  /* ── Render ────────────────────────────────────── */
  function renderContent() {
    if (_tab === "overview") return buildOverview();
    if (_tab === "indexers") return buildIndexers();
    if (_tab === "history") return buildHistory();
    if (_tab === "stats") return buildStats();
    return buildOverview();
  }

  function paint(loading = false) {
    if (!_host) return;
    _host.innerHTML = buildShell(loading ? "" : renderContent(), loading);
    bindEvents();
  }

  function bindEvents() {
    if (!_host) return;
    _host.querySelectorAll(".pwr-tab").forEach(btn => {
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
      _lastUpdated = new Date();
      paint(false);
    } catch (err) {
      console.error("[ProwlarrWidget]", err);
      if (_host) _host.innerHTML = buildShell(
        `<div class="pwr-empty" style="color:#f87171">Failed to load Prowlarr data</div>`, false);
    } finally {
      _rendering = false;
    }
  }

  /* ── Init ──────────────────────────────────────── */
  function init() {
    const start = () => setTimeout(() => {
      const group = findGroup(PWR_CONFIG.groupName);
      if (!group) return;
      _host = ensureHost(group);
      refresh();
      setInterval(() => {
        if (document.hidden) return;
        refresh();
      }, PWR_CONFIG.pollMs);
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
        if (!document.querySelector(".pwr-host .pwr-shell")) {
          const group = findGroup(PWR_CONFIG.groupName);
          if (!group) return;
          _host = ensureHost(group);
          refresh();
        }
      }, 700);
    }).observe(document.body, { childList: true, subtree: true });
  }

  init();
})();

