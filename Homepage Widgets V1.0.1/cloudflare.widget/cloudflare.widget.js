/* =====================================================
CLOUDFLARE TUNNEL WIDGET  v4
— Proxied through cf-proxy.YOUR_DOMAIN.com worker
— Group name: CLOUDFLARE - WIDGET
===================================================== */
(function () {

  const CF_CONFIG = {
    groupName: "CLOUDFLARE - WIDGET",
    proxyBase: "https://YOUR_TUNNEL_URL",
    accountId: "CLOUDFLARE_ACCOUNT_ID",
    tunnelId: "CLOUDFLARE_TUNNEL_ID",
    dashboardUrl: "https://dash.cloudflare.com/YOUR_TUNNEL_ID/home/overview",
    pollMs: 120 * 1000,
    debug: false
  };

  const TUNNEL_ORIGIN_MAP = {
    "CLOUDFLARE_TUNNEL_ID": "YOUR_PROXMOX_SERVER_ID", // You can find your Cloudflare Tunnel ID in your CLoudflare Dashboard
  };

  function log(...a) { if (CF_CONFIG.debug) console.log("[CF Widget]", ...a); }
  function normText(v) { return (v || "").replace(/\s+/g, " ").trim(); }
  function escH(s = "") {
    return String(s ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function fmtBig(n) {
    if (n == null || isNaN(n)) return "—";
    if (n === 0) return "0";
    if (n >= 1e12) return (n / 1e12).toFixed(2) + "T";
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(0) + "K";
    return String(n);
  }

  function fmtBytes(bytes) {
    if (bytes == null || bytes < 0) return "—";
    if (bytes === 0) return "0 B";
    if (bytes >= 1e12) return (bytes / 1e12).toFixed(2) + " TB";
    if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + " GB";
    if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + " MB";
    if (bytes >= 1e3) return (bytes / 1e3).toFixed(0) + " KB";
    return bytes + " B";
  }

  function fmtDate(isoStr) {
    if (!isoStr) return "—";
    try {
      return new Date(isoStr).toLocaleString("en-US", {
        month: "short", day: "numeric",
        hour: "2-digit", minute: "2-digit"
      });
    } catch (_) { return "—"; }
  }

  // ── DOM helpers ──────────────────────────────────────────────────
  function findGroupContainer() {
    const hd = Array.from(
      document.querySelectorAll("h2,h3,.group-title,.service-group-name")
    ).find(el => normText(el.textContent) === CF_CONFIG.groupName);
    if (!hd) return null;
    return (
      hd.closest("section") ||
      hd.closest("div[class*='group']") ||
      hd.parentElement?.parentElement ||
      hd.parentElement
    );
  }

  function ensureHost(group) {
    let host = group.querySelector(".cf-host");
    if (host) return host;
    let row = group.querySelector(".hp-widget-row, .cf-flex-row");
    if (!row) {
      const list = group.querySelector("ul.services-list, ul");
      if (list) list.style.display = "none";
      row = document.createElement("div");
      row.className = "hp-widget-row cf-flex-row";
      group.appendChild(row);
    } else {
      row.classList.add("hp-widget-row", "cf-flex-row");
    }
    host = document.createElement("div");
    host.className = "cf-host";
    row.appendChild(host);
    return host;
  }

  // ── Proxied API fetch ────────────────────────────────────────────
  async function cfFetch(path) {
    const url = `${CF_CONFIG.proxyBase}/?path=${encodeURIComponent(path)}`;
    log("Fetching:", path);
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) throw new Error(`Proxy HTTP ${res.status}: ${path}`);
    const data = await res.json();
    if (data.success === false) {
      const errMsg = data.errors?.[0]?.message || "CF API error";
      log("API error for", path, ":", errMsg, data.errors);
      throw new Error(errMsg);
    }
    return data;
  }

  // ── Data fetchers ────────────────────────────────────────────────
  async function fetchTunnel() {
    const data = await cfFetch(
      `/client/v4/accounts/${CF_CONFIG.accountId}/cfd_tunnel/${CF_CONFIG.tunnelId}`
    );
    return data.result;
  }

  async function fetchTunnelConnections() {
    try {
      const data = await cfFetch(
        `/client/v4/accounts/${CF_CONFIG.accountId}/cfd_tunnel/${CF_CONFIG.tunnelId}/connections`
      );
      // Flatten connector -> conns, injecting client_id onto each conn
      return (data.result || []).flatMap(connector =>
        (connector.conns || []).map(conn => ({
          ...conn,
          client_id: connector.id,
        }))
      );
    } catch (e) {
      log("connections fetch failed:", e.message);
      return [];
    }
  }

  async function fetchZones() {
    // Attempt 1: filter by account id using dot notation
    try {
      const data = await cfFetch(`/client/v4/zones?account.id=${CF_CONFIG.accountId}&per_page=50`);
      log("Zones attempt 1 (account.id):", data.result?.length, "result_info:", data.result_info);
      if (data.result?.length > 0) return data.result;
    } catch (e) {
      log("Zones attempt 1 failed:", e.message);
    }

    // Attempt 2: no filter — list all zones the token can see
    try {
      const data = await cfFetch(`/client/v4/zones?per_page=50`);
      log("Zones attempt 2 (no filter):", data.result?.length, "result_info:", data.result_info);
      if (data.result?.length > 0) return data.result;
    } catch (e) {
      log("Zones attempt 2 failed:", e.message);
    }

    // Attempt 3: account_id param
    try {
      const data = await cfFetch(`/client/v4/zones?account_id=${CF_CONFIG.accountId}&per_page=50`);
      log("Zones attempt 3 (account_id param):", data.result?.length);
      if (data.result?.length > 0) return data.result;
    } catch (e) {
      log("Zones attempt 3 failed:", e.message);
    }

    log("All zone fetch attempts failed — returning empty");
    return [];
  }

  // ── Zone analytics via GraphQL ───────────────────────────────────
  async function fetchZoneAnalytics(zoneId, zoneName) {
    const today = new Date().toISOString().split("T")[0];
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

    const query = `{
  viewer {
    zones(filter: { zoneTag: "${zoneId}" }) {
      httpRequests1dGroups(
        limit: 7,
        orderBy: [sum_requests_DESC],
        filter: { date_geq: "${weekAgo}", date_leq: "${today}" }
      ) {
        sum {
          requests
          bytes
          cachedRequests
          cachedBytes
          threats
        }
        uniq {
          uniques
        }
      }
    }
  }
}`;

    try {
      const url = `${CF_CONFIG.proxyBase}/?path=/client/v4/graphql`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(12000)
      });

      if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
      const data = await res.json();
      log(`Zone ${zoneName} GraphQL raw response:`, JSON.stringify(data));

      const groups = data?.data?.viewer?.zones?.[0]?.httpRequests1dGroups;
      if (!groups?.length) {
        log(`Zone ${zoneName}: no GraphQL data`);
        return null;
      }

      // Sum across all returned days
      const totals = groups.reduce((acc, g) => ({
        requests: (acc.requests || 0) + (g.sum.requests || 0),
        bytes: (acc.bytes || 0) + (g.sum.bytes || 0),
        cachedRequests: (acc.cachedRequests || 0) + (g.sum.cachedRequests || 0),
        threats: (acc.threats || 0) + (g.sum.threats || 0),
        uniques: (acc.uniques || 0) + (g.uniq.uniques || 0),
      }), {});

      log(`Zone ${zoneName} totals:`, totals);

      return {
        requests: { all: totals.requests, cached: totals.cachedRequests },
        bandwidth: { all: totals.bytes },
        uniques: { all: totals.uniques },
        threats: { all: totals.threats },
      };
    } catch (e) {
      log(`Zone ${zoneName} GraphQL failed:`, e.message);
      return null;
    }
  }

  // ── Status helpers ───────────────────────────────────────────────
  function tunnelStatusInfo(tunnel, connections) {
    const status = tunnel?.status || "unknown";
    const activeConns = connections.filter(c => c.is_pending_reconnect === false);
    if (status === "healthy" || (status !== "down" && activeConns.length > 0)) {
      return { cls: "cf-status-badge--healthy", text: "HEALTHY" };
    }
    if (status === "degraded") return { cls: "cf-status-badge--degraded", text: "DEGRADED" };
    if (status === "down") return { cls: "cf-status-badge--down", text: "DOWN" };
    if (status === "inactive") return { cls: "cf-status-badge--inactive", text: "INACTIVE" };
    return { cls: "cf-status-badge--unknown", text: "UNKNOWN" };
  }

  // ── HTML builders ────────────────────────────────────────────────
  function buildSkeleton() {
    return `
      <div class="cf-widget-host">
        <div class="cf-loading">
          <div class="cf-skeleton-line" style="width:55%;height:16px;"></div>
          <div class="cf-skeleton-line" style="width:100%;height:88px;margin-top:8px;"></div>
          <div class="cf-skeleton-line" style="width:100%;height:88px;margin-top:8px;"></div>
          <div class="cf-skeleton-line" style="width:75%;height:12px;margin-top:8px;"></div>
        </div>
      </div>`;
  }

  function buildError(msg) {
    return `
      <div class="cf-widget-host">
        <div class="cf-error">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
               stroke="rgba(255,255,255,0.40)" stroke-width="1.5">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="12"/>
            <line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <div style="font-size:0.80rem;color:rgba(255,255,255,0.55);">Cloudflare Unavailable</div>
          <div style="font-size:0.67rem;color:rgba(255,255,255,0.30);margin-top:2px;">${escH(msg)}</div>
        </div>
      </div>`;
  }

  function buildStatCard(label, value, sub, valueCls) {
    return `
      <div class="cf-stat">
        <div class="cf-stat__label">${escH(label)}</div>
        <div class="cf-stat__value${valueCls ? " " + valueCls : ""}">${escH(String(value))}</div>
        ${sub ? `<div class="cf-stat__sub">${escH(String(sub))}</div>` : ""}
      </div>`;
  }

  function buildConnections(connections) {
    const active = connections.filter(c => !c.is_pending_reconnect);
    const pending = connections.filter(c => c.is_pending_reconnect);

    if (!connections.length) {
      return `<div class="cf-connections">
        <div class="cf-conn" style="color:rgba(255,255,255,0.28);font-style:italic;">No connections recorded</div>
      </div>`;
    }

    // Deduplicate by client_id and sort by mapped name
    const dedupedActive = active
      .filter((c, i, arr) => arr.findIndex(x => x.client_id === c.client_id) === i)
      .sort((a, b) => {
        const nameA = TUNNEL_ORIGIN_MAP[a.client_id] || "";
        const nameB = TUNNEL_ORIGIN_MAP[b.client_id] || "";
        return nameA.localeCompare(nameB);
      });

    const dedupedPending = pending
      .filter((c, i, arr) => arr.findIndex(x => x.client_id === c.client_id) === i);

    return `
      <div class="cf-connections">
        ${dedupedActive.slice(0, 10).map(c => `
          <div class="cf-conn">
            <span class="cf-conn__dot cf-conn__dot--active"></span>
            <span>${escH(TUNNEL_ORIGIN_MAP[c.client_id] || c.colo_name || c.origin_ip || "edge")}</span>
          </div>`).join("")}
        ${dedupedPending.slice(0, 4).map(c => `
          <div class="cf-conn">
            <span class="cf-conn__dot cf-conn__dot--inactive"></span>
            <span>${escH(TUNNEL_ORIGIN_MAP[c.client_id] || c.colo_name || "reconnecting")}</span>
          </div>`).join("")}
        ${(dedupedActive.length + dedupedPending.length) > 14 ? `
          <div class="cf-conn" style="color:rgba(255,255,255,0.35);">+${(dedupedActive.length + dedupedPending.length) - 14} more</div>
        ` : ""}
      </div>`;
  }

  function buildZonesSection(zones, analyticsMap) {
    if (!zones.length) {
      return `
        <div class="cf-threats" style="margin-bottom:14px;">
          <div class="cf-threats__header">
            <div class="cf-threats__title">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"/>
                <line x1="2" y1="12" x2="22" y2="12"/>
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
              </svg>
              Managed Zones
            </div>
            <span class="cf-threats__count">0</span>
          </div>
          <div style="font-size:0.68rem;color:rgba(255,255,255,0.30);padding:6px 0;">
            No zones found — ensure API token has Zone:Read permission
          </div>
        </div>`;
    }

    return `
      <div class="cf-threats" style="margin-bottom:14px;">
        <div class="cf-threats__header">
          <div class="cf-threats__title">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <line x1="2" y1="12" x2="22" y2="12"/>
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
            </svg>
            Managed Zones
          </div>
          <span class="cf-threats__count">${zones.length}</span>
        </div>
        <div class="cf-threat-list">
          ${zones.map(z => {
            const a = analyticsMap[z.id];
            const reqs = a?.requests?.all;
            const cached = a?.requests?.cached;
            const cacheRate = reqs > 0 ? ((cached / reqs) * 100).toFixed(1) + "% cached" : null;
            const color = z.status === "active" ? "rgba(251,146,60,0.90)" : "rgba(248,113,113,0.90)";
            const reqDisplay = reqs != null ? fmtBig(reqs) + " req/7d" : z.status;
            return `
              <div class="cf-threat-row">
                <span class="cf-threat-row__name" style="display:flex;align-items:center;gap:6px;">
                  <span style="width:6px;height:6px;border-radius:50%;background:${escH(color)};flex-shrink:0;display:inline-block;"></span>
                  ${escH(z.name)}
                </span>
                <span style="font-size:0.65rem;color:rgba(255,255,255,0.40);">
                  ${escH(reqDisplay)}${cacheRate ? ` · ${escH(cacheRate)}` : ""}
                </span>
              </div>`;
          }).join("")}
        </div>
      </div>`;
  }

  function buildThreats(zones, analyticsMap) {
    let totalThreats = 0;
    const typeMap = {};
    zones.forEach(zone => {
      const a = analyticsMap[zone.id];
      if (!a) return;
      totalThreats += a.threats?.all ?? 0;
      if (a.threats?.type) {
        Object.entries(a.threats.type).forEach(([type, count]) => {
          typeMap[type] = (typeMap[type] || 0) + count;
        });
      }
    });

    const hasThreats = totalThreats > 0;
    const typeEntries = Object.entries(typeMap).sort((a, b) => b[1] - a[1]).slice(0, 5);

    return `
      <div class="cf-threats${hasThreats ? " cf-threats--has-threats" : ""}">
        <div class="cf-threats__header">
          <div class="cf-threats__title">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
            Security Threats (7d)
          </div>
          <span class="cf-threats__count${hasThreats ? " cf-threats__count--has-threats" : ""}">
            ${totalThreats.toLocaleString()}
          </span>
        </div>
        ${typeEntries.length
          ? `<div class="cf-threat-list">
               ${typeEntries.map(([type, count]) => `
                 <div class="cf-threat-row">
                   <span class="cf-threat-row__name">${escH(type)}</span>
                   <span class="cf-threat-row__count">${count.toLocaleString()}</span>
                 </div>`).join("")}
             </div>`
          : `<div style="font-size:0.68rem;color:rgba(255,255,255,0.30);margin-top:4px;">
               No threats detected
             </div>`}
      </div>`;
  }

  function buildShell(data) {
    const { tunnel, connections, zones, analyticsMap } = data;
    const statusInfo = tunnelStatusInfo(tunnel, connections);

    // Deduplicated connector count for the stat card
    const uniqueConnectors = [...new Set(connections.map(c => c.client_id))].length;
    const totalConns = connections.length;

    // Aggregate analytics across all zones
    let totalRequests = 0, totalBandwidth = 0, totalUnique = 0, totalCached = 0;
    let hasAnyAnalytics = false;
    zones.forEach(zone => {
      const a = analyticsMap[zone.id];
      if (!a) return;
      hasAnyAnalytics = true;
      totalRequests += a.requests?.all ?? 0;
      totalBandwidth += a.bandwidth?.all ?? 0;
      totalUnique += a.uniques?.all ?? 0;
      totalCached += a.requests?.cached ?? 0;
    });

    const cacheRate = totalRequests > 0
      ? ((totalCached / totalRequests) * 100).toFixed(1) + "%"
      : hasAnyAnalytics ? "0%" : "—";

    const noData = !hasAnyAnalytics && zones.length > 0 ? "N/A" : "—";

    return `
      <div class="cf-widget-host">

        <div class="cf-header">
          <div class="cf-header__left">
            <img class="cf-header__icon" src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/webp/cloudflare.webp" alt="Cloudflare">
            <div>
              <div class="cf-header__title">Cloudflare</div>
            </div>
          </div>
          <div class="cf-header__right">
            <div class="cf-status-badge ${statusInfo.cls}">
              <span class="cf-status-dot"></span>
              ${statusInfo.text}
            </div>
            <button class="cf-refresh-btn" id="cf-refresh-btn" title="Refresh now">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
                <path d="M23 4v6h-6M1 20v-6h6"/>
                <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
              </svg>
            </button>
            <a class="cf-open-link" href="${escH(CF_CONFIG.dashboardUrl)}"
               target="_blank" rel="noopener noreferrer">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
              </svg>
              Open
            </a>
          </div>
        </div>

        <div class="cf-grid">
          ${buildStatCard("Zones", zones.length || "0", "managed", zones.length > 0 ? "cf-stat__value--good" : "")}
          ${buildStatCard("Requests 7d", hasAnyAnalytics ? fmtBig(totalRequests) : noData, "all zones", totalRequests > 0 ? "cf-stat__value--good" : "")}
          ${buildStatCard("Bandwidth 7d", hasAnyAnalytics ? fmtBytes(totalBandwidth) : noData, "all zones", "")}
          ${buildStatCard("Cache Rate", hasAnyAnalytics ? cacheRate : noData, "of requests", totalCached > 0 ? "cf-stat__value--good" : "")}
          ${buildStatCard("Unique IPs 7d", hasAnyAnalytics ? fmtBig(totalUnique) : noData, "visitors", "")}
          ${buildStatCard("Connections", uniqueConnectors, `${totalConns} total edges`, uniqueConnectors > 0 ? "cf-stat__value--good" : "")}
          ${buildStatCard("Tunnel Created", fmtDate(tunnel?.created_at), "", "")}
          ${buildStatCard("Last Updated", _lastSyncTime ? _lastSyncTime.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true }) : "—", "last sync", "")}
        </div>

        ${buildConnections(connections)}
        ${buildZonesSection(zones, analyticsMap)}
        ${buildThreats(zones, analyticsMap)}

        <div class="cf-footer">
          Updated ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true })}
        </div>
      </div>`;
  }

  // ── Render ───────────────────────────────────────────────────────
  let _rendering = false;
  let _obsDelay = null;
  let _pollTimer = null;
  let _lastSyncTime = null;

  async function renderWidget(onSuccess, onError) {
    if (_rendering) return;
    _rendering = true;
    try {
      const group = findGroupContainer();
      if (!group) return;
      const host = ensureHost(group);

      if (!host.querySelector(".cf-widget-host")) {
        host.innerHTML = buildSkeleton();
      }

      const [tunnel, connections, zones] = await Promise.all([
        fetchTunnel(),
        fetchTunnelConnections(),
        fetchZones()
      ]);

      log("✓ Tunnel:", tunnel?.name, "| Connections:", connections.length, "| Zones:", zones.length);
      if (zones.length) log("Zone names:", zones.map(z => z.name).join(", "));

      const analyticsMap = {};
      if (zones.length > 0) {
        await Promise.allSettled(
          zones.map(async zone => {
            const a = await fetchZoneAnalytics(zone.id, zone.name);
            if (a) analyticsMap[zone.id] = a;
          })
        );
        log("Analytics loaded for", Object.keys(analyticsMap).length, "of", zones.length, "zones");
      }

      _lastSyncTime = new Date();
      host.innerHTML = buildShell({ tunnel, connections, zones, analyticsMap });
      bindEvents(host, onSuccess, onError);

    } catch (err) {
      console.error("[CF Widget] Fatal error:", err);
      const group = findGroupContainer();
      if (group) ensureHost(group).innerHTML = buildError(err.message);
      if (onError) onError(err);
    } finally {
      setTimeout(() => { _rendering = false; }, 2000);
    }
  }

  function bindEvents(host, onSuccess, onError) {
    const btn = host.querySelector("#cf-refresh-btn");
    if (btn && !btn._cfBound) {
      btn._cfBound = true;
      btn.addEventListener("click", () => {
        btn.classList.add("cf-refresh-btn--spinning");
        btn.disabled = true;
        renderWidget(
          () => {
            const newBtn = document.querySelector("#cf-refresh-btn");
            if (!newBtn) return;
            newBtn.classList.remove("cf-refresh-btn--spinning");
            newBtn.disabled = false;
            newBtn.classList.add("cf-refresh-btn--ok");
            newBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
            setTimeout(() => {
              newBtn.classList.remove("cf-refresh-btn--ok");
              newBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>`;
            }, 2500);
          },
          () => {
            const newBtn = document.querySelector("#cf-refresh-btn");
            if (!newBtn) return;
            newBtn.classList.remove("cf-refresh-btn--spinning");
            newBtn.disabled = false;
            newBtn.classList.add("cf-refresh-btn--err");
            newBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
            setTimeout(() => {
              newBtn.classList.remove("cf-refresh-btn--err");
              newBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>`;
            }, 2500);
          }
        );
      });
    }
    if (onSuccess) onSuccess();
  }

  function scheduleNext() {
    if (_pollTimer) clearTimeout(_pollTimer);
    _pollTimer = setTimeout(() => {
      if (!document.hidden) renderWidget();
      scheduleNext();
    }, CF_CONFIG.pollMs);
  }

  function init() {
    const start = () => {
      setTimeout(renderWidget, 1500);
      scheduleNext();
    };
    // ── Visibility: refresh on tab focus, with feedback callbacks ──
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") renderWidget();
    });
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }
    new MutationObserver(() => {
      if (_obsDelay || document.querySelector(".cf-host .cf-widget-host")) return;
      _obsDelay = setTimeout(() => { _obsDelay = null; renderWidget(); }, 700);
    }).observe(document.body, { childList: true, subtree: true });
  }

  init();
})();
