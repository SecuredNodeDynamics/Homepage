/* =====================================================
WAZUH SECURITY MONITOR
===================================================== */
(function () {
  const WZ_CONFIG = {
    baseUrl: "http://YOUR_LOCAL_IP:PORT",
    fallbackUrl: "https://YOUR_TUNNEL_URL", // or null if not using a tunnel
    activeUrl: null,
    dashboardUrl: "http://YOUR_LOCAL_IP:PORT",
    opensearchUrl: "https://YOUR_LOCAL_IP:9200",
    opensearchFallback: null,
    user: "YOUR_USERNAME",
    pass: "YOUR_PASSWORD",
    osUser: "YOUR_OPENSEARCH_USERNAME",
    osPass: "YOUR_OPENSEARCH_PASSWORD",
    groupName: "WAZUH-MONITOR",
    pollMs: 120 * 1000,
    debug: false
  };

  // ── Auth token cache ─────────────────────────────
  let _token = null;
  let _tokenExpiry = 0;

  // ── Alert UI state ───────────────────────────────
  let _alertTab = "all";
  let _alertAgent = "all";
  let _alertTimeRange = "24h";
  let _alertPage = 0;
  let _lastSortVal = null;
  const ALERT_PAGE_SIZE = 25;

  const ALERT_TABS = [
    { key: "all", label: "All" },
    { key: "syscheck", label: "File Integrity" },
    { key: "auth", label: "Auth" },
    { key: "system", label: "System" },
    { key: "vuln", label: "Vulnerabilities" },
  ];

  const TAB_GROUPS = {
    all: null,
    syscheck: ["syscheck"],
    auth: ["authentication_success", "authentication_failed", "sshd", "pam"],
    system: ["ossec", "rootcheck", "systemd", "syslog", "dpkg"],
    vuln: ["vulnerability-detector"],
  };

  const AGENT_LIST = ["all", "proxmox1", "proxmox2", "proxmox3", "TailscaleEXTND", "Zeek", "lab-detect-wazuh"];

  function log(...args) {
    if (WZ_CONFIG.debug) console.log("[Homepage Wazuh]", ...args);
  }

  function normalizeText(v) {
    return (v || "").replace(/\s+/g, " ").trim();
  }

  function escapeHtml(str = "") {
    return String(str)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function timeAgo(iso) {
    if (!iso) return "—";
    const diff = Math.floor((Date.now() - new Date(iso)) / 1000);
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  // ── DOM helpers ──────────────────────────────────
  function findGroupContainer() {
    const headings = Array.from(
      document.querySelectorAll("h2, h3, .group-title, .service-group-name")
    );
    const heading = headings.find(
      el => normalizeText(el.textContent) === WZ_CONFIG.groupName
    );
    if (!heading) { log("Group not found yet"); return null; }
    return (
      heading.closest("section") ||
      heading.closest("div[class*='group']") ||
      heading.parentElement?.parentElement ||
      heading.parentElement
    );
  }

  function ensureHost(group) {
    let row = group.querySelector(".wazuh-flex-row");
    if (!row) {
      const existing = group.querySelector("ul.services-list, ul");
      if (existing) existing.style.display = "none";
      row = document.createElement("div");
      row.className = "wazuh-flex-row";
      group.appendChild(row);
    }
    let host = row.querySelector(".wazuh-monitor-host");
    if (host) return host;
    host = document.createElement("div");
    host.className = "wazuh-monitor-host";
    row.appendChild(host);
    return host;
  }

  // ── Wazuh REST API ───────────────────────────────
  async function getToken() {
    if (_token && Date.now() < _tokenExpiry) return _token;
    const candidates = [];
    if (WZ_CONFIG.activeUrl) candidates.push(WZ_CONFIG.activeUrl);
    if (!candidates.includes(WZ_CONFIG.baseUrl)) candidates.push(WZ_CONFIG.baseUrl);
    if (WZ_CONFIG.fallbackUrl && !candidates.includes(WZ_CONFIG.fallbackUrl)) candidates.push(WZ_CONFIG.fallbackUrl);
    let lastErr = null;
    for (const base of candidates) {
      try {
        const res = await fetch(`${base}/security/user/authenticate`, {
          method: "POST",
          headers: {
            "Authorization": "Basic " + btoa(`${WZ_CONFIG.user}:${WZ_CONFIG.pass}`),
            "Content-Type": "application/json"
          },
          signal: (() => { const c = new AbortController(); setTimeout(() => c.abort(), 8000); return c.signal; })(),
        });
        if (!res.ok) throw new Error(`Wazuh auth failed: ${res.status}`);
        const data = await res.json();
        _token = data?.data?.token;
        if (!_token) throw new Error("No token in auth response");
        _tokenExpiry = Date.now() + 14 * 60 * 1000;
        WZ_CONFIG.activeUrl = base;
        return _token;
      } catch (err) {
        WZ_CONFIG.activeUrl = null;
        lastErr = err;
      }
    }
    throw lastErr || new Error("All URLs failed for Wazuh auth");
  }

  async function wzFetch(path) {
    const token = await getToken();
    const candidates = [];
    if (WZ_CONFIG.activeUrl) candidates.push(WZ_CONFIG.activeUrl);
    if (!candidates.includes(WZ_CONFIG.baseUrl)) candidates.push(WZ_CONFIG.baseUrl);
    if (WZ_CONFIG.fallbackUrl && !candidates.includes(WZ_CONFIG.fallbackUrl)) candidates.push(WZ_CONFIG.fallbackUrl);
    let lastErr = null;
    for (const base of candidates) {
      try {
        const res = await fetch(`${base}${path}`, {
          headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
          signal: (() => { const c = new AbortController(); setTimeout(() => c.abort(), 8000); return c.signal; })(),
        });
        if (res.status === 401) {
          _token = null; _tokenExpiry = 0;
          const token2 = await getToken();
          const res2 = await fetch(`${base}${path}`, {
            headers: { "Authorization": `Bearer ${token2}` },
            signal: (() => { const c = new AbortController(); setTimeout(() => c.abort(), 8000); return c.signal; })(),
          });
          if (!res2.ok) throw new Error(`Wazuh API ${res2.status}: ${path}`);
          WZ_CONFIG.activeUrl = base;
          return res2.json();
        }
        if (!res.ok) throw new Error(`Wazuh API ${res.status}: ${path}`);
        WZ_CONFIG.activeUrl = base;
        return res.json();
      } catch (err) {
        WZ_CONFIG.activeUrl = null;
        lastErr = err;
      }
    }
    throw lastErr || new Error("All URLs failed for Wazuh");
  }

  // ── OpenSearch ───────────────────────────────────
  async function osFetch(body) {
    const candidates = [WZ_CONFIG.opensearchUrl, WZ_CONFIG.opensearchFallback].filter(Boolean);
    const auth = "Basic " + btoa(`${WZ_CONFIG.osUser}:${WZ_CONFIG.osPass}`);
    let lastErr = null;
    for (const base of candidates) {
      try {
        const res = await fetch(`${base}/wazuh-alerts-4.x-*/_search`, {
          method: "POST",
          headers: {
            "Authorization": auth,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) throw new Error(`OpenSearch ${res.status}`);
        return res.json();
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error("OpenSearch unavailable");
  }

  // ── Alerts fetch ─────────────────────────────────
  async function fetchAlerts(loadMore = false) {
    if (!loadMore) _lastSortVal = null;

    const must = [];
    const groups = TAB_GROUPS[_alertTab];
    if (groups) {
      must.push({ terms: { "rule.groups": groups } });
    }
    if (_alertAgent !== "all") {
      must.push({ term: { "agent.name": _alertAgent } });
    }
    const rangeMs = _alertTimeRange === "24h" ? 24 * 60 * 60 * 1000
      : _alertTimeRange === "7d" ? 7 * 24 * 60 * 60 * 1000
        : 30 * 24 * 60 * 60 * 1000;
    must.push({ range: { "timestamp": { gte: new Date(Date.now() - rangeMs).toISOString() } } });

    const body = {
      size: ALERT_PAGE_SIZE,
      sort: [{ "timestamp": { order: "desc" } }],
      _source: ["timestamp", "rule.id", "rule.description", "rule.level", "rule.groups", "agent.name", "agent.ip"],
      collapse: { field: "rule.id" },
      query: must.length ? { bool: { must } } : { match_all: {} },
      aggs: {
        by_level: {
          range: {
            field: "rule.level",
            ranges: [
              { key: "low", from: 1, to: 7 },
              { key: "medium", from: 7, to: 11 },
              { key: "high", from: 11, to: 14 },
              { key: "critical", from: 14, to: 20 },
            ]
          }
        }
      }
    };

    if (_lastSortVal) {
      body.search_after = _lastSortVal;
      delete body.aggs; // skip re-aggregating on load more
    }

    const data = await osFetch(body);
    const hits = data?.hits?.hits || [];
    const total = data?.hits?.total?.value || 0;
    const buckets = data?.aggregations?.by_level?.buckets || [];
    const counts = {};
    buckets.forEach(b => { counts[b.key] = b.doc_count; });

    if (hits.length) {
      _lastSortVal = hits[hits.length - 1].sort;
    }

    return { hits: hits.map(h => h._source), counts, total, hasMore: hits.length === ALERT_PAGE_SIZE };
  }

  // ── Agent summary ────────────────────────────────
  async function fetchAgentsSummary() {
    try {
      const data = await wzFetch("/agents/summary/status");
      const outer = data?.data?.data ?? data?.data ?? {};
      const conn = outer.connection ?? outer;
      const cfg = outer.configuration ?? {};
      const active = conn.active ?? 0;
      const disconnected = conn.disconnected ?? 0;
      const never_connected = conn.never_connected ?? cfg.never_connected ?? 0;
      const pending = conn.pending ?? cfg.pending ?? 0;
      const total = outer.total ?? (active + disconnected + never_connected + pending);
      return { total, active, disconnected, never_connected, pending };
    } catch (e) {
      log("Summary endpoint failed:", e.message);
      return null;
    }
  }

  async function fetchAgents() {
    const data = await wzFetch("/agents?limit=500&sort=-dateAdd&status=active,disconnected");
    return data?.data?.data?.affected_items ?? data?.data?.affected_items ?? [];
  }

  // ── Severity helpers ─────────────────────────────
  function sevInfo(level) {
    const l = Number(level) || 0;
    if (l >= 14) return { label: "Critical", color: "#f87171", bg: "rgba(248,113,113,0.12)", border: "rgba(248,113,113,0.30)" };
    if (l >= 11) return { label: "High", color: "#fb923c", bg: "rgba(251,146,60,0.12)", border: "rgba(251,146,60,0.30)" };
    if (l >= 7) return { label: "Medium", color: "#fbbf24", bg: "rgba(251,191,36,0.12)", border: "rgba(251,191,36,0.30)" };
    return { label: "Low", color: "#6ee7b7", bg: "rgba(110,231,183,0.10)", border: "rgba(110,231,183,0.25)" };
  }

  // ── HTML builders ────────────────────────────────
  function buildSkeleton() {
    return `<div class="wz-skeleton-wrap">${Array.from({ length: 4 }, () => `<div class="wz-skeleton-row"></div>`).join("")}</div>`;
  }

  function buildError(msg) {
    return `
      <div class="wz-error">
        <div class="wz-error-title">Wazuh Unavailable</div>
        <div class="wz-error-msg">${escapeHtml(msg)}</div>
        <div class="wz-error-hint">${escapeHtml(WZ_CONFIG.baseUrl)}</div>
      </div>`;
  }

  function buildAgentCard(agent) {
    const isActive = agent.status === "active";
    const color = isActive ? "#6ee7b7" : "#f87171";
    const name = escapeHtml(agent.name || agent.id || "?");
    const os = escapeHtml(agent?.os?.name || agent?.os?.platform || "");
    const ip = escapeHtml(agent?.ip || "");
    const ver = escapeHtml(agent?.version || "");
    return `
      <div class="wz-agent-card"
           style="--ac-bg:${isActive ? "rgba(110,231,183,0.06)" : "rgba(248,113,113,0.06)"};
                  --ac-border:${isActive ? "rgba(110,231,183,0.18)" : "rgba(248,113,113,0.18)"};"
           title="${name}${ip ? " · " + ip : ""}${ver ? " · " + ver : ""}">
        <div class="wz-agent-count" style="color:${color};">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="display:block;margin:0 auto 2px;">
            <rect x="2" y="3" width="20" height="14" rx="2"/>
            <line x1="8" y1="21" x2="16" y2="21"/>
            <line x1="12" y1="17" x2="12" y2="21"/>
          </svg>
        </div>
        <div class="wz-agent-name">${name}</div>
        ${os ? `<div class="wz-agent-name" style="font-size:.60rem;opacity:.50;">${os}</div>` : ""}
        ${ip ? `<div class="wz-agent-name" style="font-size:.58rem;opacity:.35;font-family:monospace;">${ip}</div>` : ""}
      </div>`;
  }

  function buildAlertRow(alert) {
    const sev = sevInfo(alert?.rule?.level);
    const desc = escapeHtml(alert?.rule?.description || "Unknown rule");
    const agent = escapeHtml(alert?.agent?.name || "?");
    const ip = escapeHtml(alert?.agent?.ip || "");
    const ruleId = escapeHtml(String(alert?.rule?.id || ""));
    const groups = (alert?.rule?.groups || []);
    const ago = timeAgo(alert?.timestamp);

    const groupColors = {
      syscheck: { color: "#818cf8", bg: "rgba(129,140,248,0.12)", border: "rgba(129,140,248,0.28)" },
      authentication_success: { color: "#6ee7b7", bg: "rgba(110,231,183,0.12)", border: "rgba(110,231,183,0.28)" },
      authentication_failed: { color: "#f87171", bg: "rgba(248,113,113,0.12)", border: "rgba(248,113,113,0.28)" },
      sshd: { color: "#38bdf8", bg: "rgba(56,189,248,0.12)", border: "rgba(56,189,248,0.28)" },
      pam: { color: "#38bdf8", bg: "rgba(56,189,248,0.12)", border: "rgba(56,189,248,0.28)" },
      ossec: { color: "#fb923c", bg: "rgba(251,146,60,0.12)", border: "rgba(251,146,60,0.28)" },
      rootcheck: { color: "#fbbf24", bg: "rgba(251,191,36,0.12)", border: "rgba(251,191,36,0.28)" },
      systemd: { color: "#a78bfa", bg: "rgba(167,139,250,0.12)", border: "rgba(167,139,250,0.28)" },
      syslog: { color: "#94a3b8", bg: "rgba(148,163,184,0.12)", border: "rgba(148,163,184,0.28)" },
      dpkg: { color: "#34d399", bg: "rgba(52,211,153,0.12)", border: "rgba(52,211,153,0.28)" },
      "vulnerability-detector": { color: "#f472b6", bg: "rgba(244,114,182,0.12)", border: "rgba(244,114,182,0.28)" },
    };

    const badgesHtml = groups.map(g => {
      const c = groupColors[g] || { color: "rgba(255,255,255,0.45)", bg: "rgba(255,255,255,0.07)", border: "rgba(255,255,255,0.12)" };
      return `<span class="wz-group-badge" style="color:${c.color};background:${c.bg};border-color:${c.border};">${escapeHtml(g)}</span>`;
    }).join("");

    return `
      <div class="wz-alert-row" style="--row-bg:${sev.bg};--row-border:${sev.border};">
        <div class="wz-alert-left">
          <div class="wz-alert-dot" style="background:${sev.color};box-shadow:0 0 5px ${sev.color}80;margin-top:4px;"></div>
          <div class="wz-alert-body">
            <div class="wz-alert-rule">${desc}</div>
            <div class="wz-alert-meta">
              <span class="wz-agent-badge">${agent}${ip ? " · " + ip : ""}</span>
              ${ruleId ? `<span class="wz-rule-id">Rule ${ruleId}</span>` : ""}
            </div>
            ${badgesHtml ? `<div class="wz-group-badges">${badgesHtml}</div>` : ""}
          </div>
        </div>
        <div class="wz-alert-right">
          <span class="wz-sev-chip" style="color:${sev.color};background:${sev.bg};border-color:${sev.border};">${sev.label}</span>
          <span class="wz-alert-time">${ago}</span>
        </div>
      </div>`;
  }

  function buildAlertsPanel(alertResult) {
    const { hits, counts, total, hasMore } = alertResult || { hits: [], counts: {}, total: 0, hasMore: false };

    const sevPills = [
      { key: "critical", label: "Critical", color: "#f87171", bg: "rgba(248,113,113,0.12)", border: "rgba(248,113,113,0.28)" },
      { key: "high", label: "High", color: "#fb923c", bg: "rgba(251,146,60,0.12)", border: "rgba(251,146,60,0.28)" },
      { key: "medium", label: "Medium", color: "#fbbf24", bg: "rgba(251,191,36,0.10)", border: "rgba(251,191,36,0.25)" },
      { key: "low", label: "Low", color: "#6ee7b7", bg: "rgba(110,231,183,0.08)", border: "rgba(110,231,183,0.22)" },
    ].filter(s => counts[s.key] > 0);

    const pillsHtml = sevPills.length
      ? sevPills.map(s => `
          <div class="wz-pill" style="--pill-bg:${s.bg};--pill-border:${s.border};--pill-color:${s.color};">
            <div class="wz-pill-dot" style="background:${s.color};box-shadow:0 0 4px ${s.color}90;"></div>
            <span class="wz-pill-count">${counts[s.key].toLocaleString()}</span>
            <span class="wz-pill-label">${s.label}</span>
          </div>`).join("")
      : `<span style="font-size:0.68rem;color:rgba(255,255,255,0.28);">No alerts in range</span>`;

    const tabsHtml = ALERT_TABS.map(t => `
      <button class="wz-atab ${_alertTab === t.key ? "wz-atab--active" : ""}" data-tab="${t.key}">
        ${t.label}
      </button>`).join("");

    const agentOpts = AGENT_LIST.map(a =>
      `<option value="${a}" ${_alertAgent === a ? "selected" : ""}>${a === "all" ? "All agents" : escapeHtml(a)}</option>`
    ).join("");

    const listHtml = hits.length
      ? hits.map(buildAlertRow).join("")
      : `<div class="wz-empty">No alerts for this filter</div>`;

    return `
      <div class="wz-alerts-panel">
        <div class="wz-section-label">Alert Summary</div>
        <div class="wz-summary-pills" style="margin-bottom:2px;">${pillsHtml}</div>

        <div class="wz-alert-toolbar">
          <div class="wz-atabs">${tabsHtml}</div>
          <div class="wz-alert-controls">
            <div class="wz-time-toggle">
              <button class="wz-ttog ${_alertTimeRange === "24h" ? "wz-ttog--active" : ""}" data-range="24h">24h</button>
              <button class="wz-ttog ${_alertTimeRange === "7d" ? "wz-ttog--active" : ""}" data-range="7d">7d</button>
              <button class="wz-ttog ${_alertTimeRange === "30d" ? "wz-ttog--active" : ""}" data-range="30d">30d</button>
            </div>
            <select class="wz-agent-select" id="wz-agent-sel">${agentOpts}</select>
          </div>
        </div>

        <div class="wz-alert-list" id="wz-alert-list">
          ${listHtml}
        </div>

        ${hasMore ? `
          <button class="wz-load-more" id="wz-load-more">
            Load more <span style="opacity:.5;font-weight:400;">(${total.toLocaleString()} total)</span>
          </button>` : ""}
      </div>`;
  }

  function buildShell(summary, agents, alertResult) {
    const sorted = [...agents].sort((a, b) => (a.status === "active" ? -1 : 1)).slice(0, 24);
    const healthPct = summary.total ? Math.round((summary.active / summary.total) * 100) : 0;
    const overallOk = summary.disconnected === 0 && summary.active === summary.total;
    const overallColor = overallOk ? "#6ee7b7" : summary.disconnected > 0 ? "#fb923c" : "#6ee7b7";

    return `
      <div class="wz-shell">

        <!-- Header -->
        <div class="wz-hdr">
          <div class="wz-hdr-left">
            <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/webp/wazuh.webp" alt="Wazuh" class="wz-icon">
            <div>
              <div class="wz-title">Wazuh</div>
            </div>
          </div>
          <a class="wz-open-link" href="${escapeHtml(WZ_CONFIG.dashboardUrl)}" target="_blank" rel="noopener noreferrer">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
              <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
            Open
          </a>
        </div>

        <!-- Agent summary bar -->
        <div class="wz-summary-bar">
          <div class="wz-summary-total">
            <span class="wz-total-num" style="color:${overallColor};">${summary.active}</span>
            <span class="wz-total-label">/ ${summary.total} agents active</span>
          </div>
          <div class="wz-summary-pills">
            ${summary.active ? `
              <div class="wz-pill" style="--pill-bg:rgba(110,231,183,0.10);--pill-border:rgba(110,231,183,0.22);--pill-color:#6ee7b7;">
                <div class="wz-pill-dot" style="background:#6ee7b7;box-shadow:0 0 5px #6ee7b780;"></div>
                <span class="wz-pill-count">${summary.active}</span>
                <span class="wz-pill-label">Online</span>
              </div>` : ""}
            ${summary.disconnected ? `
              <div class="wz-pill" style="--pill-bg:rgba(248,113,113,0.10);--pill-border:rgba(248,113,113,0.22);--pill-color:#f87171;">
                <div class="wz-pill-dot" style="background:#f87171;box-shadow:0 0 4px #f8717180;"></div>
                <span class="wz-pill-count">${summary.disconnected}</span>
                <span class="wz-pill-label">Offline</span>
              </div>` : ""}
            ${summary.never_connected ? `
              <div class="wz-pill" style="--pill-bg:rgba(251,146,60,0.08);--pill-border:rgba(251,146,60,0.20);--pill-color:#fb923c;">
                <div class="wz-pill-dot" style="background:#fb923c;"></div>
                <span class="wz-pill-count">${summary.never_connected}</span>
                <span class="wz-pill-label">Never</span>
              </div>` : ""}
            ${summary.pending ? `
              <div class="wz-pill" style="--pill-bg:rgba(251,191,36,0.08);--pill-border:rgba(251,191,36,0.20);--pill-color:#fbbf24;">
                <div class="wz-pill-dot" style="background:#fbbf24;"></div>
                <span class="wz-pill-count">${summary.pending}</span>
                <span class="wz-pill-label">Pending</span>
              </div>` : ""}
          </div>
        </div>

        <!-- Health bar -->
        <div style="height:4px;border-radius:999px;background:rgba(255,255,255,0.08);overflow:hidden;margin:-4px 0 4px;">
          <div style="height:100%;width:${healthPct}%;border-radius:999px;background:${overallColor};transition:width 0.4s ease;"></div>
        </div>

        <!-- Agent grid -->
        ${sorted.length ? `
          <div class="wz-section-label">
            Agents
            <span style="margin-left:6px;font-size:.65rem;color:rgba(255,255,255,0.25);font-weight:400;text-transform:none;letter-spacing:0;">
              ${agents.length} total
            </span>
          </div>
          <div class="wz-agent-grid">
            ${sorted.map(buildAgentCard).join("")}
          </div>` : `
          <div class="wz-empty">No agents found</div>`}

        <!-- Alerts panel -->
        ${buildAlertsPanel(alertResult)}

        <div class="wz-footer">
          Updated ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true })}
        </div>

      </div>`;
  }

  // ── Alert tab/filter interaction ─────────────────
  function bindAlertEvents(host) {
    host.querySelectorAll(".wz-atab").forEach(btn => {
      btn.addEventListener("click", () => {
        _alertTab = btn.dataset.tab;
        refreshAlerts(host);
      });
    });
    host.querySelectorAll(".wz-ttog").forEach(btn => {
      btn.addEventListener("click", () => {
        _alertTimeRange = btn.dataset.range;
        refreshAlerts(host);
      });
    });
    const sel = host.querySelector("#wz-agent-sel");
    if (sel) {
      sel.addEventListener("change", () => {
        _alertAgent = sel.value;
        refreshAlerts(host);
      });
    }
    const loadMore = host.querySelector("#wz-load-more");
    if (loadMore) {
      loadMore.addEventListener("click", () => {
        _alertPage++;
        refreshAlerts(host, true);
      });
    }
  }

  async function refreshAlerts(host, loadMore = false) {
    if (!loadMore) {
      _alertPage = 0;
      const list = host.querySelector("#wz-alert-list");
      if (list) list.innerHTML = `<div class="wz-empty" style="opacity:.5;">Loading…</div>`;
    } else {
      const btn = host.querySelector("#wz-load-more");
      if (btn) btn.textContent = "Loading…";
    }

    host.querySelectorAll(".wz-atab").forEach(b => {
      b.classList.toggle("wz-atab--active", b.dataset.tab === _alertTab);
    });
    host.querySelectorAll(".wz-ttog").forEach(b => {
      b.classList.toggle("wz-ttog--active", b.dataset.range === _alertTimeRange);
    });

    try {
      const alertResult = await fetchAlerts(loadMore);

      if (loadMore) {
        const list = host.querySelector("#wz-alert-list");
        if (list) list.insertAdjacentHTML("beforeend", alertResult.hits.map(buildAlertRow).join(""));
        const btn = host.querySelector("#wz-load-more");
        if (btn) {
          if (alertResult.hasMore) {
            btn.innerHTML = `Load more <span style="opacity:.5;font-weight:400;">(${alertResult.total.toLocaleString()} total)</span>`;
          } else {
            btn.remove();
          }
        }
      } else {
        const panel = host.querySelector(".wz-alerts-panel");
        if (panel) {
          const newPanel = document.createElement("div");
          newPanel.innerHTML = buildAlertsPanel(alertResult);
          panel.replaceWith(newPanel.firstElementChild);
          bindAlertEvents(host);
        }
      }
    } catch (err) {
      const list = host.querySelector("#wz-alert-list");
      if (list) list.innerHTML = `<div class="wz-empty" style="color:#f87171;">Failed to load alerts</div>`;
    }
  }

  // ── Main render ──────────────────────────────────
  let _rendering = false;
  let _observerPending = false;

  async function renderWazuhMonitor() {
    if (_rendering) return;
    _rendering = true;

    try {
      const group = findGroupContainer();
      if (!group) return;
      const host = ensureHost(group);

      if (!host.querySelector(".wz-shell")) {
        host.innerHTML = buildSkeleton();
      }

      let [summary, agents, alertResult] = await Promise.all([
        fetchAgentsSummary(),
        fetchAgents(),
        fetchAlerts(false).catch(e => { log("Alerts failed:", e.message); return { hits: [], counts: {}, total: 0, hasMore: false }; }),
      ]);

      if (!summary) {
        const active = agents.filter(a => a.status === "active").length;
        const disconnected = agents.filter(a => a.status === "disconnected").length;
        const never_connected = agents.filter(a => a.status === "never_connected").length;
        const pending = agents.filter(a => a.status === "pending").length;
        summary = { total: agents.length, active, disconnected, never_connected, pending };
      }

      host.innerHTML = buildShell(summary, agents, alertResult);
      bindAlertEvents(host);

    } catch (err) {
      console.error("[Homepage Wazuh] Error:", err);
      const group = findGroupContainer();
      if (group) {
        const host = ensureHost(group);
        host.innerHTML = buildError(err.message);
      }
    } finally {
      setTimeout(() => { _rendering = false; }, 2000);
    }
  }

  function init() {
    const start = () => {
      setTimeout(renderWazuhMonitor, 3000);
      setInterval(() => {
        if (document.hidden) return;
        renderWazuhMonitor();
      }, WZ_CONFIG.pollMs);
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }

    const observer = new MutationObserver(() => {
      if (_rendering || _observerPending) return;
      const host = document.querySelector(".wazuh-monitor-host");
      if (host && host.querySelector(".wz-shell")) return;
      _observerPending = true;
      setTimeout(() => {
        _observerPending = false;
        if (!_rendering) renderWazuhMonitor();
      }, 500);
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  init();
})();