// ── UPTIME KUMA WIDGET ───────────────────────────────────────────────────
(function () {

  const UK_CONFIG = {
    groupName: "UK-MONITOR",
    primaryBaseUrl: "http://YOUR_LOCAL_IP:PORT",
    fallbackBaseUrl: "https://YOUR_TUNNEL_URL", // or null if not using a tunnel
    activeBaseUrl: null,
    pages: [
      {
        label: "UPTIME KUMA STATUS PAGE",
        slug: "UPTIME KUMA STATUS PAGE ID",
        primaryHref: "https://YOUR_LOCAL_IP:PORT/status/UPTIME KUMA STATUS PAGE ID",
        fallbackHref: "http://YOUR_TUNNEL_URL/status/UPTIME KUMA STATUS PAGE ID",
        icon: "☁️"
      },
    ],
    pollMs: 120 * 1000,
    debug: false
  };

  let _pageData = {};
  let _activeTab = UK_CONFIG.pages[0].slug;
  let _rendering = false;
  let _obsDelay = null;
  let _activeUkPopup = null;
  let _activeUkBackdrop = null;

  function log(...a) { if (UK_CONFIG.debug) console.log("[UptimeKuma]", ...a); }

  function esc(s = "") {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function normText(v) { return (v || "").replace(/\s+/g, " ").trim(); }

  function getUkTargets() {
    const targets = [];
    if (UK_CONFIG.activeBaseUrl) targets.push(UK_CONFIG.activeBaseUrl);
    if (UK_CONFIG.primaryBaseUrl && UK_CONFIG.primaryBaseUrl !== UK_CONFIG.activeBaseUrl) {
      targets.push(UK_CONFIG.primaryBaseUrl);
    }
    if (UK_CONFIG.fallbackBaseUrl && UK_CONFIG.fallbackBaseUrl !== UK_CONFIG.activeBaseUrl) {
      targets.push(UK_CONFIG.fallbackBaseUrl);
    }
    return targets;
  }

  async function fetchUk(path, timeout = 6000) {
    const targets = getUkTargets();
    let lastErr = null;

    for (const baseUrl of targets) {
      try {
        const res = await fetch(`${baseUrl}${path}`, {
          signal: AbortSignal.timeout(timeout)
        });

        if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);

        UK_CONFIG.activeBaseUrl = baseUrl;
        return res;
      } catch (err) {
        lastErr = err;
      }
    }

    throw lastErr || new Error(`Failed request for ${path}`);
  }

  function getPageHref(page) {
    if (UK_CONFIG.activeBaseUrl === UK_CONFIG.fallbackBaseUrl && page.fallbackHref) {
      return page.fallbackHref;
    }
    return page.primaryHref || page.fallbackHref || "#";
  }

  // ── DOM helpers ──────────────────────────────────────────────────
  function findGroupContainer() {
    const hd = Array.from(document.querySelectorAll("h2,h3,.group-title,.service-group-name"))
      .find(el => normText(el.textContent) === UK_CONFIG.groupName);
    if (!hd) return null;
    return hd.closest("section") || hd.closest("div[class*='group']") ||
      hd.parentElement?.parentElement || hd.parentElement;
  }

  function ensureHost(group) {
    let row = group.querySelector(".uk-flex-row");
    if (!row) {
      const list = group.querySelector("ul.services-list, ul");
      if (list) list.style.display = "none";
      row = document.createElement("div");
      row.className = "uk-flex-row";
      group.appendChild(row);
    }
    let host = row.querySelector(".uk-monitor-host");
    if (host) return host;
    host = document.createElement("div");
    host.className = "uk-monitor-host";
    row.appendChild(host);
    return host;
  }

  // ── API fetch ────────────────────────────────────────────────────
  async function fetchPage(page) {
    try {
      const [infoRes, hbRes] = await Promise.all([
        fetchUk(`/api/status-page/${page.slug}`, 6000),
        fetchUk(`/api/status-page/heartbeat/${page.slug}`, 6000)
      ]);

      if (!infoRes.ok || !hbRes.ok) {
        log(`${page.slug}: HTTP ${infoRes.status} / ${hbRes.status}`);
        return null;
      }

      const info = await infoRes.json();
      const hb = await hbRes.json();

      const groups = info.publicGroupList || [];
      const uptime = hb.uptimeList || {};
      const heartbeat = hb.heartbeatList || {};

      const monitors = [];
      for (const group of groups) {
        for (const mon of (group.monitorList || [])) {
          const hbList = heartbeat[mon.id] || [];
          const latest = hbList[hbList.length - 1];
          const status = latest?.status ?? -1;
          const up24 = uptime[`${mon.id}_24`] ?? null;
          const up7d = uptime[`${mon.id}_720`] ?? null;
          const up30d = uptime[`${mon.id}_1440`] ?? null;

          const recentBeats = hbList.slice(-20).map(b => ({
            status: b.status,
            time: b.time,
            msg: b.msg || "",
            ping: b.ping ?? null,
          }));

          const pings = recentBeats
            .filter(b => b.ping != null && b.ping > 0)
            .map(b => b.ping);
          const avgPing = pings.length
            ? Math.round(pings.reduce((a, b) => a + b, 0) / pings.length)
            : null;

          const lastCheck = latest?.time
            ? new Date(latest.time).toLocaleTimeString([], {
              hour: "2-digit", minute: "2-digit", second: "2-digit"
            })
            : null;

          monitors.push({
            id: mon.id,
            name: mon.name,
            type: mon.type || "",
            url: mon.url || "",
            status,
            up24,
            up7d,
            up30d,
            avgPing,
            lastCheck,
            lastMsg: latest?.msg || "",
            recentBeats,
            group: group.name || ""
          });
        }
      }

      log(`${page.slug}: ${monitors.length} monitors fetched`);
      return monitors;

    } catch (err) {
      log(`${page.slug} error:`, err.message);
      return null;
    }
  }

  // ── Status helpers ───────────────────────────────────────────────
  function statusLabel(s) {
    if (s === 1) return { text: "UP", cls: "uk-status--up" };
    if (s === 0) return { text: "DOWN", cls: "uk-status--down" };
    if (s === 2) return { text: "PENDING", cls: "uk-status--pending" };
    return { text: "—", cls: "uk-status--unknown" };
  }

  function statusDotColor(s) {
    if (s === 1) return "#4ade80";
    if (s === 0) return "#f87171";
    if (s === 2) return "#fbbf24";
    return "rgba(255,255,255,0.25)";
  }

  function uptimeBarColor(pct) {
    if (pct == null) return "rgba(255,255,255,0.15)";
    if (pct >= 99) return "#4ade80";
    if (pct >= 95) return "#fbbf24";
    return "#f87171";
  }

  function summaryForMonitors(monitors) {
    const up = monitors.filter(m => m.status === 1).length;
    const down = monitors.filter(m => m.status === 0).length;
    const pend = monitors.filter(m => m.status === 2).length;
    return { up, down, pend, total: monitors.length };
  }

  // ── Popup ────────────────────────────────────────────────────────
  function closeUkPopup() {
    if (_activeUkPopup) { _activeUkPopup.remove(); _activeUkPopup = null; }
    if (_activeUkBackdrop) { _activeUkBackdrop.remove(); _activeUkBackdrop = null; }
  }

  function openUkPopup(monitor, anchorEl) {
    closeUkPopup();

    const { text: statusText, cls: statusCls } = statusLabel(monitor.status);
    const dotColor = statusDotColor(monitor.status);
    const up24Pct = monitor.up24 != null ? monitor.up24 * 100 : null;
    const barColor = uptimeBarColor(up24Pct);

    const beatBars = monitor.recentBeats.map(b => {
      const c = b.status === 1 ? "#4ade80" : b.status === 0 ? "#f87171" : "#fbbf24";
      const title = b.time ? new Date(b.time).toLocaleTimeString() : "";
      return `<div title="${esc(title)}" style="
        flex:1;height:18px;border-radius:3px;
        background:${c};opacity:0.75;
        min-width:4px;max-width:12px;
      "></div>`;
    }).join("");

    const rows = [
      monitor.type ? { label: "Type", value: monitor.type.toUpperCase() } : null,
      monitor.url ? { label: "URL", value: monitor.url.replace(/^https?:\/\//, "").split("/")[0] } : null,
      monitor.avgPing != null ? { label: "Avg Ping", value: `${monitor.avgPing} ms` } : null,
      monitor.lastCheck ? { label: "Last Check", value: monitor.lastCheck } : null,
      monitor.up24 != null ? { label: "Uptime 24h", value: `${(monitor.up24 * 100).toFixed(2)}%` } : null,
      monitor.up7d != null ? { label: "Uptime 7d", value: `${(monitor.up7d * 100).toFixed(2)}%` } : null,
      monitor.up30d != null ? { label: "Uptime 30d", value: `${(monitor.up30d * 100).toFixed(2)}%` } : null,
    ].filter(Boolean);

    const rowsHtml = rows.map(r => `
      <div class="uk-popup__row">
        <span class="uk-popup__label">${esc(r.label)}</span>
        <span class="uk-popup__value">${esc(r.value)}</span>
      </div>`).join("");

    const lastMsgHtml = monitor.lastMsg ? `
      <div class="uk-popup__divider"></div>
      <div style="font-size:0.65rem;color:rgba(255,255,255,0.38);line-height:1.45;word-break:break-word;">
        ${esc(monitor.lastMsg)}
      </div>` : "";

    const beatBarsHtml = monitor.recentBeats.length ? `
      <div class="uk-popup__divider"></div>
      <div style="font-size:0.62rem;color:rgba(255,255,255,0.28);margin-bottom:5px;
                  text-transform:uppercase;letter-spacing:.06em;">Recent Checks</div>
      <div style="display:flex;gap:2px;align-items:flex-end;">${beatBars}</div>` : "";

    const uptimeBarHtml = up24Pct != null ? `
      <div class="uk-popup__uptime-bar-wrap">
        <div class="uk-popup__uptime-label">
          <span>24h Uptime</span>
          <span>${up24Pct.toFixed(2)}%</span>
        </div>
        <div class="uk-popup__uptime-track">
          <div class="uk-popup__uptime-fill"
               style="width:${up24Pct.toFixed(1)}%;background:${barColor};"></div>
        </div>
      </div>` : "";

    const activePage = UK_CONFIG.pages.find(p => p.slug === _activeTab);
    const statusPageHref = activePage ? getPageHref(activePage) : "#";

    const popup = document.createElement("div");
    popup.className = "uk-popup";
    popup.innerHTML = `
      <div class="uk-popup__body">
        <div class="uk-popup__header">
          <div class="uk-popup__dot"
               style="background:${dotColor};box-shadow:0 0 6px ${dotColor}80;"></div>
          <div class="uk-popup__name" title="${esc(monitor.name)}">${esc(monitor.name)}</div>
          <span class="uk-popup__badge ${statusCls}">${statusText}</span>
        </div>
        <div class="uk-popup__rows">${rowsHtml}</div>
        ${lastMsgHtml}
        ${beatBarsHtml}
        ${uptimeBarHtml}
        <a class="uk-popup__open-btn" href="${esc(statusPageHref)}"
           target="_blank" rel="noopener noreferrer">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2.5"
               stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
            <polyline points="15 3 21 3 21 9"/>
            <line x1="10" y1="14" x2="21" y2="3"/>
          </svg>
          Open Status Page
        </a>
      </div>`;

    document.body.appendChild(popup);
    const PW = popup.offsetWidth;
    const PH = popup.offsetHeight;
    const rect = anchorEl.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = rect.right + 8;
    if (left + PW > vw - 8) left = rect.left - PW - 8;
    if (left < 8) left = 8;

    let top = rect.top;
    if (top + PH > vh - 8) top = vh - PH - 8;
    if (top < 8) top = 8;

    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
    _activeUkPopup = popup;

    const backdrop = document.createElement("div");
    backdrop.className = "uk-popup-backdrop";
    backdrop.addEventListener("click", closeUkPopup);
    document.body.appendChild(backdrop);
    _activeUkBackdrop = backdrop;
  }

  // ── Build HTML ───────────────────────────────────────────────────
  function buildSummaryBar(monitors) {
    const { up, down, pend, total } = summaryForMonitors(monitors);
    const allUp = down === 0 && pend === 0 && total > 0;
    return `
      <div class="uk-summary-bar${allUp ? " uk-summary-bar--ok" : ""}">
        <span class="uk-summary-chip uk-summary-chip--up">
          <span class="uk-dot uk-dot--up"></span>${up} up
        </span>
        ${down ? `<span class="uk-summary-chip uk-summary-chip--down">
          <span class="uk-dot uk-dot--down"></span>${down} down
        </span>` : ""}
        ${pend ? `<span class="uk-summary-chip uk-summary-chip--pending">
          <span class="uk-dot uk-dot--pending"></span>${pend} pending
        </span>` : ""}
        <span class="uk-summary-total">${total} monitored</span>
        ${allUp ? `<span class="uk-all-ok">✓ All operational</span>` : ""}
      </div>`;
  }

  function buildMonitorRows(monitors) {
    if (!monitors.length) return `<div class="uk-empty">No monitors found</div>`;

    const grouped = {};
    for (const m of monitors) {
      const g = m.group || "Ungrouped";
      if (!grouped[g]) grouped[g] = [];
      grouped[g].push(m);
    }

    return Object.entries(grouped)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([groupName, mons]) => {
        mons.sort((a, b) => a.name.localeCompare(b.name));
        return `
          <div class="uk-group">
            <div class="uk-group-label">${esc(groupName)}</div>
            <div class="uk-monitor-grid">
              ${mons.map(m => {
          const { text, cls } = statusLabel(m.status);
          const uptime = m.up24 != null
            ? `<span class="uk-uptime">${(m.up24 * 100).toFixed(1)}%</span>`
            : "";
          const dataAttr = esc(JSON.stringify(m));
          return `
                  <div class="uk-monitor-row" data-monitor="${dataAttr}">
                    <div class="uk-monitor-left">
                      <span class="uk-status-dot ${cls === "uk-status--up" ? "uk-dot--up" : cls === "uk-status--down" ? "uk-dot--down" : "uk-dot--pending"}"></span>
                      <span class="uk-monitor-name">${esc(m.name)}</span>
                    </div>
                    <div class="uk-monitor-right">
                      ${uptime}
                      <span class="uk-status-badge ${cls}">${text}</span>
                    </div>
                  </div>`;
        }).join("")}
            </div>
          </div>`;
      }).join("");
  }

  function buildShell() {
    const tabs = UK_CONFIG.pages.map(p => `
      <button class="uk-tab${p.slug === _activeTab ? " uk-tab--active" : ""}"
              data-slug="${esc(p.slug)}" type="button">
        <span class="uk-tab-icon">${p.icon}</span>${esc(p.label)}
      </button>`).join("");

    const activePage = UK_CONFIG.pages.find(p => p.slug === _activeTab);
    const monitors = _pageData[_activeTab] || [];
    const loading = _pageData[_activeTab] === undefined;

    return `
      <div class="uk-shell">
        <div class="uk-header">
          <div class="uk-header-left">
            <img class="uk-icon-img" src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/webp/uptime-kuma.webp" alt="Uptime Kuma" />
            <div>
              <div class="uk-title">Uptime Kuma</div>
            </div>
          </div>
          <div class="uk-header-right">
            <div class="uk-tabs" id="uk-tabs">${tabs}</div>
            <button class="uk-refresh-btn" id="uk-refresh-btn" title="Refresh all monitors">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
                <path d="M23 4v6h-6M1 20v-6h6"/>
                <path d="M3.51 9a9 9 0 0114.36-3.36L23 10M1 14l5.13 4.36A9 9 0 0020.49 15"/>
              </svg>
            </button>
            <a class="uk-open-link" href="${esc(activePage ? getPageHref(activePage) : "#")}"
               target="_blank" rel="noopener" title="Open status page">
              Open
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                <polyline points="15 3 21 3 21 9"></polyline>
                <line x1="10" y1="14" x2="21" y2="3"></line>
              </svg>
            </a>
          </div>
        </div>

        <div class="uk-body" id="uk-body">
          ${loading
        ? buildSkeleton()
        : _pageData[_activeTab] === null
          ? buildError()
          : buildSummaryBar(monitors) + buildMonitorRows(monitors)}
        </div>

        <div class="uk-footer" id="uk-footer">
          Updated ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true })}
        </div>
      </div>`;
  }

  function buildSkeleton() {
    return Array(4).fill(0).map((_, i) => `
      <div class="uk-skeleton-row" style="animation-delay:${i * 0.1}s"></div>`
    ).join("");
  }

  function buildError() {
    return `<div class="uk-error"><span>⚠ Could not reach Uptime Kuma</span></div>`;
  }

  // ── DOM updates ──────────────────────────────────────────────────
  function updateBody(host) {
    const body = host.querySelector("#uk-body");
    const foot = host.querySelector("#uk-footer");
    if (!body) return;

    const monitors = _pageData[_activeTab];
    if (monitors === undefined) {
      body.innerHTML = buildSkeleton();
    } else if (monitors === null) {
      body.innerHTML = buildError();
    } else {
      body.innerHTML = buildSummaryBar(monitors) + buildMonitorRows(monitors);
    }

    if (foot) foot.textContent = `Updated ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true })}`;

    const link = host.querySelector(".uk-open-link");
    const page = UK_CONFIG.pages.find(p => p.slug === _activeTab);
    if (link && page) link.href = getPageHref(page);

    bindUkPopupEvents(host);
  }

  function bindUkPopupEvents(host) {
    host.querySelectorAll(".uk-monitor-row").forEach(row => {
      if (row._ukBound) return;
      row._ukBound = true;
      row.addEventListener("click", e => {
        e.stopPropagation();
        try {
          const monitor = JSON.parse(row.dataset.monitor || "{}");
          openUkPopup(monitor, row);
        } catch (err) {
          console.warn("[UptimeKuma] popup parse error", err);
        }
      });
    });
  }

  function bindTabs(host) {
    host.addEventListener("click", async e => {
      const btn = e.target.closest(".uk-tab");
      if (!btn) return;
      const slug = btn.dataset.slug;
      if (!slug || slug === _activeTab) return;

      closeUkPopup();
      _activeTab = slug;
      host.querySelectorAll(".uk-tab").forEach(t =>
        t.classList.toggle("uk-tab--active", t.dataset.slug === slug));

      updateBody(host);

      if (_pageData[slug] === undefined) {
        const page = UK_CONFIG.pages.find(p => p.slug === slug);
        if (page) {
          const data = await fetchPage(page);
          _pageData[slug] = data;
          updateBody(host);
        }
      }
    });

    const refreshBtn = host.querySelector("#uk-refresh-btn");
    if (refreshBtn && !refreshBtn._ukBound) {
      refreshBtn._ukBound = true;
      refreshBtn.addEventListener("click", async () => {
        refreshBtn.classList.add("uk-refresh-btn--spinning");
        refreshBtn.disabled = true;
        _pageData = {};
        try {
          await refresh(host);
          refreshBtn.classList.remove("uk-refresh-btn--spinning");
          refreshBtn.disabled = false;
          refreshBtn.classList.add("uk-refresh-btn--ok");
          refreshBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
          setTimeout(() => {
            refreshBtn.classList.remove("uk-refresh-btn--ok");
            refreshBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.36-3.36L23 10M1 14l5.13 4.36A9 9 0 0020.49 15"/></svg>`;
          }, 2500);
        } catch (err) {
          refreshBtn.classList.remove("uk-refresh-btn--spinning");
          refreshBtn.disabled = false;
          refreshBtn.classList.add("uk-refresh-btn--err");
          refreshBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
          setTimeout(() => {
            refreshBtn.classList.remove("uk-refresh-btn--err");
            refreshBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.36-3.36L23 10M1 14l5.13 4.36A9 9 0 0020.49 15"/></svg>`;
          }, 2500);
        }
      });
    }
  }

  // ── Refresh ──────────────────────────────────────────────────────
  async function refresh(host) {
    await Promise.all(UK_CONFIG.pages.map(async page => {
      const data = await fetchPage(page);
      _pageData[page.slug] = data;
    }));
    if (host) updateBody(host);
  }

  // ── Render ───────────────────────────────────────────────────────
  async function render() {
    if (_rendering) return;
    _rendering = true;
    try {
      const group = findGroupContainer();
      if (!group) return;
      const host = ensureHost(group);
      const first = !host.querySelector(".uk-shell");
      if (first) {
        host.innerHTML = buildShell();
        bindTabs(host);
      }
      await refresh(host);
    } catch (err) {
      console.error("[UptimeKuma] Render error:", err);
    } finally {
      setTimeout(() => { _rendering = false; }, 1500);
    }
  }

  // ── Init ─────────────────────────────────────────────────────────
  function init() {
    const start = () => {
      setTimeout(render, 1200);
      setInterval(() => {
        const g = findGroupContainer();
        const h = g?.querySelector(".uk-monitor-host");
        if (h) refresh(h);
      }, UK_CONFIG.pollMs);
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }

    document.addEventListener("keydown", e => {
      if (e.key === "Escape") closeUkPopup();
    });

    new MutationObserver(() => {
      if (_obsDelay || document.querySelector(".uk-monitor-host .uk-shell")) return;
      _obsDelay = setTimeout(() => { _obsDelay = null; render(); }, 600);
    }).observe(document.body, { childList: true, subtree: true });
  }

  init();

})();
