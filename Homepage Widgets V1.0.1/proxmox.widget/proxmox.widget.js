/* =====================================================
PVE NODE COMBINED WIDGETS
Proxmox (via API token) + Glances v4 per node
Group: PVE-NODE -You can add as many proxmox nodes here as you want. 
===================================================== */
(function () {

  const PVE_NODES = [
    {
      groupName: "PVE-NODE",
      label: "Proxmox",
      color: "#6ee7b7",
      pveUrl: "http://YOUR_LOCAL_PROXMOX_IP:PORT",
      prxUrl: "http://YOUR_LOCAL_PROXMOXMENUX_IP:PORT", // or null if not using Proxmenux
      pveUser: "YOUR_USERNAME", // example of a proxmox user: homepage@pam!homepage - DO NOT USE ROOT
      pveToken: "YOUR_PROXMOX_API_TOKEN", // tokens can be generated inside the Proxmox GUI under the Server tab.
      pveNode: "YOUR_PROXMOX_SERVER_NAME",
      glancesUrl: "YOUR_PROXMOX_HOST_GLANCES_URL", // or null if not using Glances in the Proxmox Host
      iface: "PROXMOX_NETWORK_CARD_ID", // network card id can be found in the Proxmox network settings "usually set to vmbr0"
      cpuSensor: "PROXMOX_CPU_SENSOR", // can be located inside Glances
    },
  ];

  const PVE_POLL_MS = 30_000;

  const _history = {};
  PVE_NODES.forEach(n => {
    _history[n.groupName] = { cpu: [], mem: [], rx: [], tx: [] };
  });

  // ── Utilities ────────────────────────────────────────────────────
  function normText(v) { return (v || "").replace(/\s+/g, " ").trim(); }
  function escH(s = "") {
    return String(s ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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

  function fmtBps(bytesPerSec) {
    if (!bytesPerSec || bytesPerSec < 0) return "0 B/s";
    const bps = bytesPerSec * 8;
    if (bps >= 1e9) return (bps / 1e9).toFixed(2) + " Gbps";
    if (bps >= 1e6) return (bps / 1e6).toFixed(1) + " Mbps";
    if (bps >= 1e3) return (bps / 1e3).toFixed(0) + " Kbps";
    return bps.toFixed(0) + " bps";
  }

  function pushHistory(arr, val, max = 40) {
    arr.push(val);
    if (arr.length > max) arr.shift();
  }

  // ── DOM helpers ──────────────────────────────────────────────────
  function findGroupContainer(name) {
    const hd = Array.from(
      document.querySelectorAll("h2,h3,.group-title,.service-group-name")
    ).find(el => normText(el.textContent) === name);
    if (!hd) return null;
    return (
      hd.closest("section") ||
      hd.closest("div[class*='group']") ||
      hd.parentElement?.parentElement ||
      hd.parentElement
    );
  }

  function ensureHost(group) {
    let row = group.querySelector(".pve-flex-row");
    if (!row) {
      const list = group.querySelector("ul.services-list, ul");
      if (list) list.style.display = "none";
      row = document.createElement("div");
      row.className = "pve-flex-row";
      group.appendChild(row);
    }
    let host = row.querySelector(".pve-node-host");
    if (host) return host;
    host = document.createElement("div");
    host.className = "pve-node-host";
    row.appendChild(host);
    return host;
  }

  // ── API fetchers ─────────────────────────────────────────────────
  function pveHeaders(node) {
    return {
      "Authorization": `PVEAPIToken=${node.pveUser}=${node.pveToken}`,
      "Accept": "application/json",
    };
  }

  async function fetchPveNodeStatus(node) {
    const res = await fetch(
      `${node.pveUrl}/api2/json/nodes/${node.pveNode}/status`,
      { headers: pveHeaders(node), signal: (() => { const c = new AbortController(); setTimeout(() => c.abort(), 8000); return c.signal; })() }
    );
    if (!res.ok) throw new Error(`PVE node status ${res.status}`);
    const d = await res.json();
    return d.data;
  }

  async function fetchPveVMs(node) {
    const res = await fetch(
      `${node.pveUrl}/api2/json/nodes/${node.pveNode}/qemu`,
      { headers: pveHeaders(node), signal: (() => { const c = new AbortController(); setTimeout(() => c.abort(), 8000); return c.signal; })() }
    );
    if (!res.ok) throw new Error(`PVE qemu ${res.status}`);
    const d = await res.json();
    return d.data || [];
  }

  async function fetchPveLXC(node) {
    const res = await fetch(
      `${node.pveUrl}/api2/json/nodes/${node.pveNode}/lxc`,
      { headers: pveHeaders(node), signal: (() => { const c = new AbortController(); setTimeout(() => c.abort(), 8000); return c.signal; })() }
    );
    if (!res.ok) throw new Error(`PVE lxc ${res.status}`);
    const d = await res.json();
    return d.data || [];
  }

  async function fetchPveStorage(node) {
    const res = await fetch(
      `${node.pveUrl}/api2/json/nodes/${node.pveNode}/storage`,
      { headers: pveHeaders(node), signal: (() => { const c = new AbortController(); setTimeout(() => c.abort(), 8000); return c.signal; })() }
    );
    if (!res.ok) throw new Error(`PVE storage ${res.status}`);
    const d = await res.json();
    return d.data || [];
  }

  async function fetchPveUpdates(node) {
    const res = await fetch(
      `${node.pveUrl}/api2/json/nodes/${node.pveNode}/apt/update`,
      { headers: pveHeaders(node), signal: (() => { const c = new AbortController(); setTimeout(() => c.abort(), 8000); return c.signal; })() }
    );
    if (!res.ok) throw new Error(`PVE apt/update ${res.status}`);
    const d = await res.json();
    return d.data || [];
  }

  // ── Glances v4 API ───────────────────────────────────────────────
  async function fetchGlances(node, path) {
    const res = await fetch(
      `${node.glancesUrl}/api/4/${path}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) throw new Error(`Glances ${path} ${res.status}`);
    return res.json();
  }

  // ── Sparkline SVG ─────────────────────────────────────────────────
  function buildSparkline(values, color, W = 200, H = 36) {
    if (!values || values.length < 2) {
      return `<svg class="pve-sparkline-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        <line x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
      </svg>`;
    }
    const min = Math.min(...values);
    const max = Math.max(...values, min + 0.001);
    const pts = values.map((v, i) => {
      const x = (i / (values.length - 1)) * W;
      const y = H - ((v - min) / (max - min)) * H * 0.88 - H * 0.04;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    const lineD = `M ${pts.join(" L ")}`;
    const areaD = `${lineD} L ${W},${H} L 0,${H} Z`;
    const gId = `pveg${Math.random().toString(36).slice(2, 7)}`;
    return `<svg class="pve-sparkline-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <defs>
        <linearGradient id="${gId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${color}" stop-opacity="0.25"/>
          <stop offset="100%" stop-color="${color}" stop-opacity="0.02"/>
        </linearGradient>
      </defs>
      <path d="${areaD}" fill="url(#${gId})"/>
      <path d="${lineD}" fill="none" stroke="${color}" stroke-width="1.6"
            stroke-linecap="round" stroke-linejoin="round" opacity="0.88"/>
    </svg>`;
  }

  // ── Color helpers ─────────────────────────────────────────────────
  function pctColor(pct) {
    if (pct >= 90) return "#f87171";
    if (pct >= 75) return "#fb923c";
    if (pct >= 50) return "#fbbf24";
    return "#6ee7b7";
  }

  function tempColor(deg) {
    if (deg >= 85) return "#f87171";
    if (deg >= 70) return "#fb923c";
    if (deg >= 55) return "#fbbf24";
    return "#6ee7b7";
  }

  // Load avg color: thresholds relative to # of CPU cores
  function loadColor(load1, cpuCount) {
    const cores = cpuCount || 1;
    const ratio = load1 / cores;
    if (ratio >= 1.5) return "#f87171";
    if (ratio >= 1.0) return "#fb923c";
    if (ratio >= 0.7) return "#fbbf24";
    return "#6ee7b7";
  }

  // IO wait color: anything above ~10% is notable
  function iowaitColor(pct) {
    if (pct >= 30) return "#f87171";
    if (pct >= 15) return "#fb923c";
    if (pct >= 5) return "#fbbf24";
    return "#6ee7b7";
  }

  // ── Build HTML ─────────────────────────────────────────────────────
  function buildSkeleton() {
    return `
      <div class="pve-skeleton-row"></div>
      <div class="pve-skeleton-row" style="animation-delay:.12s"></div>
      <div class="pve-skeleton-row" style="animation-delay:.24s"></div>`;
  }

  function buildShell(nodeCfg, pveData, glancesData) {
    const hist = _history[nodeCfg.groupName];
    const color = nodeCfg.color;
    const online = !!(pveData && glancesData);

    // ── Proxmox data ──────────────────────────────────────────────
    const pveStatus = pveData?.status || {};

    const cpuPct = pveStatus ? Math.round((pveStatus.cpu || 0) * 100) : 0;
    const memPct = pveStatus?.memory
      ? Math.round((pveStatus.memory.used / pveStatus.memory.total) * 100) : 0;
    const memUsed = fmtBytes(pveStatus?.memory?.used);
    const memTotal = fmtBytes(pveStatus?.memory?.total);
    const rootDisk = pveStatus?.rootfs
      ? Math.round((pveStatus.rootfs.used / pveStatus.rootfs.total) * 100) : null;

    const uptime = pveStatus?.uptime ? (() => {
      const s = pveStatus.uptime;
      const d = Math.floor(s / 86400);
      const h = Math.floor((s % 86400) / 3600);
      const m = Math.floor((s % 3600) / 60);
      if (d > 0) return `${d}d ${h}h`;
      if (h > 0) return `${h}h ${m}m`;
      return `${m}m`;
    })() : "—";

    const vms = pveData?.vms || [];
    const lxcs = pveData?.lxcs || [];
    const storage = pveData?.storage || [];
    const vmRunning = vms.filter(v => v.status === "running").length;
    const lxcRunning = lxcs.filter(v => v.status === "running").length;
    const vmTotal = vms.length;
    const lxcTotal = lxcs.length;
    const storageCount = storage.length;

    // ── Kernel + updates ──────────────────────────────────────────
    const updates = pveData?.updates || [];
    const updateCount = updates.length;
    const kernelRaw = pveStatus?.kversion || "";
    const kernelVersion = kernelRaw
      .replace(/^Linux\s*/i, "")
      .replace(/#.*/, "")
      .trim() || "—";
    const hasKernelUpdate = updates.some(u =>
      /pve-kernel|linux-image/i.test(u.Package || u.name || "")
    );
    const updateColor = updateCount === 0 ? "#6ee7b7"
      : updateCount < 5 ? "#fbbf24"
        : "#f87171";
    const updateLabel = updateCount === 0
      ? "Up to date"
      : `${updateCount} update${updateCount !== 1 ? "s" : ""} available`;

    // ── Glances data ──────────────────────────────────────────────
    const glCpu = glancesData?.cpu;
    const glMem = glancesData?.mem;
    const glNet = glancesData?.network;
    const glProc = glancesData?.processlist;
    const glSensors = glancesData?.sensors;
    const glDisk = glancesData?.fs;
    const glLoad = glancesData?.load;       // NEW
    const glQuicklook = glancesData?.quicklook;  // NEW — contains swap + process count

    const liveCpuPct = glCpu?.total ?? cpuPct;
    const liveCpuColor = pctColor(liveCpuPct);

    // IO Wait — from cpu object (iowait field)
    const ioWaitPct = glCpu?.iowait != null ? Math.round(glCpu.iowait * 10) / 10 : null;
    const ioWaitColor = ioWaitPct != null ? iowaitColor(ioWaitPct) : "#6ee7b7";

    const liveMemPct = glMem ? Math.round((glMem.used / glMem.total) * 100) : memPct;
    const liveMemColor = pctColor(liveMemPct);
    const liveMemUsed = glMem ? fmtBytes(glMem.used) : memUsed;
    const liveMemTotal = glMem ? fmtBytes(glMem.total) : memTotal;

    const netIface = Array.isArray(glNet)
      ? glNet.find(n => n.interface_name === nodeCfg.iface)
      || glNet.find(n => n.interface_name !== "lo")
      || null
      : null;
    const rxBytes = netIface?.bytes_recv_rate_per_sec ?? 0;
    const txBytes = netIface?.bytes_sent_rate_per_sec ?? 0;

    const rootFs = Array.isArray(glDisk) ? glDisk.find(d => d.mnt_point === "/") || null : null;
    const diskPct = rootFs ? Math.round((rootFs.used / rootFs.size) * 100) : rootDisk ?? 0;
    const diskColor = pctColor(diskPct);
    const diskUsed = rootFs ? fmtBytes(rootFs.used) : "—";
    const diskTotal = rootFs ? fmtBytes(rootFs.size) : "—";

    let cpuTemp = null;
    if (Array.isArray(glSensors)) {
      const sensor = glSensors.find(s =>
        (s.label || "").toLowerCase().includes(nodeCfg.cpuSensor.toLowerCase())
      ) || glSensors.find(s =>
        s.type === "cpu_thermal" || (s.label || "").toLowerCase().includes("cpu")
      );
      cpuTemp = sensor?.value ?? null;
    }

    // ── NEW: Load Average ─────────────────────────────────────────
    // glLoad shape: { min1, min5, min15, cpucore }
    const loadMin1 = glLoad?.min1 ?? null;
    const loadMin5 = glLoad?.min5 ?? null;
    const cpuCores = glLoad?.cpucore ?? glCpu?.cpucore ?? 1;
    const loadBarColor = loadMin1 != null ? loadColor(loadMin1, cpuCores) : "#6ee7b7";
    const loadDisplay = loadMin1 != null
      ? loadMin1.toFixed(2)
      : "—";
    const loadSub = loadMin1 != null && loadMin5 != null
      ? `5m: ${loadMin5.toFixed(2)} · ${cpuCores} cores`
      : cpuCores > 1 ? `${cpuCores} cores` : "";

    // ── NEW: Swap ─────────────────────────────────────────────────
    // Glances v4: /mem/swap  OR inside quicklook.swap_percent
    // Try mem swap first, fall back to quicklook
    const glMemSwap = glancesData?.swap;
    const swapPct = glMemSwap
      ? Math.round((glMemSwap.used / glMemSwap.total) * 100)
      : (glQuicklook?.swap != null ? Math.round(glQuicklook.swap) : null);
    const swapUsed = glMemSwap ? fmtBytes(glMemSwap.used) : null;
    const swapTotal = glMemSwap ? fmtBytes(glMemSwap.total) : null;
    const swapColor = swapPct != null ? pctColor(swapPct) : "#6ee7b7";
    const swapDisplay = swapPct != null ? `${swapPct}%` : "—";
    const swapSub = swapUsed && swapTotal ? `${swapUsed} / ${swapTotal}` : "";

    // ── NEW: Process Count ────────────────────────────────────────
    // processlist is an array of all processes; length = total count
    // quicklook also has nb_log_core, processes can be derived
    const procTotal = Array.isArray(glProc) ? glProc.length : null;
    const procRunning = Array.isArray(glProc)
      ? glProc.filter(p => p.status === "R").length
      : null;
    const procDisplay = procTotal != null ? String(procTotal) : "—";
    const procSub = procRunning != null && procRunning > 0
      ? `${procRunning} running`
      : procTotal != null ? "all sleeping" : "";
    const procColor = procTotal != null
      ? (procTotal > 400 ? "#fbbf24" : "#6ee7b7")
      : "#6ee7b7";

    const topProcs = Array.isArray(glProc)
      ? glProc.sort((a, b) => (b.cpu_percent || 0) - (a.cpu_percent || 0)).slice(0, 5)
      : [];

    const statusCls = online ? "pve-status-badge--online" : "pve-status-badge--offline";
    const statusText = online ? "ONLINE" : "OFFLINE";

    return `
      <div class="pve-shell">

        <!-- Header -->
        <div class="pve-header">
          <div class="pve-header-left">
            <img class="pve-node-icon"
                 src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/webp/proxmox-light.webp"
                 alt="Proxmox" />
            <div>
              <div class="pve-node-title" style="color:${escH(color)};">${escH(nodeCfg.label)}</div>
              <div class="pve-node-subtitle">${escH(nodeCfg.pveNode)} · up ${escH(uptime)}</div>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
  <span class="pve-guest-pill pve-guest-pill--vm">
    <span class="dot"></span>${vmRunning}/${vmTotal} VMs
  </span>
  <span class="pve-guest-pill pve-guest-pill--lxc">
    <span class="dot"></span>${lxcRunning}/${lxcTotal} LXC
  </span>
  <span class="pve-guest-pill pve-guest-pill--storage">
    <span class="dot"></span>${storageCount} Stores
  </span>
  <span class="pve-status-badge ${statusCls}">
    <span class="pve-status-dot"></span>${statusText}
  </span>
  <a class="pve-open-link pve-open-link--pve" href="${escH(nodeCfg.pveUrl)}" target="_blank" rel="noopener">SERVER ↗</a>
  <a class="prx-open-link prx-open-link--prx" href="${escH(nodeCfg.prxUrl)}" target="_blank" rel="noopener">MONITOR ↗</a>
</div>
        </div>

        ${!online ? `
          <div class="pve-offline-msg">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="1.5" opacity=".5">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="8" x2="12" y2="12"/>
              <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <div>Node unreachable — check connectivity</div>
          </div>
        ` : `

          <!-- Proxmox summary stats — now 8 cards when all present -->
          <div>
            <div class="pve-section-label">Proxmox Summary</div>
            <div class="pve-stat-grid">

              <div class="pve-stat-card">
                <div class="pve-stat-value" style="color:${liveCpuColor};">${liveCpuPct}%</div>
                <div class="pve-stat-label">CPU</div>
              </div>

              <div class="pve-stat-card">
                <div class="pve-stat-value" style="color:${liveMemColor};">${liveMemPct}%</div>
                <div class="pve-stat-label">Memory</div>
              </div>

              <div class="pve-stat-card">
                <div class="pve-stat-value" style="color:${diskColor};">${diskPct}%</div>
                <div class="pve-stat-label">Disk</div>
              </div>

              ${cpuTemp != null ? `
              <div class="pve-stat-card">
                <div class="pve-stat-value" style="color:${tempColor(cpuTemp)};">${Math.round(cpuTemp)}°C</div>
                <div class="pve-stat-label">CPU Temp</div>
              </div>` : ""}

              <!-- NEW: Load Average -->
              <div class="pve-stat-card">
                <div class="pve-stat-value" style="color:${loadBarColor};">${escH(loadDisplay)}</div>
                <div class="pve-stat-label">Load Avg</div>
                ${loadSub ? `<div class="pve-stat-sub">${escH(loadSub)}</div>` : ""}
              </div>

              <!-- NEW: Swap -->
              <div class="pve-stat-card">
                <div class="pve-stat-value" style="color:${swapColor};">${escH(swapDisplay)}</div>
                <div class="pve-stat-label">Swap</div>
                ${swapSub ? `<div class="pve-stat-sub">${escH(swapSub)}</div>` : ""}
              </div>

              <!-- NEW: Process Count -->
              <div class="pve-stat-card">
                <div class="pve-stat-value" style="color:${procColor};">${escH(procDisplay)}</div>
                <div class="pve-stat-label">Processes</div>
                ${procSub ? `<div class="pve-stat-sub">${escH(procSub)}</div>` : ""}
              </div>

              <!-- NEW: Network speeds -->
              <div class="pve-stat-card">
                <div class="pve-stat-value" style="font-size:0.85rem; color:#6ee7b7;">↓ ${escH(fmtBps(rxBytes))}</div>
                <div class="pve-stat-value" style="font-size:0.85rem; color:#60a5fa; margin-top:2px;">↑ ${escH(fmtBps(txBytes))}</div>
                <div class="pve-stat-label">Network</div>
              </div>

              <!-- NEW: IO Wait -->
              ${ioWaitPct != null ? `
              <div class="pve-stat-card">
                <div class="pve-stat-value" style="color:${ioWaitColor};">${ioWaitPct}%</div>
                <div class="pve-stat-label">IO Wait</div>
              </div>` : ""}

            </div>
          </div>


          <div class="pve-divider"></div>

          <!-- Glances live metrics -->
          <div>
            <div class="pve-section-label">Live Metrics — Glances</div>
            <div class="pve-glances-grid">

              <!-- CPU sparkline -->
              <div class="pve-metric-card">
                <div class="pve-metric-header">
                  <span class="pve-metric-name">CPU</span>
                  <span class="pve-metric-value" style="color:${liveCpuColor};">${liveCpuPct}%</span>
                </div>
                ${buildSparkline(hist.cpu, liveCpuColor)}
                <div class="pve-bar-track">
                  <div class="pve-bar-fill" style="width:${liveCpuPct}%;background:${liveCpuColor};"></div>
                </div>
              </div>

              <!-- Memory sparkline -->
              <div class="pve-metric-card">
                <div class="pve-metric-header">
                  <span class="pve-metric-name">Memory</span>
                  <span class="pve-metric-value" style="color:${liveMemColor};">${liveMemPct}%</span>
                </div>
                ${buildSparkline(hist.mem, liveMemColor)}
                <div class="pve-bar-track">
                  <div class="pve-bar-fill" style="width:${liveMemPct}%;background:${liveMemColor};"></div>
                </div>
                <div class="pve-metric-sub">${escH(liveMemUsed)} / ${escH(liveMemTotal)}</div>
              </div>

              <!-- Network sparkline -->
              <div class="pve-metric-card">
                <div class="pve-metric-header">
                  <span class="pve-metric-name">Network (${escH(nodeCfg.iface)})</span>
                </div>
                ${buildSparkline(hist.rx, "#6ee7b7")}
                <div class="pve-net-speeds">
                  <span class="pve-net-chip pve-net-chip--rx">↓ ${escH(fmtBps(rxBytes))}</span>
                  <span class="pve-net-chip pve-net-chip--tx">↑ ${escH(fmtBps(txBytes))}</span>
                </div>
              </div>

              <!-- Disk -->
              <div class="pve-metric-card">
                <div class="pve-metric-header">
                  <span class="pve-metric-name">Disk (/)</span>
                  <span class="pve-metric-value" style="color:${diskColor};">${diskPct}%</span>
                </div>
                <div class="pve-bar-track" style="margin-top:8px;">
                  <div class="pve-bar-fill" style="width:${diskPct}%;background:${diskColor};"></div>
                </div>
                <div class="pve-metric-sub">${escH(diskUsed)} / ${escH(diskTotal)}</div>
              </div>

              <!-- Kernel & Updates — spans full width -->
              <div class="pve-metric-card pve-updates-card">
                <div class="pve-metric-header">
                  <span class="pve-metric-name">System</span>
                  <span class="pve-update-badge" style="
                    background:${escH(updateColor)}18;
                    border-color:${escH(updateColor)}40;
                    color:${escH(updateColor)};">
                    ${updateCount === 0
        ? `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`
        : `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>`
      }
                    ${escH(updateLabel)}
                  </span>
                </div>

                <div class="pve-updates-body">
                  <div class="pve-updates-kernel">
                    <div class="pve-updates-kernel-label">Kernel</div>
                    <div class="pve-updates-kernel-value">
                      ${escH(kernelVersion)}
                      ${hasKernelUpdate
        ? `<span class="pve-kernel-update-tag">kernel update</span>`
        : ""}
                    </div>
                  </div>

                  ${updateCount > 0 ? `
                  <div class="pve-updates-pkg-col">
                    <div class="pve-updates-kernel-label">Pending packages</div>
                    <div class="pve-updates-pkg-list">
                      ${updates.slice(0, 8).map(u => {
          const pkg = escH(u.Package || u.name || "unknown");
          const newVer = escH(u.Version || u.NewVersion || "");
          return `<div class="pve-updates-pkg-row">
                          <span class="pve-updates-pkg-name" title="${pkg}">${pkg}</span>
                          ${newVer ? `<span class="pve-updates-pkg-ver">${newVer}</span>` : ""}
                        </div>`;
        }).join("")}
                      ${updateCount > 8
          ? `<div class="pve-updates-pkg-more">+${updateCount - 8} more</div>`
          : ""}
                    </div>
                  </div>` : ""}
                </div>
              </div>

            </div>
          </div>

          <!-- Top processes -->
          ${topProcs.length ? `
          <div>
            <div class="pve-section-label">Top Processes</div>
            <div class="pve-process-list">
              ${topProcs.map(p => `
                <div class="pve-process-row">
                  <span class="pve-process-name" title="${escH(p.name || p.cmdline || "")}">${escH(p.name || "?")}</span>
                  <span class="pve-process-cpu">${(p.cpu_percent || 0).toFixed(1)}%</span>
                  <span class="pve-process-mem">${(p.memory_percent || 0).toFixed(1)}%</span>
                </div>`).join("")}
            </div>
          </div>` : ""}

        `}

        <div class="pve-footer">
          Proxmox + Glances · Updated ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true })}
        </div>
      </div>`;
  }

  // ── Data fetch + render per node ─────────────────────────────────
  async function renderNode(nodeCfg) {
    const group = findGroupContainer(nodeCfg.groupName);
    if (!group) return;
    const host = ensureHost(group);

    if (!host.querySelector(".pve-shell")) {
      host.innerHTML = `<div class="pve-shell">${buildSkeleton()}</div>`;
    }

    let pveData = null;
    let glancesData = null;

    try {
      const [status, vms, lxcs, storage, updates] = await Promise.all([
        fetchPveNodeStatus(nodeCfg),
        fetchPveVMs(nodeCfg),
        fetchPveLXC(nodeCfg),
        fetchPveStorage(nodeCfg),

      ]);
      pveData = { status, vms, lxcs, storage };
    } catch (err) {
      console.warn(`[PveWidget] ${nodeCfg.label} PVE fetch failed:`, err.message);
    }

    try {
      // Added: load, swap, quicklook (non-fatal)
      const [cpu, mem, network, processlist, sensors, fs, load, swap, quicklook] = await Promise.all([
        fetchGlances(nodeCfg, "cpu"),
        fetchGlances(nodeCfg, "mem"),
        fetchGlances(nodeCfg, "network"),
        fetchGlances(nodeCfg, "processlist").catch(() => []),
        fetchGlances(nodeCfg, "sensors").catch(() => []),
        fetchGlances(nodeCfg, "fs").catch(() => []),
        fetchGlances(nodeCfg, "load").catch(() => null),          // NEW
        fetchGlances(nodeCfg, "mem/swap").catch(() => null),      // NEW
        fetchGlances(nodeCfg, "quicklook").catch(() => null),     // NEW (fallback swap source)
      ]);
      glancesData = { cpu, mem, network, processlist, sensors, fs, load, swap, quicklook };
    } catch (err) {
      console.warn(`[PveWidget] ${nodeCfg.label} Glances fetch failed:`, err.message);
    }

    // Update history buffers
    const hist = _history[nodeCfg.groupName];
    const cpuVal = glancesData?.cpu?.total ?? (pveData?.status?.cpu ?? 0) * 100;
    const memVal = glancesData?.mem
      ? Math.round((glancesData.mem.used / glancesData.mem.total) * 100)
      : pveData?.status?.memory
        ? Math.round((pveData.status.memory.used / pveData.status.memory.total) * 100)
        : 0;
    const netIface = Array.isArray(glancesData?.network)
      ? glancesData.network.find(n => n.interface_name === nodeCfg.iface) || null
      : null;
    const rxVal = netIface?.bytes_recv_rate_per_sec ?? 0;
    const txVal = netIface?.bytes_sent_rate_per_sec ?? 0;

    pushHistory(hist.cpu, cpuVal);
    pushHistory(hist.mem, memVal);
    pushHistory(hist.rx, rxVal);
    pushHistory(hist.tx, txVal);

    host.innerHTML = buildShell(nodeCfg, pveData, glancesData);
  }

  // ── Init ─────────────────────────────────────────────────────────
  function init() {
    let _obsDelay = null;

    function startNode(nodeCfg) {
      const delay = PVE_NODES.indexOf(nodeCfg) * 400;
      setTimeout(() => {
        renderNode(nodeCfg);
        setInterval(() => {
          if (document.hidden) return;
          renderNode(nodeCfg);
        }, PVE_POLL_MS);
      }, 1200 + delay);
    }

    const start = () => PVE_NODES.forEach(startNode);

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }

    new MutationObserver(() => {
      if (_obsDelay) return;
      _obsDelay = setTimeout(() => {
        _obsDelay = null;
        PVE_NODES.forEach(nodeCfg => {
          const group = findGroupContainer(nodeCfg.groupName);
          if (group && !group.querySelector(".pve-node-host .pve-shell")) {
            renderNode(nodeCfg);
          }
        });
      }, 700);
    }).observe(document.body, { childList: true, subtree: true });
  }

  init();
})();

