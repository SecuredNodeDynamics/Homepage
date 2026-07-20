/* =====================================================
   PROWLARR WIDGET
===================================================== */
(function () {

  const PWR_CONFIG = {
    groupName: "ARR -- PROWLARR",
    url: "http://YOUR_LOCAL_IP:PORT",
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
    let row = group.querySelector(".hp-widget-row, .arr-flex-row");
    if (!row) {
      const list = group.querySelector("ul.services-list, ul");
      if (list) list.style.display = "none";
      row = document.createElement("div");
      row.className = "hp-widget-row arr-flex-row";
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
  async function pwrRequest(path, options = {}) {
    const candidates = [];
    if (PWR_CONFIG.activeUrl) candidates.push(PWR_CONFIG.activeUrl);
    if (!candidates.includes(PWR_CONFIG.url)) candidates.push(PWR_CONFIG.url);
    if (PWR_CONFIG.fallbackUrl && !candidates.includes(PWR_CONFIG.fallbackUrl)) candidates.push(PWR_CONFIG.fallbackUrl);

    let lastErr = null;
    for (const base of candidates) {
      try {
        const res = await fetch(`${base}${path}`, {
          ...options,
          headers: {
            "X-Api-Key": PWR_CONFIG.key,
            ...(options.body ? { "Content-Type": "application/json" } : {}),
            ...(options.headers || {}),
          },
          signal: (() => { const c = new AbortController(); setTimeout(() => c.abort(), 15000); return c.signal; })(),
        });
        if (!res.ok) throw new Error(`Prowlarr ${res.status}: ${path}`);
        PWR_CONFIG.activeUrl = base;
        const text = await res.text();
        if (!text) return null;
        try { return JSON.parse(text); } catch { return text; }
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error("All URLs failed for Prowlarr");
  }

  async function pwrFetch(path) {
    return pwrRequest(path);
  }

  async function triggerAppSync() {
    return pwrRequest("/api/v1/command", {
      method: "POST",
      body: JSON.stringify({ name: "ApplicationIndexerSync" }),
    });
  }

  async function fetchAll() {
    const [indexers, stats, history, statuses] = await Promise.allSettled([
      pwrFetch("/api/v1/indexer"),
      pwrFetch("/api/v1/indexerstats"),
      pwrFetch("/api/v1/history?pageSize=20&sortKey=date&sortDirection=descending"),
      pwrFetch("/api/v1/indexerstatus"),
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
      statuses: statuses.status === "fulfilled"
        ? (Array.isArray(statuses.value) ? statuses.value : [])
        : [],
    };
  }

  /* Current failures = cooldown / disabledTill, not lifetime failed-query stats. */
  function isDisabledTillActive(disabledTill) {
    if (!disabledTill) return false;
    const until = new Date(disabledTill);
    return !isNaN(until) && until.getTime() > Date.now();
  }

  function getFailingIndexerIds() {
    const ids = new Set();
    for (const s of (_data.statuses || [])) {
      if (isDisabledTillActive(s.disabledTill)) ids.add(s.indexerId ?? s.id);
    }
    for (const idx of (_data.indexers || [])) {
      if (isDisabledTillActive(idx.status?.disabledTill)) ids.add(idx.id);
    }
    return ids;
  }

  function countFailingIndexers() {
    return getFailingIndexerIds().size;
  }

  /* ── State ─────────────────────────────────────── */
  let _tab = "overview";
  let _data = { indexers: [], stats: null, history: [], statuses: [] };
  let _host = null;
  let _rendering = false;
  let _lastUpdated = null;

  /* ── Shell ─────────────────────────────────────── */
  function getStatusPill() {
    const indexers = _data.indexers || [];
    const failing = countFailingIndexers();

    if (!_lastUpdated && !indexers.length) {
      return { cls: "pwr-status--idle", txt: "Connecting" };
    }
    if (failing > 0) {
      return { cls: "pwr-status--warn", txt: `${failing} Failing` };
    }
    return { cls: "pwr-status--active", txt: "Online" };
  }

  function buildShell(contentHtml, loading) {
    const tabs = [
      { key: "overview", label: "Overview" },
      { key: "indexers", label: "Indexers" },
      { key: "history", label: "History" },
      { key: "stats", label: "Stats" },
    ];

    const tabsHtml = tabs.map(t => `
      <button class="pwr-tab ${_tab === t.key ? "pwr-tab--active" : ""}" data-tab="${t.key}" type="button">
        ${t.label}
      </button>`).join("");

    const updatedStr = _lastUpdated ? _lastUpdated.toLocaleTimeString() : "";
    const status = getStatusPill();

    return `
      <div class="pwr-shell">
        <div class="pwr-hdr">
          <div class="pwr-hdr-left">
            <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/webp/prowlarr.webp" alt="Prowlarr" class="pwr-icon">
            <span class="pwr-title">Prowlarr</span>
          </div>
          <div class="pwr-hdr-right">
            <span class="pwr-status ${status.cls}">${escH(status.txt)}</span>
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
        <div class="pwr-controls">
          <div class="pwr-tabs">${tabsHtml}</div>
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
        <div class="pwr-footer">
          <span class="pwr-footer-meta">Prowlarr · ${updatedStr}</span>
          <button class="pwr-sync-btn" id="pwr-sync-btn" type="button" title="Sync indexers to connected apps">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="23 4 23 10 17 10"/>
              <polyline points="1 20 1 14 7 14"/>
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
            </svg>
            Sync
          </button>
        </div>
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
    const totalFailedGrabs = stats?.indexers?.reduce((a, s) => a + (s.numberOfFailedGrabs || 0), 0) ?? 0;
    const failingIndexers = countFailingIndexers();

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
        <div class="pwr-stat ${failingIndexers ? "pwr-stat--warn" : ""}">
          <div class="pwr-stat-value">${fmtNum(failingIndexers)}</div>
          <div class="pwr-stat-label">Failing Now</div>
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
          <div class="pwr-stat-value">${fmtNum(totalFailedGrabs)}</div>
          <div class="pwr-stat-label">Failed Grabs</div>
        </div>
      </div>`;
  }

  /* ── Indexers ──────────────────────────────────── */
  function buildIndexers() {
    const indexers = _data.indexers;
    if (!indexers.length) return `<div class="pwr-empty">No indexers found</div>`;
    const failingIds = getFailingIndexerIds();

    return `<div class="pwr-list">` + indexers.map(idx => {
      const proto = (idx.protocol || "").toLowerCase();
      const protoCls = proto === "torrent" ? "pwr-proto--torrent" : "pwr-proto--usenet";
      const failing = failingIds.has(idx.id);
      const statusCls = failing
        ? "pwr-dot--error"
        : idx.enable ? "pwr-dot--enabled" : "pwr-dot--disabled";
      const till = idx.status?.disabledTill
        || _data.statuses.find(s => (s.indexerId ?? s.id) === idx.id)?.disabledTill;
      const tillStr = till ? new Date(till).toLocaleString("en-US", {
        month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
      }) : "";
      const sub = failing
        ? (tillStr ? `Disabled till ${tillStr}` : "Currently failing")
        : (idx.definitionName || "");
      return `
      <div class="pwr-row">
        <span class="pwr-dot ${statusCls}"></span>
        <div class="pwr-row-body">
          <div class="pwr-row-title">${escH(idx.name)}</div>
          <div class="pwr-row-sub">${escH(sub)}</div>
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
    const syncBtn = _host.querySelector("#pwr-sync-btn");
    if (syncBtn) syncBtn.addEventListener("click", () => runManualSync(syncBtn));
  }

  async function runManualSync(btn) {
    if (_rendering || btn.disabled) return;
    _rendering = true;
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.classList.remove("pwr-sync-btn--ok", "pwr-sync-btn--err");
    btn.classList.add("pwr-sync-btn--busy");
    btn.innerHTML = `<svg class="pwr-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>Syncing…`;
    try {
      await triggerAppSync();
      _data = await fetchAll();
      _lastUpdated = new Date();
      paint(false);
      const freshBtn = _host?.querySelector("#pwr-sync-btn");
      if (freshBtn) {
        freshBtn.disabled = true;
        freshBtn.classList.add("pwr-sync-btn--ok");
        freshBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Synced`;
        setTimeout(() => {
          if (!_host) return;
          const b = _host.querySelector("#pwr-sync-btn");
          if (!b) return;
          b.classList.remove("pwr-sync-btn--ok", "pwr-sync-btn--busy", "pwr-sync-btn--err");
          b.disabled = false;
          b.innerHTML = original;
        }, 1800);
      }
    } catch (err) {
      console.error("[ProwlarrWidget] Sync failed:", err);
      btn.classList.remove("pwr-sync-btn--busy");
      btn.classList.add("pwr-sync-btn--err");
      btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>Failed`;
      setTimeout(() => {
        btn.classList.remove("pwr-sync-btn--err");
        btn.disabled = false;
        btn.innerHTML = original;
      }, 2000);
    } finally {
      _rendering = false;
    }
  }

  async function refresh() {
    if (_rendering) return;
    if (!_host) {
      const group = findGroup(PWR_CONFIG.groupName);
      if (!group) return;
      _host = ensureHost(group);
    }
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
      bindEvents();
    } finally {
      _rendering = false;
    }
  }

  HpWidgetBoot.watch("prowlarr", {
    ready: () => !!document.querySelector(".pwr-host .pwr-shell"),
    setup: () => setInterval(refresh, PWR_CONFIG.pollMs),
    mount: () => {
      const group = findGroup(PWR_CONFIG.groupName);
      if (!group) return;
      _host = ensureHost(group);
      refresh();
    },
  });
})();
