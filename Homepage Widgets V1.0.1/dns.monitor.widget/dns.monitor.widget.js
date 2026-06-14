/* =====================================================
DNS MONITOR  (AdGuard Home)
— Top blocked domains, top clients, query rate
— Pulls from both AdGuard instances, merges stats if running two adguard home servers
— Group name: DNS-MONITOR
===================================================== */
(function () {
  const DNS_CONFIG = {
    instances: [
      { label: "Adguard DNS Monitor", url: "http://YOUR_LOCAL_IP:PORT", user: "YOUR_USERNAME", pass: "YOUR_PASSWORD" },
    ],
    groupName: "ADGUARD-DNS-MONITOR",
    pollMs: 120 * 1000,
    topN: 10,
    debug: true
  };

  function log(...args) {
    if (DNS_CONFIG.debug) console.log("[Homepage DNS]", ...args);
  }

  function normalizeText(v) { return (v || "").replace(/\s+/g, " ").trim(); }
  function escapeHtml(str = "") {
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function findGroupContainer() {
    const headings = Array.from(document.querySelectorAll("h2, h3, .group-title, .service-group-name"));
    const heading = headings.find(el => normalizeText(el.textContent) === DNS_CONFIG.groupName);
    if (!heading) { log("Group not found yet"); return null; }
    return heading.closest("section") || heading.closest("div[class*='group']") ||
      heading.parentElement?.parentElement || heading.parentElement;
  }

  function ensureHost(group) {
    let host = group.querySelector(".dns-monitor-host");
    if (host) return host;
    let row = group.querySelector(".hp-widget-row, .dns-flex-row");
    if (!row) {
      const existing = group.querySelector("ul.services-list, ul");
      if (existing) existing.style.display = "none";
      row = document.createElement("div");
      row.className = "hp-widget-row dns-flex-row";
      group.appendChild(row);
    } else {
      row.classList.add("hp-widget-row", "dns-flex-row");
    }
    host = document.createElement("div");
    host.className = "dns-monitor-host";
    row.appendChild(host);
    return host;
  }

  async function fetchAdGuard(instance, path) {
    const creds = btoa(`${instance.user}:${instance.pass}`);
    const res = await fetch(`${instance.url}${path}`, {
      headers: { "Authorization": `Basic ${creds}`, "Accept": "application/json" }
    });
    if (!res.ok) throw new Error(`AdGuard ${instance.label} ${res.status}`);
    return res.json();
  }

  function pct(num, den) {
    if (!den) return "0";
    return ((num / den) * 100).toFixed(1);
  }

  function buildStatCard(label, value, sub, accentColor) {
    return `
      <div class="dns-stat-card" style="--sc-accent:${accentColor};">
        <div class="dns-stat-value">${escapeHtml(String(value))}</div>
        <div class="dns-stat-label">${escapeHtml(label)}</div>
        ${sub ? `<div class="dns-stat-sub">${escapeHtml(sub)}</div>` : ""}
      </div>`;
  }

  function buildBar(ratio, color) {
    return `
      <div class="dns-bar-track">
        <div class="dns-bar-fill" style="width:${Math.min(100, ratio * 100).toFixed(1)}%;background:${color};"></div>
      </div>`;
  }

  function buildTopList(title, items, valueKey, labelKey, color) {
    if (!items || !items.length) return "";
    const max = items[0][valueKey] || 1;
    return `
      <div class="dns-section">
        <div class="dns-section-label">${escapeHtml(title)}</div>
        <div class="dns-top-list">
          ${items.slice(0, DNS_CONFIG.topN).map(item => `
            <div class="dns-top-row">
              <div class="dns-top-label" title="${escapeHtml(String(item[labelKey]))}">${escapeHtml(String(item[labelKey]))}</div>
              <div class="dns-top-right">
                ${buildBar(item[valueKey] / max, color)}
                <span class="dns-top-count">${item[valueKey].toLocaleString()}</span>
              </div>
            </div>`).join("")}
        </div>
      </div>`;
  }

  function buildInstanceBadge(inst, stats) {
    const ok = !!stats;
    return `
      <div class="dns-inst-badge" style="--ib-color:${ok ? "#6ee7b7" : "#f87171"};">
        <span class="dns-inst-dot"></span>
        <span class="dns-inst-label">${escapeHtml(inst.label)}</span>
        ${ok ? `<span class="dns-inst-rps">${(stats.num_dns_queries / 86400).toFixed(1)}/s</span>` : `<span class="dns-inst-err">offline</span>`}
      </div>`;
  }

  function buildSkeleton() {
    return `<div class="dns-skeleton-wrap">${Array.from({ length: 3 }, () => `
      <div class="dns-skeleton-card"></div>`).join("")}</div>`;
  }

  function buildError(msg) {
    return `
      <div class="wz-error">
        <div class="wz-error-title">DNS Monitor Unavailable</div>
        <div class="wz-error-msg">${escapeHtml(msg)}</div>
      </div>`;
  }

  async function renderDnsMonitor() {
    const group = findGroupContainer();
    if (!group) return;
    const host = ensureHost(group);

    if (!host.querySelector(".dns-shell")) {
      host.innerHTML = buildSkeleton();
    }

    const results = await Promise.allSettled(
      DNS_CONFIG.instances.map(inst =>
        Promise.all([
          fetchAdGuard(inst, "/control/stats"),
          fetchAdGuard(inst, "/control/querylog?limit=100")
        ]).then(([stats, qlog]) => ({ inst, stats, qlog }))
      )
    );

    const live = results.map((r, i) => ({
      inst: DNS_CONFIG.instances[i],
      stats: r.status === "fulfilled" ? r.value.stats : null,
      qlog: r.status === "fulfilled" ? r.value.qlog : null
    }));

    // Merge stats across instances
    const merged = {
      total: 0, blocked: 0, cached: 0, safe: 0,
      topBlocked: {}, topQueried: {}, topClients: {}
    };

    live.forEach(({ stats, qlog }) => {
      if (!stats) return;
      merged.total += stats.num_dns_queries || 0;
      merged.blocked += stats.num_blocked_filtering || 0;
      merged.cached += stats.num_replaced_parental + stats.num_replaced_safebrowsing || 0;

      // Top blocked from stats
      (stats.top_blocked_domains || []).forEach(entry => {
        Object.entries(entry).forEach(([domain, count]) => {
          merged.topBlocked[domain] = (merged.topBlocked[domain] || 0) + count;
        });
      });

      // Top queried
      (stats.top_queried_domains || []).forEach(entry => {
        Object.entries(entry).forEach(([domain, count]) => {
          merged.topQueried[domain] = (merged.topQueried[domain] || 0) + count;
        });
      });

      // Top clients
      (stats.top_clients || []).forEach(entry => {
        Object.entries(entry).forEach(([client, count]) => {
          merged.topClients[client] = (merged.topClients[client] || 0) + count;
        });
      });
    });

    const toSorted = (obj) => Object.entries(obj)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    const blockedArr = toSorted(merged.topBlocked);
    const queriedArr = toSorted(merged.topQueried);
    const clientsArr = toSorted(merged.topClients);

    const blockRate = pct(merged.blocked, merged.total);

    host.innerHTML = `
      <div class="dns-shell">
        <div class="dns-header">
          <div class="dns-header-left">
            <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/webp/adguard-home.webp"
                 alt="AdGuard Home" class="dns-icon">
            <div>
              <div class="dns-title">Adguard DNS Monitor</div>
            </div>
          </div>
          <div class="dns-instances">
            ${live.map(({ inst, stats }) => buildInstanceBadge(inst, stats)).join("")}
          </div>
        </div>
 
        <div class="dns-stats-row">
          ${buildStatCard("Total Queries", merged.total.toLocaleString(), "last 24h", "#6ee7b7")}
          ${buildStatCard("Blocked", merged.blocked.toLocaleString(), `${blockRate}% of queries`, "#f87171")}
          ${buildStatCard("Block Rate", blockRate + "%", `${(merged.total / 86400).toFixed(1)} q/s avg`, "#fb923c")}
        </div>
 
        <div class="dns-two-col">
          ${buildTopList("Top Blocked Domains", blockedArr, "count", "name", "#f87171")}
          ${buildTopList("Top Queried Domains", queriedArr, "count", "name", "#6ee7b7")}
        </div>
 
        ${buildTopList("Top Clients", clientsArr, "count", "name", "#60a5fa")}
 
        <div class="dns-footer">Updated ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true })}</div>
      </div>`;
  }

  function init() {
    let _started = false;
    let _visibilityBound = false;

    function guardedRefresh(fn) {
      if (document.hidden) return;
      return fn();
    }

    function onVisibilityChange() {
      if (!document.hidden) {
        renderDnsMonitor();
      }
    }

    function bindVisibilityRefresh() {
      if (_visibilityBound) return;
      _visibilityBound = true;
      document.addEventListener("visibilitychange", onVisibilityChange);
    }

    function tryStart() {
      if (_started) return;

      const group = findGroupContainer();
      if (!group) return;

      _started = true;
      renderDnsMonitor();

      setInterval(() => guardedRefresh(renderDnsMonitor), DNS_CONFIG.pollMs);
      bindVisibilityRefresh();
    }

    const poller = setInterval(() => {
      tryStart();
      if (_started) clearInterval(poller);
    }, 1500);

    const observer = new MutationObserver(() => {
      if (!_started) {
        tryStart();
      } else if (!document.querySelector(".dns-monitor-host .dns-shell")) {
        setTimeout(() => guardedRefresh(renderDnsMonitor), 500);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  init();
})();
