/* =====================================================
CHECKMK MONITOR  (host + service status)
===================================================== */
(function () {
  const CMK_CONFIG = {
    baseUrl: "http://YOUR_LOCAL_IP:PORT",
    fallbackUrl: "https://YOUR_TUNNEL_URL", // or null if not using a tunnel
    activeUrl: null,
    username: "YOUR_USERNAME",
    password: "YOUR_PASSWORD",
    siteName: "YOUR_CHECKMK_SITE_NAME", // Site name is created during the setup of the CheckMK server.
    groupName: "CHECKMK - MONITOR",
    pollMs: 120 * 1000,
    topProblems: 10,
    debug: false
  };

  // ── Guard flags (prevent observer re-entrancy) ──────
  let _rendering = false;
  let _observerPending = false;

  function log(...args) {
    if (CMK_CONFIG.debug) console.log("[Homepage CheckMK]", ...args);
  }

  function normalizeText(v) {
    return (v || "").replace(/\s+/g, " ").trim();
  }

  function escapeHtml(str = "") {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function cmkHeaders() {
    return {
      "Authorization": `Bearer ${CMK_CONFIG.username} ${CMK_CONFIG.password}`,
      "Accept": "application/json"
    };
  }

  function apiBase() {
    return `${CMK_CONFIG.baseUrl}/${CMK_CONFIG.siteName}/check_mk/api/1.0`;
  }

  async function fetchJson(path) {
    const candidates = [];
    if (CMK_CONFIG.activeUrl) candidates.push(CMK_CONFIG.activeUrl);
    if (!candidates.includes(CMK_CONFIG.baseUrl)) candidates.push(CMK_CONFIG.baseUrl);
    if (CMK_CONFIG.fallbackUrl && !candidates.includes(CMK_CONFIG.fallbackUrl)) candidates.push(CMK_CONFIG.fallbackUrl);

    let lastErr = null;
    for (const base of candidates) {
      try {
        const url = `${base}/${CMK_CONFIG.siteName}/check_mk/api/1.0${path}`;
        const res = await fetch(url, {
          headers: cmkHeaders(),
          signal: (() => { const c = new AbortController(); setTimeout(() => c.abort(), 8000); return c.signal; })()
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(`CMK ${res.status} — ${body.substring(0, 120)}`);
        }
        CMK_CONFIG.activeUrl = base;
        return res.json();
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error("All URLs failed for CheckMK");
  }

  async function fetchHostStats() {
    const data = await fetchJson(
      `/domain-types/host/collections/all?columns=name&columns=state&columns=acknowledged`
    );
    const hosts = data.value || [];
    const stats = { up: 0, down: 0, unreach: 0, unknown: 0, total: 0 };
    hosts.forEach(h => {
      const ext = h.extensions || {};
      stats.total++;
      const s = ext.state ?? ext.host_state ?? -1;
      if (s === 0) stats.up++;
      else if (s === 1) stats.down++;
      else if (s === 2) stats.unreach++;
      else stats.unknown++;
    });
    return { stats, hosts };
  }

  async function fetchServiceProblems() {
    const cols = [
      "columns=host_name",
      "columns=description",
      "columns=state",
      "columns=plugin_output",
      "columns=acknowledged",
      "columns=last_state_change"
    ].join("&");
    const query = encodeURIComponent(
      JSON.stringify({ "op": "!=", "left": "state", "right": "0" })
    );
    const data = await fetchJson(
      `/domain-types/service/collections/all?${cols}&query=${query}`
    );
    return data.value || [];
  }

  function stateLabel(s) {
    return (["OK", "WARN", "CRIT", "UNKNOWN"])[s] ?? "?";
  }

  function stateColor(s) {
    return (["#6ee7b7", "#fbbf24", "#f87171", "#a78bfa"])[s] ?? "rgba(255,255,255,0.3)";
  }

  function timeSince(epoch) {
    if (!epoch) return "";
    const sec = Math.floor(Date.now() / 1000) - epoch;
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    return `${Math.floor(sec / 86400)}d ago`;
  }

  function buildSkeleton() {
    return `
      <div class="cmk-shell cmk-shell--loading">
        <div class="cmk-skeleton-wrap">
          <div class="cmk-skeleton-row"></div>
          <div class="cmk-skeleton-row"></div>
          <div class="cmk-skeleton-row"></div>
          <div class="cmk-skeleton-row"></div>
        </div>
      </div>`;
  }

  function buildError(msg) {
    return `
      <div class="cmk-shell cmk-shell--error">
        <div class="cmk-error">
          <div class="cmk-error-title">CheckMK Unavailable</div>
          <div class="cmk-error-msg">${escapeHtml(msg)}</div>
          <div class="cmk-error-hint">API URL: ${escapeHtml(apiBase())}</div>
        </div>
      </div>`;
  }

  function buildStatPill(label, value, color) {
    return `
      <div class="cmk-stat-pill">
        <span class="cmk-stat-dot" style="background:${color};box-shadow:0 0 5px ${color}40;"></span>
        <span class="cmk-stat-num" style="color:${color};">${value}</span>
        <span class="cmk-stat-lbl">${escapeHtml(label)}</span>
      </div>`;
  }

  function buildServiceRow(svc) {
    const ext = svc.extensions || {};
    const state = ext.state ?? 1;
    const color = stateColor(state);
    const label = stateLabel(state);
    const host = escapeHtml(ext.host_name || "?");
    const desc = escapeHtml(ext.description || ext.service_description || "?");
    const out = escapeHtml((ext.plugin_output || "").substring(0, 90));
    const when = timeSince(ext.last_state_change);
    const acked = ext.acknowledged ? " ✓" : "";
    return `
      <div class="cmk-svc-row">
        <div class="cmk-svc-left">
          <div class="cmk-svc-dot" style="background:${color};box-shadow:0 0 4px ${color}50;"></div>
          <div class="cmk-svc-body">
            <div class="cmk-svc-title">${host} — ${desc}${acked}</div>
            <div class="cmk-svc-output">${out}</div>
          </div>
        </div>
        <div class="cmk-svc-right">
          <div class="cmk-svc-chip" style="color:${color};border-color:${color}40;">${label}</div>
          ${when ? `<div class="cmk-svc-when">${escapeHtml(when)}</div>` : ""}
        </div>
      </div>`;
  }

  function buildShell(hostData, serviceProblems) {
    const { stats } = hostData;
    const problems = serviceProblems.filter(s => (s.extensions?.state ?? 1) !== 0);
    const crits = problems.filter(s => (s.extensions?.state ?? 1) === 2).length;
    const warns = problems.filter(s => (s.extensions?.state ?? 1) === 1).length;
    const unknowns = problems.filter(s => (s.extensions?.state ?? 1) === 3).length;
    const healthPct = stats.total ? Math.round((stats.up / stats.total) * 100) : 0;
    const overallOk = stats.down === 0 && stats.unreach === 0 && crits === 0;
    const overallColor = overallOk ? "#6ee7b7" : crits > 0 ? "#f87171" : "#fbbf24";
    const sorted = [...problems].sort(
      (a, b) => (b.extensions?.state ?? 1) - (a.extensions?.state ?? 1)
    );
    const displayProblems = sorted.slice(0, CMK_CONFIG.topProblems);
    const cmkUrl = `${CMK_CONFIG.baseUrl}/${CMK_CONFIG.siteName}/check_mk/`;

    return `
      <div class="cmk-shell">
        <div class="cmk-header">
          <div class="cmk-header-left">
            <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/webp/checkmk.webp"
                 alt="CheckMK" class="cmk-icon">
            <div>
              <div class="cmk-title">CheckMK</div>
            </div>
          </div>
          <a class="cmk-open-link" href="${escapeHtml(`${CMK_CONFIG.baseUrl}/${CMK_CONFIG.siteName}/check_mk/`)}"
             target="_blank" rel="noopener noreferrer">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
              <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
            Open
          </a>
        </div>
        <div class="cmk-host-overview">
          <div class="cmk-host-summary">
            <div class="cmk-host-big">
              <span class="cmk-host-num" style="color:${overallColor};">${stats.up}</span>
              <span class="cmk-host-denom">/ ${stats.total}</span>
            </div>
            <div class="cmk-host-label">Hosts UP</div>
            <div class="cmk-host-bar-wrap">
              <div class="cmk-host-bar-fill" style="width:${healthPct}%;background:${overallColor};"></div>
            </div>
          </div>
          <div class="cmk-host-pills">
            ${buildStatPill("Up", stats.up, "#6ee7b7")}
            ${buildStatPill("Down", stats.down, "#f87171")}
            ${buildStatPill("Unreach", stats.unreach, "#fb923c")}
            ${buildStatPill("Unknown", stats.unknown, "#a78bfa")}
          </div>
        </div>
        <div class="cmk-divider"></div>
        <div class="cmk-svc-header">
          <div class="cmk-section-label">Service problems</div>
          <div class="cmk-svc-chips">
            ${crits ? `<span class="cmk-chip" style="color:#f87171;border-color:#f8717140;">${crits} CRIT</span>` : ""}
            ${warns ? `<span class="cmk-chip" style="color:#fbbf24;border-color:#fbbf2440;">${warns} WARN</span>` : ""}
            ${unknowns ? `<span class="cmk-chip" style="color:#a78bfa;border-color:#a78bfa40;">${unknowns} UNKN</span>` : ""}
            ${!problems.length ? `<span class="cmk-chip" style="color:#6ee7b7;border-color:#6ee7b740;">All OK</span>` : ""}
          </div>
        </div>
        <div class="cmk-svc-list">
          ${displayProblems.length
        ? displayProblems.map(buildServiceRow).join("")
        : `<div class="cmk-all-ok">
                 <div class="cmk-all-ok-icon">✓</div>
                 <div class="cmk-all-ok-label">All services OK</div>
               </div>`
      }
        </div>
        <div class="cmk-footer">
          Updated ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true })}
        </div>
      </div>`;
  }

  function findGroupContainer() {
    const headings = Array.from(
      document.querySelectorAll("h2, h3, .group-title, .service-group-name")
    );
    const heading = headings.find(
      el => normalizeText(el.textContent) === CMK_CONFIG.groupName
    );
    if (!heading) { return null; }
    return (
      heading.closest("section") ||
      heading.closest("div[class*='group']") ||
      heading.parentElement?.parentElement ||
      heading.parentElement
    );
  }

  function ensureHost(group) {
    let host = group.querySelector(".cmk-monitor-host");
    if (host) return host;
    const existing = group.querySelector("ul.services-list, ul");
    if (existing) existing.style.display = "none";
    host = document.createElement("div");
    host.className = "cmk-monitor-host";
    group.appendChild(host);
    return host;
  }

  async function renderCmkMonitor() {
    // ── Hard re-entrancy guard ──────────────────────────
    if (_rendering) return;
    _rendering = true;

    try {
      const group = findGroupContainer();
      if (!group) return;
      const host = ensureHost(group);

      // Only show skeleton if the shell isn't already populated
      if (!host.querySelector(".cmk-shell:not(.cmk-shell--loading):not(.cmk-shell--error)")) {
        host.innerHTML = buildSkeleton();
      }

      const [hostData, serviceProblems] = await Promise.all([
        fetchHostStats(),
        fetchServiceProblems()
      ]);

      host.innerHTML = buildShell(hostData, serviceProblems);
      log("Render OK — hosts:", hostData.stats.total, "problems:", serviceProblems.length);

    } catch (err) {
      console.error("[Homepage CheckMK] Render error:", err);
      const group = findGroupContainer();
      if (group) {
        const host = ensureHost(group);
        host.innerHTML = buildError(err.message);
      }
    } finally {
      // Release the guard after a short cooldown so the DOM mutation
      // from innerHTML above can't immediately re-trigger us
      setTimeout(() => { _rendering = false; }, 2000);
    }
  }

  function init() {
    let _started = false;

    let _groupNotFoundLogged = false;
    function tryStart() {
      if (_started) return;
      const group = findGroupContainer();
      if (!group) {
        if (!_groupNotFoundLogged) {
          log("Group not found yet");
          _groupNotFoundLogged = true;
        }
        return;
      }
      _started = true;
      renderCmkMonitor();
      setInterval(() => {
        if (document.hidden) return;
        renderCmkMonitor();
      }, CMK_CONFIG.pollMs);
    }

    // Poll every 1.5s until the group appears
    const poller = setInterval(() => {
      tryStart();
      if (_started) clearInterval(poller);
    }, 1500);

    // ── Observer with double-guard: pending flag + host content check ──
    const observer = new MutationObserver(() => {
      if (_rendering || _observerPending) return;
      if (!_started) { tryStart(); return; }

      const host = document.querySelector(".cmk-monitor-host");
      if (host && host.querySelector(".cmk-shell")) return;

      _observerPending = true;
      setTimeout(() => {
        _observerPending = false;
        if (!_rendering) renderCmkMonitor();
      }, 500);
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  init();
})();