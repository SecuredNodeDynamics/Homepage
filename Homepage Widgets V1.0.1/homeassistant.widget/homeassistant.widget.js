/* =====================================================
   HOME ASSISTANT CUSTOM WIDGET
   Group name: HOME-ASSISTANT-WIDGET
===================================================== */
(function () {
  const HA_CONFIG = {
    groupName: "HOME-ASSISTANT-WIDGET",
    pollMs: 60 * 1000,
    url: "https://homeassist.YOUR_URL_HERE.com",
    fallbackUrl: "http://YOUR_IPADDRESS:8123",
    activeUrl: null,
    token: "PASTE_HOME_ASSISTANT_LONG_LIVED_ACCESS_TOKEN_HERE",
  };

  let _data = null;
  let _error = null;
  let _rendered = false;
  let _pollTimer = null;

  function normText(v) { return (v || "").replace(/\s+/g, " ").trim(); }
  function escH(s = "") {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function isConfigured() {
    return HA_CONFIG.token && !HA_CONFIG.token.includes("PASTE_HOME_ASSISTANT");
  }
  function makeSignal(ms = 8000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    return { signal: ctrl.signal, clear: () => clearTimeout(timer) };
  }
  function findGroupContainer() {
    const hd = Array.from(document.querySelectorAll("h2,h3,.group-title,.service-group-name"))
      .find(el => normText(el.textContent) === HA_CONFIG.groupName);
    if (!hd) return null;
    return hd.closest("section") || hd.closest("div[class*='group']") || hd.parentElement?.parentElement || hd.parentElement;
  }
  function ensureHost(group) {
    let row = group.querySelector(".hp-widget-row, .ha-flex-row");
    if (!row) {
      const list = group.querySelector("ul.services-list, ul");
      if (list) list.style.display = "none";
      row = document.createElement("div");
      row.className = "hp-widget-row ha-flex-row";
      group.appendChild(row);
    } else {
      row.classList.add("hp-widget-row", "ha-flex-row");
    }
    let host = row.querySelector(".ha-host");
    if (host) return host;
    host = document.createElement("div");
    host.className = "ha-host";
    row.appendChild(host);
    return host;
  }

  async function haFetch(path) {
    const candidates = [];
    if (HA_CONFIG.activeUrl) candidates.push(HA_CONFIG.activeUrl);
    if (!candidates.includes(HA_CONFIG.url)) candidates.push(HA_CONFIG.url);
    if (HA_CONFIG.fallbackUrl && !candidates.includes(HA_CONFIG.fallbackUrl)) candidates.push(HA_CONFIG.fallbackUrl);
    let lastErr = null;
    for (const base of candidates) {
      const { signal, clear } = makeSignal();
      try {
        const res = await fetch(`${base}${path}`, {
          signal,
          headers: {
            Authorization: `Bearer ${HA_CONFIG.token}`,
            Accept: "application/json",
          },
        });
        clear();
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        HA_CONFIG.activeUrl = base;
        return res.json();
      } catch (err) {
        clear();
        lastErr = err;
        HA_CONFIG.activeUrl = null;
      }
    }
    throw lastErr || new Error("Home Assistant unavailable");
  }

  function friendly(entity) {
    return entity?.attributes?.friendly_name || entity?.entity_id?.split(".").pop()?.replace(/_/g, " ") || "Unknown";
  }
  function domainOf(entity) {
    return (entity?.entity_id || "").split(".")[0] || "unknown";
  }
  function timeAgo(iso) {
    if (!iso) return "";
    const diff = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }
  function stateIsProblem(e) {
    const id = e.entity_id || "";
    const devClass = e.attributes?.device_class || "";
    if (["unavailable", "unknown"].includes(e.state)) return true;
    if (domainOf(e) === "lock") return ["unlocked", "open"].includes(e.state);
    if (domainOf(e) === "cover") return e.state === "open";
    if (domainOf(e) === "alarm_control_panel") return !["disarmed", "armed_home", "armed_away"].includes(e.state);
    if (domainOf(e) === "binary_sensor") {
      return e.state === "on" && ["problem", "safety", "smoke", "gas", "moisture", "tamper"].includes(devClass);
    }
    return false;
  }
  function summarize(states) {
    const byDomain = states.reduce((acc, e) => {
      const d = domainOf(e);
      acc[d] = (acc[d] || 0) + 1;
      return acc;
    }, {});
    const lights = states.filter(e => domainOf(e) === "light");
    const switches = states.filter(e => domainOf(e) === "switch");
    const sensors = states.filter(e => ["sensor", "binary_sensor"].includes(domainOf(e)));
    const climate = states.filter(e => domainOf(e) === "climate");
    const unavailable = states.filter(e => ["unavailable", "unknown"].includes(e.state));
    const alerts = states.filter(stateIsProblem);
    const weather = states.find(e => domainOf(e) === "weather");
    const recent = states
      .filter(e => e.last_changed)
      .sort((a, b) => new Date(b.last_changed) - new Date(a.last_changed))
      .slice(0, 8);
    return {
      total: states.length,
      byDomain,
      lightsOn: lights.filter(e => e.state === "on").length,
      lightsTotal: lights.length,
      switchesOn: switches.filter(e => e.state === "on").length,
      switchesTotal: switches.length,
      sensorsTotal: sensors.length,
      climateTotal: climate.length,
      unavailable,
      alerts,
      weather,
      recent,
    };
  }

  async function fetchAll() {
    if (!isConfigured()) {
      _data = null;
      _error = null;
      return;
    }
    const [config, states] = await Promise.all([haFetch("/api/config"), haFetch("/api/states")]);
    _data = { config, states, summary: summarize(Array.isArray(states) ? states : []), updated: new Date() };
    _error = null;
  }

  function buildSetup() {
    return `
      <div class="ha-shell">
        <div class="ha-header">
          <div class="ha-header-left">
            <img class="ha-icon" src="/icons/homeassistant.png" alt="Home Assistant">
            <div>
              <div class="ha-title">Home Assistant</div>
              <div class="ha-subtitle">Token required</div>
            </div>
          </div>
          <a class="ha-open-link" href="${escH(HA_CONFIG.url)}" target="_blank" rel="noopener">Open</a>
        </div>
        <div class="ha-setup">
          Add a long-lived access token in <span>HA_CONFIG.token</span> to enable live entity stats.
        </div>
      </div>`;
  }
  function buildMetric(label, value, sub, cls = "") {
    return `<div class="ha-metric ${cls}">
      <div class="ha-metric-value">${escH(value)}</div>
      <div class="ha-metric-label">${escH(label)}</div>
      ${sub ? `<div class="ha-metric-sub">${escH(sub)}</div>` : ""}
    </div>`;
  }
  function buildEntityRow(e, cls = "") {
    return `<div class="ha-entity-row ${cls}">
      <div class="ha-entity-main">
        <div class="ha-entity-name">${escH(friendly(e))}</div>
        <div class="ha-entity-id">${escH(e.entity_id)}</div>
      </div>
      <div class="ha-entity-state">${escH(e.state)}</div>
    </div>`;
  }
  function buildWidget() {
    if (!isConfigured()) return buildSetup();
    if (_error && !_data) {
      return `<div class="ha-shell"><div class="ha-error">Unable to load Home Assistant: ${escH(_error)}</div></div>`;
    }
    const s = _data?.summary;
    if (!s) return `<div class="ha-shell"><div class="ha-loading">Loading Home Assistant…</div></div>`;
    const temp = s.weather?.attributes?.temperature;
    const weatherSub = s.weather ? `${friendly(s.weather)} · ${s.weather.state}` : "No weather entity";
    const alerts = s.alerts.slice(0, 5);
    return `
      <div class="ha-shell">
        <div class="ha-header">
          <div class="ha-header-left">
            <img class="ha-icon" src="/icons/homeassistant.png" alt="Home Assistant">
            <div>
              <div class="ha-title">Home Assistant</div>
              <div class="ha-subtitle">${escH(_data.config?.location_name || "Smart Home")}</div>
            </div>
          </div>
          <div class="ha-header-right">
            <span class="ha-status ${_error ? "ha-status--warn" : "ha-status--ok"}">${_error ? "Degraded" : "Online"}</span>
            <a class="ha-open-link" href="${escH(HA_CONFIG.activeUrl || HA_CONFIG.url)}" target="_blank" rel="noopener">Open</a>
          </div>
        </div>
        <div class="ha-metrics">
          ${buildMetric("Entities", String(s.total), `${Object.keys(s.byDomain).length} domains`)}
          ${buildMetric("Lights", `${s.lightsOn}/${s.lightsTotal}`, "currently on", "ha-metric--green")}
          ${buildMetric("Switches", `${s.switchesOn}/${s.switchesTotal}`, "currently on", "ha-metric--blue")}
          ${buildMetric("Climate", String(s.climateTotal), "thermostats", "ha-metric--amber")}
          ${buildMetric("Unavailable", String(s.unavailable.length), "unknown/offline", s.unavailable.length ? "ha-metric--red" : "ha-metric--green")}
          ${buildMetric("Weather", temp != null ? `${temp}°` : "—", weatherSub, "ha-metric--cyan")}
        </div>
        <div class="ha-columns">
          <div class="ha-panel">
            <div class="ha-panel-title">Attention</div>
            <div class="ha-list">
              ${alerts.length ? alerts.map(e => buildEntityRow(e, "ha-entity-row--alert")).join("") : `<div class="ha-empty">No active alerts</div>`}
            </div>
          </div>
          <div class="ha-panel">
            <div class="ha-panel-title">Recent Changes</div>
            <div class="ha-list">
              ${s.recent.map(e => `<div class="ha-entity-row">
                <div class="ha-entity-main">
                  <div class="ha-entity-name">${escH(friendly(e))}</div>
                  <div class="ha-entity-id">${escH(domainOf(e))} · ${escH(timeAgo(e.last_changed))}</div>
                </div>
                <div class="ha-entity-state">${escH(e.state)}</div>
              </div>`).join("")}
            </div>
          </div>
        </div>
        <div class="ha-footer">Updated ${_data.updated.toLocaleTimeString()}</div>
      </div>`;
  }

  function render(host) {
    if (!host) return;
    const scrollY = window.scrollY;
    host.innerHTML = buildWidget();
    _rendered = true;
    window.scrollTo({ top: scrollY, behavior: "instant" });
  }
  async function refresh() {
    const group = findGroupContainer();
    if (!group) return;
    const host = ensureHost(group);
    try {
      await fetchAll();
    } catch (err) {
      console.error("[HomeAssistantWidget]", err);
      _error = err.message || String(err);
    }
    render(host);
  }
  function startPolling() {
    if (_pollTimer) clearInterval(_pollTimer);
    _pollTimer = setInterval(refresh, HA_CONFIG.pollMs);
  }
  function init() {
    const boot = () => { refresh(); startPolling(); };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
    else boot();
    const mo = new MutationObserver(() => {
      const group = findGroupContainer();
      if (group && !_rendered) refresh();
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  init();
})();
