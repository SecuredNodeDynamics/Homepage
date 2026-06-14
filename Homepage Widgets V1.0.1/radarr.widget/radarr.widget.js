/* =====================================================
   RADARR WIDGET
   Group name: ARR — RADARR
===================================================== */
(function () {

  const RADARR_CONFIG = {
    groupName: "ARR — RADARR",
    servers: [
      { label: "Radarr", url: "http://YOUR_LOCAL_IP:PORT", fallbackUrl: "https://YOUR_TUNNEL_URL", activeUrl: null, key: "YOUR_API_KEY_HERE", href: "http://YOUR_LOCAL_IP:PORT" },
    ],
    pollMs: 120 * 1000,
  };

  function normText(v) { return (v || "").replace(/\s+/g, " ").trim(); }
  function escH(s = "") {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function fmtNum(n) { return n == null ? "—" : n.toLocaleString(); }

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

  function ensureHost(group, cls) {
    let host = group.querySelector("." + cls);
    if (host) return host;
    let row = group.querySelector(".hp-widget-row, .arr-flex-row");
    if (!row) {
      const list = group.querySelector("ul.services-list, ul");
      if (list) list.style.display = "none";
      row = document.createElement("div");
      row.className = "hp-widget-row arr-flex-row";
      group.appendChild(row);
    } else {
      row.classList.add("hp-widget-row", "arr-flex-row");
    }
    host = document.createElement("div");
    host.className = "arr-host " + cls;
    row.appendChild(host);
    return host;
  }

  async function fetchArr(server, path) {
    const candidates = [];
    if (server.activeUrl) candidates.push(server.activeUrl);
    if (!candidates.includes(server.url)) candidates.push(server.url);
    if (server.fallbackUrl && !candidates.includes(server.fallbackUrl)) candidates.push(server.fallbackUrl);

    let lastErr = null;
    for (const base of candidates) {
      try {
        const res = await fetch(`${base}${path}`, { signal: (() => { const c = new AbortController(); setTimeout(() => c.abort(), 8000); return c.signal; })() });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        server.activeUrl = base;
        return res.json();
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error(`All URLs failed for ${server.label}`);
  }

  async function fetchStats(server) {
    const [movies, queue, wanted] = await Promise.all([
      fetchArr(server, `/api/v3/movie?apikey=${server.key}`),
      fetchArr(server, `/api/v3/queue?apikey=${server.key}`),
      fetchArr(server, `/api/v3/wanted/missing?apikey=${server.key}&pageSize=1`),
    ]);
    return {
      movies: Array.isArray(movies) ? movies.length : 0,
      monitored: Array.isArray(movies) ? movies.filter(m => m.monitored).length : 0,
      queued: queue?.totalRecords ?? (Array.isArray(queue?.records) ? queue.records.length : 0),
      wanted: wanted?.totalRecords ?? 0,
    };
  }

  function buildStatsHtml(stats) {
    return `
      <div class="arr-stat-grid">
        <div class="arr-stat">
          <div class="arr-stat-value">${fmtNum(stats.movies)}</div>
          <div class="arr-stat-label">Movies</div>
        </div>
        <div class="arr-stat">
          <div class="arr-stat-value">${fmtNum(stats.monitored)}</div>
          <div class="arr-stat-label">Monitored</div>
        </div>
        <div class="arr-stat arr-stat--warn">
          <div class="arr-stat-value">${fmtNum(stats.wanted)}</div>
          <div class="arr-stat-label">Missing</div>
        </div>
        <div class="arr-stat arr-stat--active">
          <div class="arr-stat-value">${fmtNum(stats.queued)}</div>
          <div class="arr-stat-label">Queued</div>
        </div>
      </div>`;
  }

  function buildShell(activeIdx, statsHtml, loading) {
    const tabs = RADARR_CONFIG.servers.map((s, i) => `
      <button class="arr-tab radarr ${i === activeIdx ? "arr-tab--active" : ""}" data-idx="${i}">
        ${escH(s.label)}
      </button>`).join("");

    const activeServer = RADARR_CONFIG.servers[activeIdx];

    return `
      <div class="arr-shell">
        <div class="arr-hdr">
          <div class="arr-hdr-left">
            <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/webp/radarr.webp" class="arr-icon-img" alt="Radarr">
            <span class="arr-title">Radarr</span>
          </div>
          <div class="arr-tabs">${tabs}</div>
          <a class="arr-link radarr" href="${escH(activeServer.href)}" target="_blank" rel="noopener">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
              <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
            Open
          </a>
        </div>
        <div class="arr-stats">
          ${loading
            ? `<div class="arr-loading">
                <svg class="arr-spin" width="16" height="16" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" stroke-width="2">
                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83
                           M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
                </svg> Loading…</div>`
            : statsHtml}
        </div>
        <div class="arr-footer">${escH(activeServer.label)} · ${new Date().toLocaleTimeString()}</div>
      </div>`;
  }

  let _host = null;

  async function render(host, activeIdx) {
    host.innerHTML = buildShell(activeIdx, "", true);
    try {
      const stats = await fetchStats(RADARR_CONFIG.servers[activeIdx]);
      host.innerHTML = buildShell(activeIdx, buildStatsHtml(stats), false);
    } catch (err) {
      console.error("[Radarr Widget]", err);
      host.innerHTML = buildShell(activeIdx,
        `<div class="arr-error">Failed to load: ${escH(err.message)}</div>`, false);
    }
    host.querySelectorAll(".arr-tab").forEach(btn => {
      btn.addEventListener("click", () => render(host, parseInt(btn.dataset.idx)));
    });
  }

  function init() {
    const start = () => setTimeout(() => {
      const group = findGroup(RADARR_CONFIG.groupName);
      if (!group) return;
      _host = ensureHost(group, "arr-radarr-host");
      render(_host, 0);
      setInterval(() => {
        if (document.hidden) return;
        const activeIdx = parseInt(_host.querySelector(".arr-tab--active")?.dataset.idx ?? 0);
        render(_host, activeIdx);
      }, RADARR_CONFIG.pollMs);
    }, 1200);

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
        if (!document.querySelector(".arr-radarr-host .arr-shell")) {
          const group = findGroup(RADARR_CONFIG.groupName);
          if (!group) return;
          _host = ensureHost(group, "arr-radarr-host");
          render(_host, 0);
        }
      }, 600);
    }).observe(document.body, { childList: true, subtree: true });
  }

  init();
})();
