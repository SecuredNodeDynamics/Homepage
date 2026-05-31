/* =====================================================
GLANCES THROUGHPUT HISTORY WIDGET
— Alarm badge popup: click critical → only critical, warning → only warning
— No CF Access headers (Bypass policy handles auth)
— Circuit-breaker: backs off nodes that keep failing
— Group name: NET-THROUGHPUT
===================================================== */
(function () {

  const NF_CONFIG = {
    groupName: "NET - GLANCES",
    pollMs: 60 * 1000,
    historyPollMs: 60 * 1000,
    debug: true,

    nodes: [
      {
        name: "LNV1",
        glancesPrimaryUrl: "https://YOUR_LOCAL_PROXOMX_GLANCES_IP:PORT",
        glancesFallbackUrl: "https://YOUR_TUNNEL_PROXOMX_GLANCES_TUNNEL_URL", // or null if not using a tunnel or glances
        netdataPrimaryUrl: "https://YOUR_LOCAL_PROXOMX_NETDATA_IP:PORT", // or null if not using a netdata
        netdataFallbackUrl: "https://YOUR_TUNNEL_PROXOMX_NETDATA_IP:PORT", // or null if not using a netdata
        activeGlancesUrl: null,
        activeNetdataUrl: null,
        netdataDisabled: false,
        iface: "vmbr0",
        color: "#6ee7b7"
      },
    ],

    intervals: [
      { label: "15m", seconds: 900 },
      { label: "1h", seconds: 3600 },
      { label: "6h", seconds: 21600 },
      { label: "24h", seconds: 86400 }
    ],
    defaultInterval: "1h"
  };

  const _backoff = {};
  const BACKOFF_THRESHOLD = 3;
  const BACKOFF_MS = 2 * 60 * 1000;

  function isBackedOff(nodeName) {
    const b = _backoff[nodeName];
    if (!b || b.fails < BACKOFF_THRESHOLD) return false;
    if (Date.now() < b.until) return true;
    _backoff[nodeName] = { fails: 0, until: 0 };
    return false;
  }

  function recordFailure(nodeName) {
    if (!_backoff[nodeName]) _backoff[nodeName] = { fails: 0, until: 0 };
    _backoff[nodeName].fails += 1;
    if (_backoff[nodeName].fails >= BACKOFF_THRESHOLD) {
      _backoff[nodeName].until = Date.now() + BACKOFF_MS;
      log(`${nodeName}: circuit open — backing off for ${BACKOFF_MS / 1000}s`);
    }
  }

  function recordSuccess(nodeName) {
    _backoff[nodeName] = { fails: 0, until: 0 };
  }

  let _liveData = {};
  let _history = {};
  let _activeInterval = NF_CONFIG.defaultInterval;
  let _rendering = false;
  let _chartIdCache = {};
  let _alarms = {};

  let _alarmPopup = null;
  let _alarmBackdrop = null;

  function log(...a) { if (NF_CONFIG.debug) console.log("[NetFlow]", ...a); }

  function escH(s = "") {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function normText(v) { return (v || "").replace(/\s+/g, " ").trim(); }

  function fmtBps(bytesPerSec) {
    if (bytesPerSec == null || isNaN(bytesPerSec) || bytesPerSec < 0)
      return { val: "0", unit: "BPS" };
    const bps = bytesPerSec * 8;
    if (bps >= 1e9) return { val: (bps / 1e9).toFixed(2), unit: "Gbps" };
    if (bps >= 1e6) return { val: (bps / 1e6).toFixed(1), unit: "Mbps" };
    if (bps >= 1e3) return { val: (bps / 1e3).toFixed(0), unit: "Kbps" };
    return { val: bps.toFixed(0), unit: "BPS" };
  }

  function fmtBpsShort(bytesPerSec) {
    const { val, unit } = fmtBps(bytesPerSec);
    return `${val} ${unit}`;
  }

  function getEndpointTargets(primaryUrl, fallbackUrl, activeUrl) {
    const targets = [];
    if (activeUrl) targets.push(activeUrl);
    if (primaryUrl && primaryUrl !== activeUrl) targets.push(primaryUrl);
    if (fallbackUrl && fallbackUrl !== activeUrl) targets.push(fallbackUrl);
    return targets;
  }

  async function fetchWithFallback(node, type, path, timeout = 5000) {
    const isNetdata = type === "netdata";
    const primaryUrl = isNetdata ? node.netdataPrimaryUrl : node.glancesPrimaryUrl;
    const fallbackUrl = isNetdata ? node.netdataFallbackUrl : node.glancesFallbackUrl;
    const activeUrl = isNetdata ? node.activeNetdataUrl : node.activeGlancesUrl;
    const targets = getEndpointTargets(primaryUrl, fallbackUrl, activeUrl);
    let lastErr = null;

    for (const baseUrl of targets) {
      try {
        const res = await fetch(`${baseUrl}${path}`, {
          signal: AbortSignal.timeout(timeout)
        });
        if (!res.ok) throw new Error(`${res.status} ${path}`);

        if (isNetdata) node.activeNetdataUrl = baseUrl;
        else node.activeGlancesUrl = baseUrl;

        return res;
      } catch (err) {
        lastErr = err;
      }
    }

    throw lastErr || new Error(`Request failed: ${path}`);
  }

  function findGroupContainer() {
    const hd = Array.from(document.querySelectorAll("h2,h3,.group-title,.service-group-name"))
      .find(el => normText(el.textContent) === NF_CONFIG.groupName);
    if (!hd) return null;
    return hd.closest("section") || hd.closest("div[class*='group']") ||
      hd.parentElement?.parentElement || hd.parentElement;
  }

  function ensureHost(group) {
    let host = group.querySelector(".netflow-host");
    if (host) return host;
    const list = group.querySelector("ul.services-list, ul");
    if (list) list.style.display = "none";
    host = document.createElement("div");
    host.className = "netflow-host";
    group.appendChild(host);
    return host;
  }

  async function discoverChartId(node) {
    const cacheKey = `${node.name}_${node.iface}`;
    if (_chartIdCache[cacheKey]) return _chartIdCache[cacheKey];

    const candidates = [
      `net.${node.iface}`, `net_${node.iface}.net`,
      `net_${node.iface}.received`, `system.net`,
    ];

    try {
      const res = await fetchWithFallback(node, "netdata", "/api/v1/charts", 6000);
      if (!res.ok) return `net.${node.iface}`;
      const data = await res.json();
      const chartIds = Object.keys(data.charts || {});

      for (const c of candidates) {
        if (chartIds.includes(c)) { _chartIdCache[cacheKey] = c; return c; }
      }

      const ifaceLower = node.iface.toLowerCase();
      const match = chartIds.find(id => id.toLowerCase().includes(ifaceLower));
      if (match) { _chartIdCache[cacheKey] = match; return match; }

      const netChart = chartIds.find(id => /^net[_.]/.test(id) && !/loopback|lo\b/i.test(id));
      if (netChart) { _chartIdCache[cacheKey] = netChart; return netChart; }
    } catch (err) {
      log(`${node.name}: chart discovery error:`, err.message);
    }

    return `net.${node.iface}`;
  }

  async function fetchNetdataLive(node) {
    const chart = await discoverChartId(node);
    const path = `/api/v1/data?chart=${encodeURIComponent(chart)}&after=-5&points=1&format=json&options=seconds%7Cabs`;
    try {
      const res = await fetchWithFallback(node, "netdata", path, 5000);
      if (!res.ok) {
        delete _chartIdCache[`${node.name}_${node.iface}`];
        recordFailure(node.name);
        return null;
      }
      const data = await res.json();
      const labels = data.labels || [];
      const rows = data.data || [];
      if (!rows.length) { recordFailure(node.name); return null; }

      const rxIdx = labels.findIndex(l => /receiv|inoctets|rx|download/i.test(l));
      const txIdx = labels.findIndex(l => /sent|outoctets|tx|upload/i.test(l));
      if (rxIdx < 0 || txIdx < 0) return null;

      const row = rows[rows.length - 1];
      const rx = (Math.abs(row[rxIdx] ?? 0) * 1000) / 8;
      const tx = (Math.abs(row[txIdx] ?? 0) * 1000) / 8;
      recordSuccess(node.name);
      return { rx, tx, online: true };
    } catch (err) {
      recordFailure(node.name);
      return null;
    }
  }

  async function fetchGlancesNetwork(node) {
    try {
      const res = await fetchWithFallback(node, "glances", "/api/4/network", 4000);
      if (!res.ok) { recordFailure(node.name); return null; }

      const data = await res.json();
      const ifaces = Array.isArray(data) ? data : [];
      let iface = ifaces.find(i => (i.interface_name || i.name) === node.iface);

      if (!iface) {
        iface = ifaces.find(i => {
          const n = i.interface_name || i.name || "";
          return n !== "lo" && !n.startsWith("docker") && !n.startsWith("veth");
        });
      }

      if (!iface) { recordFailure(node.name); return null; }

      const rx = iface.bytes_recv_rate_per_sec ?? 0;
      const tx = iface.bytes_sent_rate_per_sec ?? 0;
      recordSuccess(node.name);
      return { rx, tx, online: true };
    } catch (err) {
      recordFailure(node.name);
      return null;
    }
  }

  async function fetchAlarms(node) {
    if (node.netdataDisabled || isBackedOff(node.name)) return null;

    try {
      const res = await fetchWithFallback(node, "netdata", "/api/v1/alarms?active", 5000);
      if (res.ok) {
        const data = await res.json();
        const alarms = Object.values(data.alarms || {});
        return {
          critical: alarms.filter(a => a.status === "CRITICAL")
            .map(a => ({ name: a.name, chart: a.chart, value: a.value_string || String(a.value), info: a.info || "" })),
          warning: alarms.filter(a => a.status === "WARNING")
            .map(a => ({ name: a.name, chart: a.chart, value: a.value_string || String(a.value), info: a.info || "" })),
        };
      }
    } catch (_) { }

    try {
      const res = await fetchWithFallback(node, "netdata", "/api/v2/alarms?active", 5000);
      if (!res.ok) return null;
      const data = await res.json();
      const alarms = Object.values(data.alarms || {});
      return {
        critical: alarms.filter(a => a.status === "CRITICAL")
          .map(a => ({ name: a.name, chart: a.chart, value: a.value_string || String(a.value), info: a.info || "" })),
        warning: alarms.filter(a => a.status === "WARNING")
          .map(a => ({ name: a.name, chart: a.chart, value: a.value_string || String(a.value), info: a.info || "" })),
      };
    } catch (_) {
      return null;
    }
  }

  async function fetchLiveForNode(node) {
    if (isBackedOff(node.name)) return null;
    if (!node.netdataDisabled) {
      const nd = await fetchNetdataLive(node);
      if (nd) return nd;
      if (isBackedOff(node.name)) return null;
    }
    return await fetchGlancesNetwork(node);
  }

  async function fetchNetdataHistory(node, intervalSecs) {
    if (node.netdataDisabled || isBackedOff(node.name)) return null;
    const points = Math.min(200, Math.max(60, Math.round(intervalSecs / 30)));
    const chart = await discoverChartId(node);

    try {
      const pathV1 = `/api/v1/data?chart=${encodeURIComponent(chart)}&after=-${intervalSecs}&points=${points}&format=json&options=seconds%7Cabs`;
      const res = await fetchWithFallback(node, "netdata", pathV1, 10000);
      if (res.ok) {
        const data = await res.json();
        const labels = data.labels || [];
        const rxIdx = labels.findIndex(l => /receiv|inoctets|rx|download/i.test(l));
        const txIdx = labels.findIndex(l => /sent|outoctets|tx|upload/i.test(l));

        if (rxIdx >= 0 && txIdx >= 0 && (data.data || []).length) {
          const rxArr = [], txArr = [];
          (data.data || []).forEach(row => {
            rxArr.push((Math.abs(row[rxIdx] ?? 0) * 1000) / 8);
            txArr.push((Math.abs(row[txIdx] ?? 0) * 1000) / 8);
          });
          recordSuccess(node.name);
          return { rx: rxArr, tx: txArr };
        }

        delete _chartIdCache[`${node.name}_${node.iface}`];
      }
    } catch (_) { }

    try {
      const pathV2 = `/api/v2/data?contexts=${encodeURIComponent(chart)}&after=-${intervalSecs}&points=${points}&format=json`;
      const res = await fetchWithFallback(node, "netdata", pathV2, 10000);
      if (!res.ok) { recordFailure(node.name); return null; }
      const data = await res.json();
      const result = data?.result;
      const labels = result?.labels || [];
      const rows = result?.data || [];

      const rxIdx = labels.findIndex(l => /receiv|inoctets|rx|download/i.test(l));
      const txIdx = labels.findIndex(l => /sent|outoctets|tx|upload/i.test(l));

      if (rxIdx >= 0 && txIdx >= 0 && rows.length) {
        const rxArr = [], txArr = [];
        rows.forEach(row => {
          rxArr.push((Math.abs(row[rxIdx] ?? 0) * 1000) / 8);
          txArr.push((Math.abs(row[txIdx] ?? 0) * 1000) / 8);
        });
        recordSuccess(node.name);
        return { rx: rxArr, tx: txArr };
      }

      recordFailure(node.name);
      return null;
    } catch (err) {
      recordFailure(node.name);
      return null;
    }
  }

  function buildSparklineSVG(values, color) {
    const W = 100, H = 38;
    if (!values || values.length < 2) return { svg: "", peak: "—" };
    const max = Math.max(...values, 1);
    const pts = values.map((v, i) => {
      const x = (i / (values.length - 1)) * W;
      const y = H - (Math.max(v, 0) / max) * H * 0.90;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    const lineD = `M ${pts.join(" L ")}`;
    const areaD = `${lineD} L ${W},${H} L 0,${H} Z`;
    const gId = `nfg${color.replace(/[^a-z0-9]/gi, "")}${Math.random().toString(36).slice(2, 5)}`;
    const svg = `
      <defs>
        <linearGradient id="${gId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${color}" stop-opacity="0.28"/>
          <stop offset="100%" stop-color="${color}" stop-opacity="0.02"/>
        </linearGradient>
      </defs>
      <path d="${areaD}" fill="url(#${gId})"/>
      <path d="${lineD}" fill="none" stroke="${color}" stroke-width="1.5"
            stroke-linecap="round" stroke-linejoin="round" opacity="0.88"/>`;
    return { svg, peak: fmtBpsShort(max) };
  }

  function buildSummaryCards() {
    const maxRx = Math.max(...NF_CONFIG.nodes.map(n => _liveData[n.name]?.rx || 0), 1);
    const maxTx = Math.max(...NF_CONFIG.nodes.map(n => _liveData[n.name]?.tx || 0), 1);
    return NF_CONFIG.nodes.map(node => {
      const live = _liveData[node.name];
      const rx = Math.max(live?.rx ?? 0, 0);
      const tx = Math.max(live?.tx ?? 0, 0);
      const rxF = fmtBps(rx);
      const txF = fmtBps(tx);
      const rxPct = ((rx / maxRx) * 100).toFixed(1);
      const txPct = ((tx / maxTx) * 100).toFixed(1);
      return `
        <div class="nf-summary-card">
          <div class="nf-summary-name">${escH(node.name)}</div>
          <div class="nf-summary-speeds">
            <div>
              <div class="nf-speed-val nf-speed--rx">${rxF.val}</div>
              <div class="nf-speed-unit">↓ ${rxF.unit}</div>
            </div>
            <div>
              <div class="nf-speed-val nf-speed--tx">${txF.val}</div>
              <div class="nf-speed-unit">↑ ${txF.unit}</div>
            </div>
          </div>
          <div class="nf-summary-bar-row">
            <div class="nf-mini-bar-track">
              <div class="nf-mini-bar-fill nf-mini-bar-fill--rx" style="width:${rxPct}%;"></div>
            </div>
            <div class="nf-mini-bar-track">
              <div class="nf-mini-bar-fill nf-mini-bar-fill--tx" style="width:${txPct}%;"></div>
            </div>
          </div>
        </div>`;
    }).join("");
  }

  function closeAlarmPopup() {
    if (_alarmPopup) { _alarmPopup.remove(); _alarmPopup = null; }
    if (_alarmBackdrop) { _alarmBackdrop.remove(); _alarmBackdrop = null; }
  }

  function openAlarmPopup(nodeName, severity, anchorEl) {
    closeAlarmPopup();
    const a = _alarms[nodeName];
    if (!a) return;

    const items = severity === "critical" ? (a.critical || []) : (a.warning || []);
    const isCrit = severity === "critical";
    const label = isCrit ? "Critical" : "Warning";
    const countChipCls = isCrit
      ? "nf-alarm-popup__count-chip--critical"
      : "nf-alarm-popup__count-chip--warning";
    const rowCls = isCrit ? "nf-alarm-popup__row--critical" : "nf-alarm-popup__row--warning";
    const groupLabelCls = isCrit
      ? "nf-alarm-popup__group-label--critical"
      : "nf-alarm-popup__group-label--warning";

    const countChip = `<span class="nf-alarm-popup__count-chip ${countChipCls}">
      ${items.length} ${label.toLowerCase()}
    </span>`;

    const rows = items.map(al => `
      <div class="nf-alarm-popup__row ${rowCls}">
        <div class="nf-alarm-popup__alarm-name">${escH(al.name)}</div>
        <div class="nf-alarm-popup__alarm-chart">${escH(al.chart)}</div>
        ${al.info ? `<div class="nf-alarm-popup__alarm-chart" style="margin-top:1px;">${escH(al.info)}</div>` : ""}
        <div class="nf-alarm-popup__alarm-value">${escH(al.value)}</div>
      </div>`).join("");

    const bodyHtml = items.length
      ? `<div class="nf-alarm-popup__group-label ${groupLabelCls}">
           &#9888; ${label} (${items.length})
         </div>${rows}`
      : `<div class="nf-alarm-popup__empty">No ${label.toLowerCase()} alarms</div>`;

    const popup = document.createElement("div");
    popup.className = "nf-alarm-popup";
    popup.setAttribute("data-node", nodeName);
    popup.setAttribute("data-severity", severity);
    popup.innerHTML = `
      <div class="nf-alarm-popup__header">
        <span class="nf-alarm-popup__node">${escH(nodeName)} — ${label}</span>
        <div class="nf-alarm-popup__counts">${countChip}</div>
      </div>
      <div class="nf-alarm-popup__body">${bodyHtml}</div>`;

    document.body.appendChild(popup);
    _alarmPopup = popup;

    const PW = popup.offsetWidth || 280;
    const PH = popup.offsetHeight || 200;
    const rect = anchorEl.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = rect.left;
    if (left + PW > vw - 8) left = vw - PW - 8;
    if (left < 8) left = 8;

    let top = rect.bottom + 8;
    if (top + PH > vh - 8) top = rect.top - PH - 8;
    if (top < 8) top = 8;

    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;

    const backdrop = document.createElement("div");
    backdrop.id = "nf-alarm-popup-backdrop";
    backdrop.addEventListener("click", closeAlarmPopup);
    document.body.appendChild(backdrop);
    _alarmBackdrop = backdrop;
  }

  function buildAlarmBadges(nodeName) {
    const node = NF_CONFIG.nodes.find(n => n.name === nodeName);
    if (node?.netdataDisabled) return "";
    const a = _alarms[nodeName];
    if (!a) return `<div class="nf-alarm-row nf-alarm-row--loading"></div>`;

    const { critical = [], warning = [] } = a;
    if (!critical.length && !warning.length) {
      return `<div class="nf-alarm-row nf-alarm-row--clear">
        <span class="nf-alarm-badge nf-alarm-badge--clear">&#10003; All clear</span>
      </div>`;
    }

    const chips = [
      ...critical.map(al => `
        <span class="nf-alarm-badge nf-alarm-badge--critical"
              data-node="${escH(nodeName)}"
              data-severity="critical"
              data-alarm-trigger="1">
          &#9888; ${escH(al.name)}
        </span>`),
      ...warning.map(al => `
        <span class="nf-alarm-badge nf-alarm-badge--warning"
              data-node="${escH(nodeName)}"
              data-severity="warning"
              data-alarm-trigger="1">
          &#9888; ${escH(al.name)}
        </span>`),
    ].join("");

    return `<div class="nf-alarm-row">${chips}</div>`;
  }

  function buildNodeCard(node) {
    const live = _liveData[node.name];
    const hist = _history[node.name];
    const online = live?.online ?? false;
    const rxF = fmtBps(live?.rx);
    const txF = fmtBps(live?.tx);
    const dotCls = live === undefined
      ? "nf-node-dot--loading"
      : online ? "nf-node-dot--online" : "nf-node-dot--offline";

    let sparkHtml = "";
    if (hist?.rx?.length) {
      const W = 100, H = 38;
      const rxSVG = buildSparklineSVG(hist.rx, "#6ee7b7");
      const txSVG = buildSparklineSVG(hist.tx, "#60a5fa");
      sparkHtml = `
        <div class="nf-sparkline-wrap">
          <div class="nf-sparkline-row">
            <span class="nf-sparkline-label nf-sparkline-label--rx">RX</span>
            <svg class="nf-sparkline-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${rxSVG.svg}</svg>
            <span class="nf-sparkline-peak">${rxSVG.peak}</span>
          </div>
          <div class="nf-sparkline-row">
            <span class="nf-sparkline-label nf-sparkline-label--tx">TX</span>
            <svg class="nf-sparkline-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${txSVG.svg}</svg>
            <span class="nf-sparkline-peak">${txSVG.peak}</span>
          </div>
        </div>`;
    } else if (isBackedOff(node.name)) {
      sparkHtml = `<div class="nf-node-offline">Node unreachable — retrying shortly</div>`;
    } else if (node.netdataDisabled) {
      sparkHtml = `<div class="nf-node-offline" style="flex-direction:column;gap:4px;padding:12px;">
          <span>History unavailable</span>
          <span style="font-size:.62rem;opacity:.55;">Live data via Glances · history requires Netdata</span>
        </div>`;
    } else if (!online && live !== undefined) {
      sparkHtml = `<div class="nf-node-offline">Node unreachable — no history available</div>`;
    } else if (online && !hist) {
      sparkHtml = `
        <div class="nf-node-offline" style="flex-direction:column;gap:4px;padding:12px;">
          <span>History unavailable</span>
          <span style="font-size:.62rem;opacity:.55;">
            Chart <code>net.${escH(node.iface)}</code> not found on this Netdata node.
          </span>
        </div>`;
    } else {
      sparkHtml = `
        <div style="display:flex;flex-direction:column;gap:6px;">
          <div class="nf-skeleton" style="height:38px;border-radius:6px;"></div>
          <div class="nf-skeleton" style="height:38px;border-radius:6px;animation-delay:.15s;"></div>
        </div>`;
    }

    return `
      <div class="nf-node-card">
        <div class="nf-node-header">
          <div class="nf-node-left">
            <div class="nf-node-dot ${dotCls}"></div>
            <div class="nf-node-name">${escH(node.name)}</div>
            <div class="nf-node-iface">${escH(node.iface)}</div>
          </div>
          <div class="nf-node-speeds">
            <div class="nf-speed-chip nf-speed--rx">
              <span class="nf-speed-arrow">↓</span>
              ${online
        ? `${rxF.val}&nbsp;<span style="font-size:.60rem;opacity:.65;">${rxF.unit}</span>`
        : "—"}
            </div>
            <div class="nf-speed-chip nf-speed--tx">
              <span class="nf-speed-arrow">↑</span>
              ${online
        ? `${txF.val}&nbsp;<span style="font-size:.60rem;opacity:.65;">${txF.unit}</span>`
        : "—"}
            </div>
          </div>
        </div>
        ${buildAlarmBadges(node.name)}
        ${sparkHtml}
      </div>`;
  }

  function buildShell() {
    const tabs = NF_CONFIG.intervals.map(iv => `
      <button class="nf-interval-tab${iv.label === _activeInterval ? " nf-interval-tab--active" : ""}"
              data-interval="${escH(iv.label)}" type="button">${iv.label}</button>`).join("");
    return `
      <div class="nf-shell">
        <div class="nf-header">
          <div class="nf-header-left">
            <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/webp/glances-light.webp"
                 alt="Glances" class="nf-icon-img">
            <div>
              <div class="nf-title">Glances · Netdata</div>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <div class="nf-interval-tabs" id="nf-interval-tabs">${tabs}</div>
            <span class="nf-live-badge"><span class="nf-live-dot"></span>Live</span>
          </div>
        </div>
        <div class="nf-section-label">Current — all nodes</div>
        <div class="nf-summary" id="nf-summary">${buildSummaryCards()}</div>
        <div class="nf-section-label">History — per node (${escH(_activeInterval)})</div>
        <div class="nf-nodes" id="nf-nodes">
          ${NF_CONFIG.nodes.map(buildNodeCard).join("")}
        </div>
        <div class="nf-footer" id="nf-footer">
          Netdata · Glances · Updated ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true })}
        </div>
      </div>`;
  }

  function updateSummaryDOM(host) {
    const el = host.querySelector("#nf-summary");
    if (el) el.innerHTML = buildSummaryCards();
  }

  function updateNodesDOM(host) {
    const el = host.querySelector("#nf-nodes");
    if (el) {
      el.innerHTML = NF_CONFIG.nodes.map(buildNodeCard).join("");
      bindAlarmBadges(el);
    }
  }

  function updateFooter(host) {
    const el = host.querySelector("#nf-footer");
    if (el) el.textContent = `Netdata · Glances · Updated ${new Date().toLocaleTimeString()}`;
  }

  function bindAlarmBadges(container) {
    container.querySelectorAll("[data-alarm-trigger='1']").forEach(badge => {
      if (badge._nfBound) return;
      badge._nfBound = true;
      badge.addEventListener("click", (e) => {
        e.stopPropagation();
        const nodeName = badge.dataset.node;
        const severity = badge.dataset.severity;
        if (!nodeName || !severity) return;

        if (_alarmPopup) {
          const sameNode = _alarmPopup.dataset.node === nodeName;
          const sameSeverity = _alarmPopup.dataset.severity === severity;
          if (sameNode && sameSeverity) { closeAlarmPopup(); return; }
        }

        openAlarmPopup(nodeName, severity, badge);
      });
    });
  }

  async function refreshLive(host) {
    await Promise.all(NF_CONFIG.nodes.map(async node => {
      const [result, alarms] = await Promise.all([
        fetchLiveForNode(node),
        fetchAlarms(node)
      ]);
      _liveData[node.name] = result
        ? { rx: result.rx, tx: result.tx, online: true }
        : { rx: 0, tx: 0, online: false };
      _alarms[node.name] = alarms;
    }));

    if (!host) return;
    updateSummaryDOM(host);

    NF_CONFIG.nodes.forEach((node, idx) => {
      const live = _liveData[node.name];
      const rxF = fmtBps(live?.rx);
      const txF = fmtBps(live?.tx);
      const card = host.querySelectorAll(".nf-node-card")[idx];
      if (!card) return;

      const dot = card.querySelector(".nf-node-dot");
      if (dot) dot.className =
        `nf-node-dot ${live?.online ? "nf-node-dot--online" : "nf-node-dot--offline"}`;

      const chips = card.querySelectorAll(".nf-speed-chip");
      if (chips[0]) chips[0].innerHTML =
        `<span class="nf-speed-arrow">↓</span>${live?.online
          ? `${rxF.val}&nbsp;<span style="font-size:.60rem;opacity:.65;">${rxF.unit}</span>`
          : "—"}`;
      if (chips[1]) chips[1].innerHTML =
        `<span class="nf-speed-arrow">↑</span>${live?.online
          ? `${txF.val}&nbsp;<span style="font-size:.60rem;opacity:.65;">${txF.unit}</span>`
          : "—"}`;

      const alarmRow = card.querySelector(".nf-alarm-row");
      if (alarmRow) {
        const tmp = document.createElement("div");
        tmp.innerHTML = buildAlarmBadges(node.name);
        alarmRow.replaceWith(tmp.firstElementChild || document.createElement("div"));
        bindAlarmBadges(card);
      }
    });

    updateFooter(host);
  }

  async function refreshHistory(host) {
    const iv = NF_CONFIG.intervals.find(i => i.label === _activeInterval)
      || NF_CONFIG.intervals[1];

    await Promise.all(NF_CONFIG.nodes.map(async node => {
      const result = await fetchNetdataHistory(node, iv.seconds);
      if (result) _history[node.name] = result;
    }));

    if (host) updateNodesDOM(host);
  }

  function bindIntervalTabs(host) {
    host.addEventListener("click", async e => {
      const btn = e.target.closest(".nf-interval-tab");
      if (!btn) return;
      _activeInterval = btn.dataset.interval;
      host.querySelectorAll(".nf-interval-tab").forEach(t =>
        t.classList.toggle("nf-interval-tab--active",
          t.dataset.interval === _activeInterval));
      _history = {};
      updateNodesDOM(host);
      await refreshHistory(host);
    });
  }

  async function renderNetflow() {
    if (_rendering) return;
    _rendering = true;
    try {
      const group = findGroupContainer();
      if (!group) return;
      const host = ensureHost(group);
      const first = !host.querySelector(".nf-shell");
      if (first) {
        host.innerHTML = buildShell();
        bindIntervalTabs(host);
        const nodesEl = host.querySelector("#nf-nodes");
        if (nodesEl) bindAlarmBadges(nodesEl);
      }
      await Promise.all([
        refreshLive(host),
        ...(first ? [refreshHistory(host)] : [])
      ]);
    } catch (err) {
      console.error("[NetFlow] Render error:", err);
    } finally {
      setTimeout(() => { _rendering = false; }, 1500);
    }
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAlarmPopup();
  });

  function init() {
    const start = () => {
      setTimeout(renderNetflow, 1500);
      setInterval(() => {
        const g = findGroupContainer();
        const h = g?.querySelector(".netflow-host");
        if (h) refreshLive(h);
      }, NF_CONFIG.pollMs);
      setInterval(() => {
        const g = findGroupContainer();
        const h = g?.querySelector(".netflow-host");
        if (h) refreshHistory(h);
      }, NF_CONFIG.historyPollMs);
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }

    let pending = false;
    new MutationObserver(() => {
      if (pending || document.querySelector(".netflow-host .nf-shell")) return;
      pending = true;
      setTimeout(() => { pending = false; renderNetflow(); }, 600);
    }).observe(document.body, { childList: true, subtree: true });
  }

  init();

})();