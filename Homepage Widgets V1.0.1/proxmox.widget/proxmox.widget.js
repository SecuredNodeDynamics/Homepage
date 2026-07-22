/* =====================================================
PVE NODE COMBINED WIDGETS
Proxmox (via API token) + Glances v4 per node
Groups: PVE-NODE-1 / PVE-NODE-2 / PVE-NODE-3
===================================================== */
(function () {

  const PVE_NODES = [
    {
      groupName: "PVE-NODE-1",
      label: "NODE-1",
      color: "#6ee7b7",
      // Prefer LAN IP first; Cloudflare tunnel/worker is fallback only.
      pveUrl: "https://YOUR_LOCAL_IP:8006",
      pveFallbackUrl: "https://YOUR-PVE-TUNNEL-HOST",
      activePveUrl: null,
      prxUrl: "https://YOUR_LOCAL_IP:8008",
      prxFallbackUrl: "https://YOUR-PROXMENUX-MONITOR",
      activePrxUrl: null,
      // ProxMenux Settings → API Access Tokens (365-day). NOT the 24h session JWT from localStorage.
      // Each node needs its own token — do not reuse across MONITOR instances.
      prxToken: "",
      pveUser: "USER@pam!TOKENID",
      pveToken: "PVE_TOKEN",
      pveNode: "pve-node-1",
      glancesUrl: "http://YOUR_LOCAL_IP:61208",
      glancesFallbackUrl: "https://YOUR-GLANCES-TUNNEL-HOST",
      activeGlancesUrl: null,
      iface: "vmbr0",
      cpuSensor: "YOUR_CPU_SENSOR",
      backupMount: "/mnt/BACKUP",
    },
    {
      groupName: "PVE-NODE-2",
      label: "NODE-2",
      color: "#60a5fa",
      pveUrl: "https://YOUR_LOCAL_IP:8006",
      pveFallbackUrl: "https://YOUR-PVE-TUNNEL-HOST",
      activePveUrl: null,
      prxUrl: "https://YOUR_LOCAL_IP:8008",
      prxFallbackUrl: "https://YOUR-PROXMENUX-MONITOR",
      activePrxUrl: null,
      // ProxMenux Settings → API Access Tokens (365-day). NOT the 24h session JWT from localStorage.
      // Each node needs its own token — do not reuse across MONITOR instances.
      prxToken: "",
      pveUser: "USER@pam!TOKENID",
      pveToken: "PVE_TOKEN",
      pveNode: "pve-node-2",
      glancesUrl: "http://YOUR_LOCAL_IP:61208",
      glancesFallbackUrl: "https://YOUR-GLANCES-TUNNEL-HOST",
      activeGlancesUrl: null,
      iface: "vmbr0",
      cpuSensor: "YOUR_CPU_SENSOR",
      backupMount: "/mnt/BACKUP",
    },
    {
      groupName: "PVE-NODE-3",
      label: "NODE-3",
      color: "#a78bfa",
      pveUrl: "https://YOUR_LOCAL_IP:8006",
      pveFallbackUrl: "https://YOUR-PVE-TUNNEL-HOST",
      activePveUrl: null,
      prxUrl: "https://YOUR_LOCAL_IP:8008",
      prxFallbackUrl: "https://YOUR-PROXMENUX-MONITOR",
      activePrxUrl: null,
      // ProxMenux Settings → API Access Tokens (365-day). NOT the 24h session JWT from localStorage.
      // Each node needs its own token — do not reuse across MONITOR instances.
      prxToken: "",
      pveUser: "USER@pam!TOKENID",
      pveToken: "PVE_TOKEN",
      pveNode: "pve-node-3",
      glancesUrl: "http://YOUR_LOCAL_IP:61208",
      glancesFallbackUrl: "https://YOUR-GLANCES-TUNNEL-HOST",
      activeGlancesUrl: null,
      iface: "vmbr0",
      cpuSensor: "YOUR_CPU_SENSOR",
      backupMount: "/mnt/BACKUP",
    },
  ];

  const PVE_POLL_MS = 30_000;

  const _history = {};
  const _tabs = {};
  const _storageSubTabs = {}; // groupName -> pve|remote|physical|external
  const _networkSubTabs = {}; // groupName -> flow|ifaces
  const _hardwareSubTabs = {}; // groupName -> thermal|graphics|pci
  const _prxHwCache = {}; // groupName -> { at, data }
  const _gpuSwitchUi = {}; // groupName -> { editingSlot, pending: { [slot]: "lxc"|"vm" } }
  let _gpuModal = null;
  let _pciModal = null;
  let _gpuSwitchModal = null;
  const _guestNetPrev = {};  // last cumulative netin/netout sample per guest
  const _guestNetRates = {}; // last computed {rx,tx,rate,ready} — only updated on fresh PVE polls
  const GUEST_NET_LS_KEY = "hp-pve-guest-net-rates-v1";
  const _guestIpCache = {}; // groupName -> { [type-vmid]: { ips: string[], at: number } }
  const _guestIpWarmInflight = {}; // groupName -> Promise|null
  const GUEST_IP_TTL_MS = 60 * 1000;
  const _rrdCache = {};
  const _nodeCache = {};
  let _guestModal = null;
  let _termModal = null;
  let _ifaceModal = null;
  let _diskModal = null;
  let _termGuestCtx = null; // { nodeCfg, type, vmid } while terminal is open
  const _prxNetCache = {};
  const _prxVmsCache = {}; // groupName -> { at, byVmid: { [vmid]: update_check } }
  const _prxStorageDiskCache = {}; // prxUrlKey -> { at, list }
  // Live recheck results win over stale ProxMenux scanner data until MONITOR rescans.
  const _liveUpdateOverride = {}; // groupName -> { [vmid]: { at, uc } }
  const LIVE_UPDATE_OVERRIDE_TTL_MS = 6 * 60 * 60 * 1000;
  const LIVE_UPDATE_LS_KEY = "hp-pve-live-update-overrides";

  function loadGuestNetState() {
    try {
      const raw = sessionStorage.getItem(GUEST_NET_LS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return;
      // Drop baselines older than 10 minutes — counters may have wrapped/rebooted
      const maxAge = 10 * 60 * 1000;
      const now = Date.now();
      const prevIn = parsed.prev && typeof parsed.prev === "object" ? parsed.prev : {};
      const ratesIn = parsed.rates && typeof parsed.rates === "object" ? parsed.rates : {};
      Object.keys(prevIn).forEach((group) => {
        const gPrev = prevIn[group];
        if (!gPrev || typeof gPrev !== "object") return;
        _guestNetPrev[group] = {};
        Object.keys(gPrev).forEach((key) => {
          const s = gPrev[key];
          if (!s || typeof s.t !== "number" || (now - s.t) > maxAge) return;
          _guestNetPrev[group][key] = s;
        });
      });
      Object.keys(ratesIn).forEach((group) => {
        const gRates = ratesIn[group];
        if (!gRates || typeof gRates !== "object") return;
        _guestNetRates[group] = {};
        Object.keys(gRates).forEach((key) => {
          const r = gRates[key];
          if (!r || typeof r !== "object") return;
          _guestNetRates[group][key] = {
            rx: Number(r.rx) || 0,
            tx: Number(r.tx) || 0,
            rate: Number(r.rate) || 0,
            ready: !!r.ready,
            at: Number(r.at) || 0,
          };
        });
      });
    } catch {}
  }

  function saveGuestNetState() {
    try {
      sessionStorage.setItem(GUEST_NET_LS_KEY, JSON.stringify({
        prev: _guestNetPrev,
        rates: _guestNetRates,
        savedAt: Date.now(),
      }));
    } catch {}
  }

  loadGuestNetState();

  function loadLiveUpdateOverrides() {
    try {
      const raw = localStorage.getItem(LIVE_UPDATE_LS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return;
      const now = Date.now();
      Object.keys(parsed).forEach((group) => {
        const byId = parsed[group];
        if (!byId || typeof byId !== "object") return;
        Object.keys(byId).forEach((id) => {
          const entry = byId[id];
          if (!entry || typeof entry.at !== "number") return;
          if (now - entry.at > LIVE_UPDATE_OVERRIDE_TTL_MS) return;
          if (!_liveUpdateOverride[group]) _liveUpdateOverride[group] = {};
          _liveUpdateOverride[group][id] = entry;
        });
      });
    } catch {}
  }

  function persistLiveUpdateOverrides() {
    try {
      localStorage.setItem(LIVE_UPDATE_LS_KEY, JSON.stringify(_liveUpdateOverride));
    } catch {}
  }

  loadLiveUpdateOverrides();
  PVE_NODES.forEach(n => {
    _history[n.groupName] = { cpu: [], mem: [], rx: [], tx: [] };
    _tabs[n.groupName] = "overview";
    _storageSubTabs[n.groupName] = "pve";
    _networkSubTabs[n.groupName] = "flow";
    _hardwareSubTabs[n.groupName] = "thermal";
    _gpuSwitchUi[n.groupName] = { editingSlot: null, pending: {} };
    if (!_guestNetPrev[n.groupName]) _guestNetPrev[n.groupName] = {};
    if (!_guestNetRates[n.groupName]) _guestNetRates[n.groupName] = {};
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

  function fmtRateBytes(bytesPerSec) {
    if (!bytesPerSec || bytesPerSec < 0) return "0 B/s";
    if (bytesPerSec >= 1e9) return (bytesPerSec / 1e9).toFixed(2) + " GB/s";
    if (bytesPerSec >= 1e6) return (bytesPerSec / 1e6).toFixed(1) + " MB/s";
    if (bytesPerSec >= 1e3) return (bytesPerSec / 1e3).toFixed(0) + " KB/s";
    return Math.round(bytesPerSec) + " B/s";
  }

  /** True when the flow label would read as idle ("0 B/s"). */
  function isZeroFlowLabel(bps) {
    const n = Number(bps) || 0;
    if (n <= 0) return true;
    if (n < 1e3) return Math.round(n) === 0;
    return false;
  }

  function fmtGbVolume(bytes) {
    if (!bytes || bytes < 0) return 0;
    return bytes / 1e9;
  }

  function isVirtualIface(name) {
    return /^(lo|veth|fwbr|fwpr|fwln|tap|tun|docker|br-|virbr|vnet|cni|flannel|cali|tailscale|wg|zt)/i.test(name || "");
  }

  function isBridgeIface(name) {
    return /^vmbr/i.test(name || "");
  }

  function isPhysicalIface(name) {
    return !!(name && !isVirtualIface(name) && !isBridgeIface(name));
  }

  function glancesSpeedToMbps(speed) {
    const n = Number(speed);
    if (!Number.isFinite(n) || n <= 0) return 0;
    // Glances often reports bits/sec (e.g. 10485760000); ProxMenux uses Mbps
    if (n >= 1e6) return Math.round(n / 1e6);
    return n;
  }

  function pickPrxPhysical(netData, ifaceName) {
    const physical = netData?.physical_interfaces || [];
    if (!physical.length) return null;
    const want = String(ifaceName || "");
    let hit = physical.find(i => i.name === want)
      || physical.find(i => String(i.name || "").toLowerCase() === want.toLowerCase());
    if (hit) return hit;

    // Index labels (nic0, nic1…) → nth UP NIC when the exact name isn’t in ProxMenux
    const m = /^nic(\d+)$/i.exec(want);
    if (m) {
      const idx = Number(m[1]);
      const up = physical.filter(i => /up/i.test(String(i.status || "")));
      return up[idx] || physical[idx] || null;
    }

    return null;
  }

  function enrichIfaceFromGlances(iface, glancesNetwork, name) {
    const list = Array.isArray(glancesNetwork) ? glancesNetwork : [];
    const want = name || iface?.name || "";
    const g = list.find(n => n.interface_name === want)
      || list.find(n => String(n.interface_name || "").toLowerCase() === String(want).toLowerCase());
    if (!g) return iface;
    const out = { ...iface };
    const glSpeed = glancesSpeedToMbps(g.speed);
    if ((!out.speed || Number(out.speed) <= 0) && glSpeed > 0) out.speed = glSpeed;
    if (!out.status || /unknown/i.test(String(out.status))) {
      if (g.isup === true || glSpeed > 0 || (g.bytes_recv_rate_per_sec || 0) + (g.bytes_sent_rate_per_sec || 0) > 0) {
        out.status = "up";
      } else if (g.isup === false) {
        out.status = "down";
      }
    }
    if ((!out.mtu || out.mtu === "—") && g.mtu != null) out.mtu = g.mtu;
    if ((!out.mac_address || out.mac_address === "—") && (g.mac || g.macaddress || g.hwaddr)) {
      out.mac_address = g.mac || g.macaddress || g.hwaddr;
    }
    if ((!out.duplex || /unknown/i.test(String(out.duplex))) && g.duplex) out.duplex = g.duplex;
    if (!(Number(out.bytes_recv) > 0) && g.bytes_recv != null) out.bytes_recv = g.bytes_recv;
    if (!(Number(out.bytes_sent) > 0) && g.bytes_sent != null) out.bytes_sent = g.bytes_sent;
    return out;
  }

  async function fetchPveNetworkConfig(node) {
    try {
      return await pveGet(node, `/nodes/${node.pveNode}/network`);
    } catch {
      return [];
    }
  }

  function enrichIfaceFromPveNet(iface, pveNetList, name) {
    const list = Array.isArray(pveNetList) ? pveNetList : [];
    const want = name || iface?.name || "";
    const row = list.find(i => i.iface === want)
      || list.find(i => String(i.iface || "").toLowerCase() === String(want).toLowerCase());
    if (!row) return iface;
    const out = { ...iface };
    if (!out.status || /unknown/i.test(String(out.status))) {
      if (row.active === 1 || row.active === true) out.status = "up";
      else if (row.active === 0 || row.active === false) out.status = "down";
    }
    if (!out.type || out.type === "unknown") {
      out.type = row.type === "eth" ? "physical" : (row.type || out.type || "physical");
    }
    return out;
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
    let row = group.querySelector(".hp-widget-row, .pve-flex-row");
    if (!row) {
      const list = group.querySelector("ul.services-list, ul");
      if (list) list.style.display = "none";
      row = document.createElement("div");
      row.className = "hp-widget-row pve-flex-row";
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
  function urlTargets(primary, fallback, active) {
    const targets = [];
    const add = (u) => {
      const v = String(u || "").replace(/\/$/, "");
      if (v && !targets.includes(v)) targets.push(v);
    };
    add(active);
    add(primary);
    add(fallback);
    return targets;
  }

  function getPveUrl(node) {
    return node.activePveUrl || node.pveUrl || node.pveFallbackUrl || "";
  }

  function getGlancesUrl(node) {
    return node.activeGlancesUrl || node.glancesUrl || node.glancesFallbackUrl || "";
  }

  function getPrxUrl(node) {
    return node.activePrxUrl || node.prxUrl || node.prxFallbackUrl || "";
  }

  function pveTargets(node) {
    return urlTargets(node.pveUrl, node.pveFallbackUrl, node.activePveUrl);
  }

  function glancesTargets(node) {
    return urlTargets(node.glancesUrl, node.glancesFallbackUrl, node.activeGlancesUrl);
  }

  function prxTargets(node) {
    return urlTargets(node.prxUrl, node.prxFallbackUrl, node.activePrxUrl);
  }

  function pveHeaders(node) {
    return {
      "Authorization": `PVEAPIToken=${node.pveUser}=${node.pveToken}`,
      "Accept": "application/json",
    };
  }

  async function fetchPveNodeStatus(node) {
    return pveGet(node, `/nodes/${node.pveNode}/status`, 8000);
  }

  async function fetchPveVMs(node) {
    return (await pveGet(node, `/nodes/${node.pveNode}/qemu`, 8000)) || [];
  }

  async function fetchPveLXC(node) {
    return (await pveGet(node, `/nodes/${node.pveNode}/lxc`, 8000)) || [];
  }

  async function fetchPveStorage(node) {
    return (await pveGet(node, `/nodes/${node.pveNode}/storage`, 8000)) || [];
  }

  async function fetchPveDisks(node) {
    const list = (await pveGet(node, `/nodes/${node.pveNode}/disks/list`, 8000)) || [];

    // Enrich with SMART details (temp, wear, power cycles) — limit concurrency
    const whole = list.filter((disk) => !(disk?.parent && disk.parent !== disk.devpath));
    const targets = (whole.length ? whole : list).slice(0, 12);
    const enriched = await Promise.all(targets.map(async (disk) => {
      const name = String(disk.devpath || "").replace(/^\/dev\//, "");
      if (!name) return disk;
      try {
        const smart = await pveGet(
          node,
          `/nodes/${node.pveNode}/disks/smart?disk=${encodeURIComponent(name)}`,
          6000
        );
        return { ...disk, smart: smart || null };
      } catch {
        return disk;
      }
    }));

    const byPath = new Map(enriched.map((disk) => [disk.devpath, disk]));
    return list.map((disk) => byPath.get(disk.devpath) || disk);
  }

  async function fetchPveUpdates(node) {
    return (await pveGet(node, `/nodes/${node.pveNode}/apt/update`, 8000)) || [];
  }

  const IFACE_RANGES = [
    { id: "hour",  label: "1 Hour",   title: "Last 1 Hour" },
    { id: "day",   label: "24 Hours", title: "Last 24 Hours" },
    { id: "week",  label: "7 Days",   title: "Last 7 Days" },
    { id: "month", label: "30 Days",  title: "Last 30 Days" },
    { id: "year",  label: "1 Year",   title: "Last 1 Year" },
  ];

  function ifaceRangeMeta(id) {
    return IFACE_RANGES.find(r => r.id === id) || IFACE_RANGES[1];
  }

  function formatRrdTick(ts, timeframe) {
    const d = new Date((Number(ts) || 0) * 1000);
    if (timeframe === "hour" || timeframe === "day") {
      return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: false });
    }
    if (timeframe === "year") {
      return d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
    }
    // week / month → "Jul 13, 13" (date + hour), matching ProxMenux
    const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const hour = String(d.getHours()).padStart(2, "0");
    return `${date}, ${hour}`;
  }

  function ifaceTypeTone(typeLabel, kind) {
    const t = String(typeLabel || "").toLowerCase();
    if (t === "physical" || kind === "nic") return "blue";
    if (t === "virtual" || t === "veth" || kind === "guest") return "orange";
    if (t === "bridge" || kind === "bridge" || kind === "host") return "green";
    return "muted";
  }

  function ifaceDisplayType(iface, kind) {
    const raw = String(iface?.type || "").toLowerCase();
    if (kind === "nic" || raw === "physical") return "Physical";
    if (
      kind === "guest"
      || raw === "veth"
      || raw === "virtual"
      || raw === "vm_lxc"
      || raw === "qemu"
      || raw === "tap"
      || raw.includes("lxc")
      || raw.includes("virt")
    ) return "Virtual";
    if (raw === "bridge" || kind === "bridge" || kind === "host") return "Bridge";
    return capitalizeWord(iface?.type || kind || "—");
  }

  function guestKindBadge(iface, target, nodeCfg) {
    const raw = String(iface?.vm_type || target?.guestType || "").toLowerCase();
    if (raw === "qemu" || raw === "vm" || raw === "kvm") return "VM";
    if (raw === "lxc" || raw === "ct" || raw === "container" || raw === "vm_lxc") return "LXC";
    const vmid = String(iface?.vmid || target?.vmid || "");
    const cache = nodeCfg && _nodeCache[nodeCfg.groupName]?.pveData;
    if (cache && vmid) {
      if ((cache.vms || []).some(v => String(v.vmid) === vmid)) return "VM";
      if ((cache.lxcs || []).some(v => String(v.vmid) === vmid)) return "LXC";
    }
    return "LXC";
  }

  function resolveVmidFromCache(nodeCfg, guestName, hintVmid) {
    if (hintVmid) return String(hintVmid);
    const name = String(guestName || "").trim();
    if (!name) return "";
    const cache = _nodeCache[nodeCfg.groupName]?.pveData;
    if (!cache) return "";
    const lower = name.toLowerCase();
    const ct = (cache.lxcs || []).find(c => c.name === name || String(c.name || "").toLowerCase() === lower);
    if (ct) return String(ct.vmid);
    const vm = (cache.vms || []).find(v => v.name === name || String(v.name || "").toLowerCase() === lower);
    if (vm) return String(vm.vmid);
    return "";
  }

  function enrichIfaceRecord(iface, target, nodeCfg) {
    const out = { ...(iface || {}) };
    const kind = target?.kind || "";
    const looksGuest = kind === "guest"
      || out.vm_name
      || out.vmid
      || /^(veth|tap|fw)/i.test(out.name || "")
      || /lxc|qemu|virt|veth/i.test(String(out.type || ""));

    if (looksGuest) {
      if (!out.vm_name && target?.guest) out.vm_name = target.guest;
      if (!out.vmid && target?.vmid) out.vmid = target.vmid;
      if (!out.vm_type && target?.guestType) {
        out.vm_type = target.guestType === "qemu" ? "qemu" : "lxc";
      }
      const vmid = resolveVmidFromCache(nodeCfg, out.vm_name || target?.guest, out.vmid || target?.vmid);
      if (vmid) out.vmid = vmid;
      if (!out.vm_type) {
        const cache = _nodeCache[nodeCfg.groupName]?.pveData;
        if (cache && out.vmid) {
          if ((cache.vms || []).some(v => String(v.vmid) === String(out.vmid))) out.vm_type = "qemu";
          else if ((cache.lxcs || []).some(v => String(v.vmid) === String(out.vmid))) out.vm_type = "lxc";
        }
      }
      if (!out.type || /vm_lxc|qemu|lxc/i.test(String(out.type))) out.type = "virtual";
      if (!out.vm_name && target?.guest) out.vm_name = target.guest;
    }
    return out;
  }

  async function fetchPveRrd(node, timeframe = "day") {
    const tf = encodeURIComponent(timeframe || "day");
    return (await pveGet(node, `/nodes/${node.pveNode}/rrddata?timeframe=${tf}&cf=AVERAGE`, 10000)) || [];
  }

  async function fetchGuestRrd(node, type, vmid, timeframe = "day") {
    const kind = type === "qemu" ? "qemu" : "lxc";
    const tf = encodeURIComponent(timeframe || "day");
    return (await pveGet(
      node,
      `/nodes/${node.pveNode}/${kind}/${vmid}/rrddata?timeframe=${tf}&cf=AVERAGE`,
      10000
    )) || [];
  }

  function resolveGuestApiKind(nodeCfg, iface, target) {
    const raw = String(iface?.vm_type || target?.guestType || "").toLowerCase();
    if (raw === "qemu" || raw === "vm" || raw === "kvm") return "qemu";
    if (raw === "lxc" || raw === "ct" || raw === "container" || raw === "vm_lxc") return "lxc";
    const vmid = String(iface?.vmid || target?.vmid || "");
    const cache = _nodeCache[nodeCfg.groupName]?.pveData;
    if (cache && vmid) {
      if ((cache.vms || []).some(v => String(v.vmid) === vmid)) return "qemu";
      if ((cache.lxcs || []).some(v => String(v.vmid) === vmid)) return "lxc";
    }
    return "lxc";
  }

  async function fetchIfaceRrd(nodeCfg, target, iface, timeframe = "day") {
    const kind = target?.kind || "bridge";
    const guestName = iface?.vm_name || target?.guest || "";
    const vmid = resolveVmidFromCache(nodeCfg, guestName, iface?.vmid || target?.vmid);
    const isGuest = kind === "guest" || !!(iface?.vm_name || iface?.vmid || target?.guest || guestName);

    if (isGuest && vmid) {
      const gKind = resolveGuestApiKind(nodeCfg, iface, { ...target, vmid, guestType: target?.guestType });
      try {
        return await fetchGuestRrd(nodeCfg, gKind, vmid, timeframe);
      } catch (err) {
        const alt = gKind === "qemu" ? "lxc" : "qemu";
        console.warn(`[PveWidget] guest RRD ${gKind}/${vmid} failed, trying ${alt}:`, err);
        return fetchGuestRrd(nodeCfg, alt, vmid, timeframe);
      }
    }
    return fetchPveRrd(nodeCfg, timeframe);
  }

  function guestApiBase(node, type, vmid) {
    const kind = type === "qemu" ? "qemu" : "lxc";
    return `/nodes/${node.pveNode}/${kind}/${vmid}`;
  }

  async function pveGet(node, path, timeoutMs = 10000) {
    const targets = pveTargets(node);
    let lastErr = null;
    for (const base of targets) {
      try {
        const res = await fetch(`${base}/api2/json${path}`, {
          headers: pveHeaders(node),
          signal: (() => { const c = new AbortController(); setTimeout(() => c.abort(), timeoutMs); return c.signal; })(),
        });
        if (!res.ok) throw new Error(`PVE GET ${path} ${res.status}`);
        node.activePveUrl = base;
        const d = await res.json();
        return d.data;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error(`PVE GET ${path} failed`);
  }

  async function pvePost(node, path, timeoutMs = 15000) {
    const targets = pveTargets(node);
    let lastErr = null;
    for (const base of targets) {
      try {
        const res = await fetch(`${base}/api2/json${path}`, {
          method: "POST",
          headers: { ...pveHeaders(node), "Content-Type": "application/x-www-form-urlencoded" },
          signal: (() => { const c = new AbortController(); setTimeout(() => c.abort(), timeoutMs); return c.signal; })(),
        });
        if (!res.ok) {
          let msg = `HTTP ${res.status}`;
          try { const j = await res.json(); msg = j?.errors ? JSON.stringify(j.errors) : (j?.message || msg); } catch {}
          throw new Error(msg);
        }
        node.activePveUrl = base;
        try { return (await res.json()).data; } catch { return null; }
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error(`PVE POST ${path} failed`);
  }

  async function fetchGuestConfig(node, type, vmid) {
    return pveGet(node, `${guestApiBase(node, type, vmid)}/config`);
  }

  async function fetchGuestStatus(node, type, vmid) {
    return pveGet(node, `${guestApiBase(node, type, vmid)}/status/current`);
  }

  async function fetchGuestFirewall(node, type, vmid) {
    try {
      const [opts, rules] = await Promise.all([
        pveGet(node, `${guestApiBase(node, type, vmid)}/firewall/options`).catch(() => ({})),
        pveGet(node, `${guestApiBase(node, type, vmid)}/firewall/rules`).catch(() => []),
      ]);
      return { options: opts || {}, rules: rules || [] };
    } catch {
      return { options: {}, rules: [] };
    }
  }

  function backupVolMatches(volid, vmid, type) {
    const v = String(vmid);
    const s = String(volid || "");
    if (!s) return false;
    if (s.includes(`vzdump-lxc-${v}-`) || s.includes(`vzdump-qemu-${v}-`) || s.includes(`vzdump-openvz-${v}-`)) return true;
    if (s.includes(`/ct/${v}/`) || s.includes(`/vm/${v}/`)) return true;
    if (s.includes(`backup/ct/${v}/`) || s.includes(`backup/vm/${v}/`)) return true;
    if (new RegExp(`(?:^|[^0-9])${v}(?:[^0-9]|$)`).test(s) && /backup|vzdump/i.test(s)) {
      if (type === "lxc" && /(?:lxc|ct)/i.test(s)) return true;
      if (type === "qemu" && /(?:qemu|vm)/i.test(s)) return true;
      if (/vzdump/i.test(s)) return true;
    }
    return false;
  }

  async function fetchGuestBackups(node, vmid, type = "lxc") {
    const storages = await fetchPveStorage(node).catch(() => []);
    const backupStores = (storages || []).filter(s => {
      if (s.enabled === 0 || s.active === 0) return false;
      const content = String(s.content || "");
      const stype = String(s.type || "");
      return content.includes("backup") || stype === "pbs" || stype === "dir" || stype === "nfs" || stype === "cifs";
    });

    const preferred = backupStores.filter(s =>
      String(s.content || "").includes("backup") || String(s.type || "") === "pbs"
    );
    // Always prefer backup/PBS stores; fall back to the wider set if those return nothing
    const tiers = preferred.length ? [preferred, backupStores] : [backupStores];

    const out = [];
    const seen = new Set();

    const absorb = (items, storageName) => {
      (items || []).forEach(it => {
        if (!it || typeof it !== "object") return;
        const vol = String(it.volid || "");
        const match =
          String(it.vmid) === String(vmid) ||
          backupVolMatches(vol, vmid, type) ||
          backupVolMatches(String(it.notes || ""), vmid, type);
        if (!match) return;
        const key = vol || `${storageName}:${it.ctime || ""}:${it.size || ""}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ ...it, storage: storageName });
      });
    };

    for (const scan of tiers) {
      await Promise.all(scan.map(async (s) => {
        const enc = encodeURIComponent(s.storage);
        const paths = [
          `/nodes/${node.pveNode}/storage/${enc}/content?content=backup&vmid=${encodeURIComponent(vmid)}`,
          `/nodes/${node.pveNode}/storage/${enc}/content?vmid=${encodeURIComponent(vmid)}`,
          `/nodes/${node.pveNode}/storage/${enc}/content?content=backup`,
          `/nodes/${node.pveNode}/storage/${enc}/content`,
        ];
        for (const path of paths) {
          try {
            const items = await pveGet(node, path);
            const list = Array.isArray(items) ? items : [];
            absorb(list, s.storage);
            // If the vmid-filtered call succeeded, no need to broaden further for this store
            if (path.includes("vmid=") && list.length) break;
            if (out.length && path.includes("content=backup")) break;
          } catch {}
        }
      }));
      if (out.length) break;
    }

    out.sort((a, b) => (b.ctime || 0) - (a.ctime || 0));
    return out;
  }

  function parseGuestIps(config) {
    const ips = [];
    Object.keys(config || {}).forEach(k => {
      if (!/^net\d+$/i.test(k)) return;
      const val = String(config[k] || "");
      const ip4 = val.match(/(?:^|,)ip=([^,]+)/i);
      const ip6 = val.match(/(?:^|,)ip6=([^,]+)/i);
      if (ip4 && ip4[1] && !/^dhcp$/i.test(ip4[1])) ips.push(ip4[1].split("/")[0]);
      if (ip6 && ip6[1] && !/^auto|dhcp$/i.test(ip6[1])) ips.push(ip6[1].split("/")[0]);
    });
    return [...new Set(ips)];
  }

  function guestIpKey(type, vmid) {
    return `${type === "qemu" ? "qemu" : "lxc"}-${vmid}`;
  }

  function getCachedGuestIps(nodeCfg, type, vmid) {
    const ent = _guestIpCache[nodeCfg.groupName]?.[guestIpKey(type, vmid)];
    return ent?.ips || null;
  }

  function isUsefulGuestIp(ip) {
    const s = String(ip || "").trim();
    if (!s) return false;
    if (s === "127.0.0.1" || s === "::1") return false;
    if (/^fe80:/i.test(s)) return false;
    if (/^169\.254\./.test(s)) return false;
    return true;
  }

  function parseIpsFromInterfaces(ifaces) {
    const list = Array.isArray(ifaces) ? ifaces : [];
    const v4 = [];
    const v6 = [];
    for (const iface of list) {
      const name = String(iface?.name || "");
      if (!name || name === "lo") continue;
      const addrs = Array.isArray(iface["ip-addresses"]) ? iface["ip-addresses"] : [];
      if (addrs.length) {
        for (const a of addrs) {
          const ip = String(a?.["ip-address"] || "").split("/")[0].trim();
          if (!isUsefulGuestIp(ip)) continue;
          const typ = String(a?.["ip-address-type"] || "").toLowerCase();
          if (typ === "inet" || typ === "ipv4" || /^\d+\.\d+\.\d+\.\d+$/.test(ip)) v4.push(ip);
          else if (typ === "inet6" || typ === "ipv6" || ip.includes(":")) v6.push(ip);
        }
        continue;
      }
      const inet = String(iface?.inet || "").split("/")[0].trim();
      if (isUsefulGuestIp(inet) && /^\d+\.\d+\.\d+\.\d+$/.test(inet)) v4.push(inet);
      const inet6 = String(iface?.inet6 || "").split("/")[0].trim();
      if (isUsefulGuestIp(inet6) && inet6.includes(":")) v6.push(inet6);
    }
    return [...new Set([...v4, ...v6])];
  }

  async function fetchGuestRuntimeIps(node, type, vmid) {
    const kind = type === "qemu" ? "qemu" : "lxc";
    if (kind === "lxc") {
      const ifaces = await pveGet(node, `${guestApiBase(node, type, vmid)}/interfaces`).catch(() => null);
      return parseIpsFromInterfaces(ifaces);
    }
    try {
      const data = await pveGet(node, `${guestApiBase(node, type, vmid)}/agent/network-get-interfaces`);
      const ifaces = Array.isArray(data) ? data : (Array.isArray(data?.result) ? data.result : []);
      return parseIpsFromInterfaces(ifaces);
    } catch {
      return [];
    }
  }

  async function resolveGuestIps(node, type, vmid, status) {
    let ips = [];
    if (status === "running") {
      try { ips = await fetchGuestRuntimeIps(node, type, vmid); } catch { ips = []; }
    }
    if (!ips.length) {
      try {
        const cfg = await fetchGuestConfig(node, type, vmid);
        ips = parseGuestIps(cfg);
      } catch {
        ips = [];
      }
    }
    return ips;
  }

  function warmGuestIpCache(nodeCfg, pveData, { force = false } = {}) {
    const group = nodeCfg.groupName;
    if (_guestIpWarmInflight[group]) return _guestIpWarmInflight[group];
    const guests = [
      ...(pveData?.vms || []).map((v) => ({ type: "qemu", vmid: v.vmid, status: v.status })),
      ...(pveData?.lxcs || []).map((v) => ({ type: "lxc", vmid: v.vmid, status: v.status })),
    ];
    if (!guests.length) return Promise.resolve(false);

    const now = Date.now();
    const cache = _guestIpCache[group] || (_guestIpCache[group] = {});
    const need = guests.filter((g) => {
      const ent = cache[guestIpKey(g.type, g.vmid)];
      if (force || !ent) return true;
      return (now - ent.at) > GUEST_IP_TTL_MS;
    });
    if (!need.length) return Promise.resolve(false);

    const before = JSON.stringify(
      Object.fromEntries(Object.keys(cache).sort().map((k) => [k, cache[k]?.ips || []]))
    );

    _guestIpWarmInflight[group] = Promise.all(need.map(async (g) => {
      const key = guestIpKey(g.type, g.vmid);
      try {
        const ips = await resolveGuestIps(nodeCfg, g.type, g.vmid, g.status);
        cache[key] = { ips, at: Date.now() };
      } catch {
        if (!cache[key]) cache[key] = { ips: [], at: Date.now() };
        else cache[key].at = Date.now();
      }
    })).then(() => {
      const after = JSON.stringify(
        Object.fromEntries(Object.keys(cache).sort().map((k) => [k, cache[k]?.ips || []]))
      );
      return before !== after;
    }).catch(() => false).finally(() => {
      _guestIpWarmInflight[group] = null;
    });

    return _guestIpWarmInflight[group];
  }

  function scheduleGuestIpWarm(nodeCfg, pveData) {
    if (!pveData) return;
    if ((_tabs[nodeCfg.groupName] || "overview") !== "guests") return;
    warmGuestIpCache(nodeCfg, pveData).then((changed) => {
      if (changed && (_tabs[nodeCfg.groupName] || "overview") === "guests") {
        paintNodeFromCache(nodeCfg);
      }
    });
  }

  function decodePveNotes(str) {
    try {
      return decodeURIComponent(String(str || "").replace(/%0A/gi, "\n"));
    } catch {
      return String(str || "");
    }
  }

  function sanitizeNotesHtml(html) {
    const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
    doc.querySelectorAll("script,iframe,object,embed,link,meta,form").forEach(el => el.remove());
    doc.querySelectorAll("*").forEach(el => {
      [...el.attributes].forEach(attr => {
        const n = attr.name;
        const v = attr.value || "";
        if (/^on/i.test(n)) el.removeAttribute(n);
        if ((n === "href" || n === "src") && /^\s*javascript:/i.test(v)) el.removeAttribute(n);
      });
      const align = el.getAttribute("align");
      if (align && /^(center|left|right)$/i.test(align)) {
        el.style.textAlign = align.toLowerCase();
      }
      if (el.tagName === "A") {
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "noopener noreferrer");
      }
    });
    return doc.body.innerHTML;
  }

  function notesToHtml(raw) {
    const decoded = decodePveNotes(raw);
    if (!decoded.trim()) return "";
    if (/<\/?[a-z][\s\S]*?>/i.test(decoded)) return sanitizeNotesHtml(decoded);
    // plain / light markdown
    let s = escH(decoded);
    s = s.replace(/^### (.+)$/gm, "<h3>$1</h3>");
    s = s.replace(/^## (.+)$/gm, "<h2>$1</h2>");
    s = s.replace(/^# (.+)$/gm, "<h1>$1</h1>");
    s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    s = s.replace(/(^|[\s>])(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
    s = s.replace(/\n/g, "<br>");
    return s;
  }

  function parseKvList(raw) {
    const out = {};
    String(raw || "").split(",").forEach(pair => {
      const eq = pair.indexOf("=");
      if (eq > 0) out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
      else if (pair.trim() && !out.model) out.model = pair.trim();
    });
    return out;
  }

  function parseDiskSpec(raw) {
    const s = String(raw || "");
    const comma = s.indexOf(",");
    const head = comma >= 0 ? s.slice(0, comma) : s;
    const opts = parseKvList(comma >= 0 ? s.slice(comma + 1) : "");
    let storage = "", volume = "", path = "";
    if (head.includes(":")) {
      const i = head.indexOf(":");
      storage = head.slice(0, i);
      volume = head.slice(i + 1);
    } else if (head.startsWith("/")) {
      path = head;
    } else {
      volume = head;
    }
    return { storage, volume, path, options: opts, raw: s };
  }

  function humanDiskSize(size) {
    if (!size) return "";
    const m = String(size).match(/^(\d+(?:\.\d+)?)([KMGTP]?)B?$/i);
    if (!m) return String(size);
    return `${m[1]} ${ (m[2] || "").toUpperCase() || "" }B`.replace(" B", " B").replace(/B$/, "B");
  }

  function notesBtnHtml(show) {
    return show ? "Hide Notes" : "Notes";
  }

  function infoBtnHtml(show) {
    return show ? "Less Info" : "Info";
  }

  function toggleGuestNotes(modal) {
    const ctx = modal.__pveGcCtx;
    if (!ctx) return;
    const ui = modal.__pveGcUi || (modal.__pveGcUi = { showNotes: false, showInfo: false });
    ui.showNotes = !ui.showNotes;
    modal.__pveGcIgnoreBackdropUntil = Date.now() + 1500;

    const btn = modal.querySelector("[data-gc-notes]");
    const section = btn?.closest(".pve-gc-section") || modal.querySelector(".pve-gc-body .pve-gc-section");
    if (btn) {
      btn.classList.toggle("pve-gc-mini-btn--active", ui.showNotes);
      btn.textContent = notesBtnHtml(ui.showNotes);
    }

    let panel = modal.querySelector(".pve-gc-notes-panel");
    if (ui.showNotes) {
      if (!panel && section) {
        section.insertAdjacentHTML("beforeend", buildNotesPanel(ctx.notes));
      } else if (panel) {
        panel.hidden = false;
      }
    } else if (panel) {
      panel.remove();
    }
  }

  function toggleGuestInfo(modal) {
    const ctx = modal.__pveGcCtx;
    if (!ctx) return;
    const ui = modal.__pveGcUi || (modal.__pveGcUi = { showNotes: false, showInfo: false });
    ui.showInfo = !ui.showInfo;
    modal.__pveGcIgnoreBackdropUntil = Date.now() + 1500;

    const btn = modal.querySelector("[data-gc-info]");
    const section = btn?.closest(".pve-gc-section") || modal.querySelector(".pve-gc-body .pve-gc-section");
    if (btn) {
      btn.classList.toggle("pve-gc-mini-btn--active", ui.showInfo);
      btn.textContent = infoBtnHtml(ui.showInfo);
    }

    let panel = modal.querySelector(".pve-gc-info-panel");
    if (ui.showInfo) {
      if (!panel && section) {
        section.insertAdjacentHTML("beforeend", buildInfoPanel(ctx.config, ctx.type));
      } else if (panel) {
        panel.hidden = false;
      }
    } else if (panel) {
      panel.remove();
    }
  }

  function buildNotesPanel(notesRaw) {
    const html = notesToHtml(notesRaw);
    if (!html) {
      return `<div class="pve-gc-notes-panel">
        <div class="pve-gc-notes-hdr"><span>NOTES</span></div>
        <div class="pve-gc-notes-body pve-gc-notes-empty">No notes yet.</div>
      </div>`;
    }
    return `<div class="pve-gc-notes-panel">
      <div class="pve-gc-notes-hdr"><span>NOTES</span></div>
      <div class="pve-gc-notes-body pve-gc-notes">${html}</div>
    </div>`;
  }

  function buildInfoPanel(config, type) {
    const isLxc = type === "lxc";
    const unpriv = config.unprivileged == 1 || config.unprivileged === true;
    const privKnown = config.unprivileged != null;

    let html = `<div class="pve-gc-info-panel">`;

    if (isLxc && privKnown) {
      html += `<div class="pve-gc-info-block">
        <div class="pve-gc-info-title">Container Configuration</div>
        <div class="pve-gc-info-label">Privilege Level</div>
        <span class="pve-gc-info-pill ${unpriv ? "pve-gc-info-pill--ok" : "pve-gc-info-pill--warn"}">${unpriv ? "Unprivileged" : "Privileged"}</span>
      </div>`;
    }

    // Storage / rootfs / disks
    const diskKeys = Object.keys(config || {}).filter(k =>
      k === "rootfs" || k === "efidisk0" || k === "tpmstate0" ||
      /^(scsi|sata|ide|virtio|mp)\d+$/i.test(k)
    ).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    if (diskKeys.length) {
      html += `<div class="pve-gc-info-block">
        <div class="pve-gc-info-title">Hardware &amp; Storage</div>
        <div class="pve-gc-info-stack">`;
      diskKeys.forEach(key => {
        const d = parseDiskSpec(config[key]);
        const label = key === "rootfs" ? "Root Filesystem"
          : key.startsWith("mp") ? `Mount Point ${key.replace("mp", "")}`
          : key.toUpperCase().replace(/(\d+)/, " $1");
        const size = humanDiskSize(d.options.size);
        html += `<div class="pve-gc-disk">
          <div class="pve-gc-disk-top">
            <span class="pve-gc-disk-name">${escH(label)}</span>
            ${d.storage ? `<span class="pve-gc-disk-store">${escH(d.storage)}</span>` : ""}
            ${size ? `<span class="pve-gc-disk-size">${escH(size)}</span>` : ""}
          </div>
          <div class="pve-gc-disk-grid">
            ${d.volume ? `<div><span>Volume</span><b>${escH(d.volume)}</b></div>` : ""}
            ${d.path ? `<div><span>Path</span><b>${escH(d.path)}</b></div>` : ""}
            ${d.options.mp ? `<div><span>Mount</span><b>${escH(d.options.mp)}</b></div>` : ""}
          </div>
          <details class="pve-gc-raw"><summary>Raw config</summary><code>${escH(d.raw)}</code></details>
        </div>`;
      });
      html += `</div></div>`;
    }

    // Network
    const netKeys = Object.keys(config || {}).filter(k => /^net\d+$/i.test(k)).sort();
    if (netKeys.length) {
      html += `<div class="pve-gc-info-block">
        <div class="pve-gc-info-title">Network</div>
        <div class="pve-gc-info-stack">`;
      netKeys.forEach(key => {
        const raw = String(config[key] || "");
        const p = parseKvList(raw);
        const idx = key.replace(/net/i, "");
        const title = p.name ? `Network Interface ${idx} (${p.name})` : `Network Interface ${idx}`;
        html += `<div class="pve-gc-disk">
          <div class="pve-gc-disk-top"><span class="pve-gc-disk-name">${escH(title)}</span></div>
          <div class="pve-gc-disk-grid">
            ${p.bridge ? `<div><span>Bridge</span><b>${escH(p.bridge)}</b></div>` : ""}
            ${p.ip ? `<div><span>IP</span><b>${escH(p.ip)}</b></div>` : ""}
            ${p.gw ? `<div><span>Gateway</span><b>${escH(p.gw)}</b></div>` : ""}
            ${p.hwaddr || p.macaddr ? `<div><span>MAC</span><b>${escH(p.hwaddr || p.macaddr)}</b></div>` : ""}
            ${p.type || p.model ? `<div><span>Type</span><b>${escH(p.type || p.model)}</b></div>` : ""}
            ${p.mtu ? `<div><span>MTU</span><b>${escH(p.mtu)}</b></div>` : ""}
            ${p.firewall != null ? `<div><span>Firewall</span><b>${escH(p.firewall)}</b></div>` : ""}
          </div>
          <details class="pve-gc-raw"><summary>Raw config</summary><code>${escH(raw)}</code></details>
        </div>`;
      });
      html += `</div></div>`;
    }

    // System
    const ns = config.nameserver || config.searchdomain;
    if (config.hostname || config.nameserver || config.searchdomain || config.ostype) {
      html += `<div class="pve-gc-info-block">
        <div class="pve-gc-info-title">System Info</div>
        <div class="pve-gc-disk-grid">
          ${config.hostname ? `<div><span>Hostname</span><b>${escH(config.hostname)}</b></div>` : ""}
          ${config.ostype ? `<div><span>OS Type</span><b>${escH(config.ostype)}</b></div>` : ""}
          ${config.nameserver ? `<div><span>DNS Nameservers</span><b>${escH(config.nameserver)}</b></div>` : ""}
          ${config.searchdomain ? `<div><span>Search Domain</span><b>${escH(config.searchdomain)}</b></div>` : ""}
        </div>
      </div>`;
    }

    html += `</div>`;
    return html;
  }

  function ostypeLabel(ostype) {
    const o = String(ostype || "").toLowerCase();
    if (o.includes("debian")) return "Debian";
    if (o.includes("ubuntu")) return "Ubuntu";
    if (o.includes("alpine")) return "Alpine";
    if (o.includes("fedora")) return "Fedora";
    if (o.includes("centos") || o.includes("alma") || o.includes("rocky")) return "RHEL";
    if (o.includes("arch")) return "Arch";
    if (o.includes("suse")) return "SUSE";
    if (o.includes("win")) return "Windows";
    return ostype || "Guest";
  }

  // ProxMenux-style distro logos (no boxed label)
  function ostypeLogoHtml(ostype) {
    const o = String(ostype || "").toLowerCase();
    const label = ostypeLabel(ostype);
    const cdn = "https://cdn.jsdelivr.net/gh/MacRimi/ProxMenux@main/AppImage/public/icons";
    let icon = null;
    if (o.includes("debian")) icon = "debian.svg";
    else if (o.includes("ubuntu")) icon = "ubuntu.svg";
    else if (o.includes("alpine")) icon = "alpine.svg";
    else if (o.includes("arch")) icon = "arch.svg";

    if (icon) {
      return `<div class="pve-gc-os" title="${escH(label)}">
        <img class="pve-gc-os-logo" src="${cdn}/${icon}" alt="${escH(label)}" width="64" height="64" loading="lazy" />
      </div>`;
    }
    if (!ostype) return "";
    return `<div class="pve-gc-os" title="${escH(label)}"><span class="pve-gc-os-fallback">${escH(label)}</span></div>`;
  }


  // ── Glances v4 API ───────────────────────────────────────────────
  async function fetchGlances(node, path) {
    const targets = glancesTargets(node);
    let lastErr = null;
    for (const base of targets) {
      try {
        const res = await fetch(`${base}/api/4/${path}`, {
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error(`Glances ${path} ${res.status}`);
        node.activeGlancesUrl = base;
        return res.json();
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error(`Glances ${path} failed`);
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

  function loadColor(load1, cpuCount) {
    const cores = cpuCount || 1;
    const ratio = load1 / cores;
    if (ratio >= 1.5) return "#f87171";
    if (ratio >= 1.0) return "#fb923c";
    if (ratio >= 0.7) return "#fbbf24";
    return "#6ee7b7";
  }

  function iowaitColor(pct) {
    if (pct >= 30) return "#f87171";
    if (pct >= 15) return "#fb923c";
    if (pct >= 5) return "#fbbf24";
    return "#6ee7b7";
  }


  // ── Network Traffic area chart ───────────────────────────────────
  function sumRrdVolumes(rrdPoints) {
    const points = (rrdPoints || []).filter(p => p && p.time != null);
    let rx = 0, tx = 0;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const prevT = i > 0 ? points[i - 1].time : p.time - 1800;
      const step = Math.max(60, (p.time || 0) - (prevT || 0));
      rx += (Number(p.netin) || 0) * step;
      tx += (Number(p.netout) || 0) * step;
    }
    return { rx, tx };
  }

  function buildTrafficChart(rrdPoints, opts = {}) {
    // ProxMenux-style area chart: emerald/blue fills, dashed grid, tilted time labels
    const RX = "#10b981";
    const TX = "#3b82f6";
    const W = opts.width || 720;
    const H = opts.height || 220;
    const pad = opts.pad || { t: 18, r: 14, b: 52, l: 44 };
    const plotW = W - pad.l - pad.r;
    const plotH = H - pad.t - pad.b;
    const plotBottom = pad.t + plotH;

    const points = (rrdPoints || []).filter(p => p && p.time != null);
    if (points.length < 2) {
      return `<div class="pve-net-empty">Waiting for RRD network history…</div>`;
    }

    const vols = [];
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const prevT = i > 0 ? points[i - 1].time : p.time - 1800;
      const step = Math.max(60, (p.time || 0) - (prevT || 0));
      const rx = Number(p.netin) || 0;
      const tx = Number(p.netout) || 0;
      vols.push({
        t: p.time,
        rxGb: fmtGbVolume(rx * step),
        txGb: fmtGbVolume(tx * step),
      });
    }

    const maxY = Math.max(0.01, ...vols.flatMap(v => [v.rxGb, v.txGb]));
    const niceMax = (() => {
      const padded = maxY * 1.08;
      if (padded <= 1) return Math.ceil(padded * 4) / 4 || 0.25;
      if (padded <= 4) return Math.ceil(padded);
      return Math.ceil(padded / 2) * 2;
    })();

    function xAt(i) {
      return pad.l + (i / (vols.length - 1)) * plotW;
    }
    function yAt(v) {
      return pad.t + plotH - (v / niceMax) * plotH;
    }

    function seriesPath(key) {
      const line = vols.map((v, i) => `${i ? "L" : "M"}${xAt(i).toFixed(1)},${yAt(v[key]).toFixed(1)}`);
      const area = `${line.join(" ")} L${xAt(vols.length - 1).toFixed(1)},${plotBottom.toFixed(1)} L${xAt(0).toFixed(1)},${plotBottom.toFixed(1)} Z`;
      return { line: line.join(" "), area };
    }

    const rxPath = seriesPath("rxGb");
    const txPath = seriesPath("txGb");

    const yTicks = 4;
    let grid = "";
    for (let i = 0; i <= yTicks; i++) {
      const val = (niceMax / yTicks) * i;
      const y = yAt(val);
      grid += `<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${W - pad.r}" y2="${y.toFixed(1)}" class="pve-net-grid"/>`;
      const label = val >= 10 ? val.toFixed(0) : val.toFixed(val < 1 ? 2 : (Number.isInteger(val) ? 0 : 1));
      grid += `<text x="${pad.l - 6}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" class="pve-net-axis">${label}</text>`;
    }

    const xCount = Math.min(8, vols.length);
    for (let i = 0; i < xCount; i++) {
      const idx = Math.round(i * (vols.length - 1) / Math.max(1, xCount - 1));
      const x = xAt(idx);
      grid += `<line x1="${x.toFixed(1)}" y1="${pad.t}" x2="${x.toFixed(1)}" y2="${plotBottom.toFixed(1)}" class="pve-net-grid"/>`;
    }

    const timeframe = opts.timeframe || "day";
    let xLabels = "";
    for (let i = 0; i < xCount; i++) {
      const idx = Math.round(i * (vols.length - 1) / Math.max(1, xCount - 1));
      const x = xAt(idx);
      const y = plotBottom + 8;
      const label = formatRrdTick(vols[idx].t, timeframe);
      xLabels += `<line x1="${x.toFixed(1)}" y1="${plotBottom}" x2="${x.toFixed(1)}" y2="${(plotBottom + 5).toFixed(1)}" class="pve-net-tick"/>`;
      xLabels += `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="end" class="pve-net-axis" transform="rotate(-45 ${x.toFixed(1)} ${y.toFixed(1)})">${label}</text>`;
    }

    const midY = pad.t + plotH / 2;
    const cls = opts.className ? ` ${opts.className}` : "";
    const rangeTitle = ifaceRangeMeta(timeframe).title;
    return `
      <svg class="pve-net-traffic-svg${cls}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Network traffic ${escH(rangeTitle)}">
        ${grid}
        <text x="10" y="${midY.toFixed(1)}" class="pve-net-axis pve-net-axis--unit" transform="rotate(-90 10 ${midY.toFixed(1)})">GB</text>
        <line x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${plotBottom}" class="pve-net-axis-line"/>
        <line x1="${pad.l}" y1="${plotBottom}" x2="${W - pad.r}" y2="${plotBottom}" class="pve-net-axis-line"/>
        <path d="${rxPath.area}" fill="${RX}" fill-opacity="0.3"/>
        <path d="${txPath.area}" fill="${TX}" fill-opacity="0.3"/>
        <path d="${rxPath.line}" fill="none" stroke="${RX}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
        <path d="${txPath.line}" fill="none" stroke="${TX}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
        ${xLabels}
      </svg>`;
  }

  const _guestNetQuickSample = {}; // groupName -> true after scheduling a cold-start resample

  /**
   * Diff Proxmox cumulative netin/netout → bytes/sec.
   * Only run on fresh PVE polls. Baselines persist in sessionStorage so a
   * hard refresh / script remount can still produce rates on the first fetch.
   */
  function updateGuestNetRates(groupName, pveData) {
    if (!pveData) return;
    const prevMap = _guestNetPrev[groupName] || (_guestNetPrev[groupName] = {});
    const ratesMap = _guestNetRates[groupName] || (_guestNetRates[groupName] = {});
    const now = Date.now();
    const samples = [
      ...(pveData.vms || []).map((v) => ({ key: `qemu-${v.vmid}`, netin: v.netin, netout: v.netout })),
      ...(pveData.lxcs || []).map((v) => ({ key: `lxc-${v.vmid}`, netin: v.netin, netout: v.netout })),
    ];
    const seen = new Set();
    for (const g of samples) {
      seen.add(g.key);
      const ninRaw = Number(g.netin);
      const noutRaw = Number(g.netout);
      // API omitted stats entirely — keep whatever we already have
      if (!Number.isFinite(ninRaw) && !Number.isFinite(noutRaw)) continue;

      const nin = Number.isFinite(ninRaw) ? ninRaw : (prevMap[g.key]?.netin || 0);
      const nout = Number.isFinite(noutRaw) ? noutRaw : (prevMap[g.key]?.netout || 0);
      const prev = prevMap[g.key];

      if (!prev || typeof prev.t !== "number") {
        prevMap[g.key] = { t: now, netin: nin, netout: nout };
        if (!ratesMap[g.key]) ratesMap[g.key] = { rx: 0, tx: 0, rate: 0, ready: false, at: now };
        continue;
      }

      const dt = (now - prev.t) / 1000;
      if (dt < 1) continue; // too soon — keep last rate + baseline

      // Guest reboot / counter wrap — re-baseline, keep last rate briefly
      if (nin < (prev.netin || 0) || nout < (prev.netout || 0)) {
        prevMap[g.key] = { t: now, netin: nin, netout: nout };
        if (ratesMap[g.key]) ratesMap[g.key] = { ...ratesMap[g.key], ready: false, at: now };
        continue;
      }

      const rx = Math.max(0, (nin - (prev.netin || 0)) / dt);
      const tx = Math.max(0, (nout - (prev.netout || 0)) / dt);
      prevMap[g.key] = { t: now, netin: nin, netout: nout };
      ratesMap[g.key] = { rx, tx, rate: rx + tx, ready: true, at: now };
    }
    Object.keys(ratesMap).forEach((k) => { if (!seen.has(k)) delete ratesMap[k]; });
    Object.keys(prevMap).forEach((k) => { if (!seen.has(k)) delete prevMap[k]; });
    saveGuestNetState();
  }

  function getGuestRates(groupName, key) {
    return _guestNetRates[groupName]?.[key] || { rx: 0, tx: 0, rate: 0, ready: false };
  }

  /**
   * Network Flow animation upgrades — flip any flag to false to disable that effect.
   * 1 density        packet count scales with throughput
   * 2 splitBranches  beams follow bridge→guest branches (not one shared highway pulse)
   * 3 softComet      softer glow / longer fade trail
   * 4 nodePulse      ring breath on hot nodes
   * 5 dirOnly        only draw rx or tx when that direction has traffic
   * 6 cornerEase     ease-in-out timing (less snappy through turns)
   */
  const PVE_NF_ANIM = {
    density: true,
    splitBranches: true,
    softComet: true,
    nodePulse: true,
    dirOnly: true,
    cornerEase: true,
  };

  /** Map bytes/sec → time to travel a short reference hop. 0 = idle (no pulse). */
  function beamSec(bps) {
    const B = Number(bps) || 0;
    if (B < 512) return 0; // < 0.5 KB/s
    const kb = B / 1024;
    return Math.max(0.85, Math.min(3.6, 3.8 - Math.log10(kb + 1) * 0.95));
  }

  /** Approx length of our M/L/Q flow paths (SVG user units). */
  function approxPathLen(d) {
    const tokens = String(d || "").match(/[MLQ]|[-+]?(?:\d*\.\d+|\d+)/gi) || [];
    let i = 0;
    let x = 0;
    let y = 0;
    let len = 0;
    let started = false;
    while (i < tokens.length) {
      const t = tokens[i++];
      if (t === "M" || t === "L") {
        const nx = Number(tokens[i++]);
        const ny = Number(tokens[i++]);
        if (!Number.isFinite(nx) || !Number.isFinite(ny)) break;
        if (t === "L" && started) len += Math.hypot(nx - x, ny - y);
        x = nx;
        y = ny;
        started = true;
      } else if (t === "Q") {
        const cx = Number(tokens[i++]);
        const cy = Number(tokens[i++]);
        const nx = Number(tokens[i++]);
        const ny = Number(tokens[i++]);
        if (![cx, cy, nx, ny].every(Number.isFinite)) break;
        if (started) {
          const chord = Math.hypot(nx - x, ny - y);
          const via = Math.hypot(cx - x, cy - y) + Math.hypot(nx - cx, ny - cy);
          len += (chord + via) / 2;
        }
        x = nx;
        y = ny;
        started = true;
      }
    }
    return Math.max(len, 1);
  }

  /**
   * Duration for one packet lap. Scales with path length so long highways don't
   * look like they teleport — visual px/s stays roughly constant, rate still modulates speed.
   */
  function beamTravelSec(bps, pathLen) {
    const base = beamSec(bps);
    if (!base) return 0;
    const REF = 88;
    const len = Math.max(Number(pathLen) || REF, REF * 0.5);
    return Math.min(14, Math.max(0.9, base * (len / REF)));
  }

  /** #1 density — packets from path length and/or throughput */
  function beamPacketCount(bps, pathLen) {
    const lenPack = Math.max(1, Math.min(4, Math.round((Number(pathLen) || 88) / 120)));
    if (!PVE_NF_ANIM.density) return lenPack;
    const kb = (Number(bps) || 0) / 1024;
    const rateExtra = kb < 80 ? 0 : kb < 400 ? 1 : kb < 2048 ? 2 : 3;
    return Math.max(1, Math.min(6, lenPack + rateExtra));
  }

  function buildNetworkFlow(nodeCfg, pveData, glancesData) {
    const glNet = Array.isArray(glancesData?.network) ? glancesData.network : [];
    const bridgeName = nodeCfg.iface || "vmbr0";

    // ProxMenux-style Lucide icons (24x24 stroke)
    const ICONS = {
      nic: `<g class="pve-nf-icon" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m15 20 3-3h2a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2l3 3z"/><path d="M6 8v1"/><path d="M10 8v1"/><path d="M14 8v1"/><path d="M18 8v1"/></g>`,
      host: `<g class="pve-nf-icon" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/></g>`,
      bridge: `<g class="pve-nf-icon" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/></g>`,
      guest: `<g class="pve-nf-icon" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M22 7.7c0-.6-.4-1.2-.8-1.5l-6.3-3.9a1.72 1.72 0 0 0-1.7 0l-10.3 6c-.5.2-.9.8-.9 1.4v6.6c0 .5.4 1.2.8 1.5l6.3 3.9a1.72 1.72 0 0 0 1.7 0l10.3-6c.5-.3.9-1 .9-1.5Z"/><path d="M10 21.9V14L2.1 9.1"/><path d="m10 14 11.9-6.9"/><path d="M14 19.8v-8.1"/><path d="M18 17.5V9.4"/></g>`,
    };

    const physical = glNet
      .filter(n => isPhysicalIface(n.interface_name))
      .map(n => {
        const rx = n.bytes_recv_rate_per_sec || 0;
        const tx = n.bytes_sent_rate_per_sec || 0;
        const speedMbps = glancesSpeedToMbps(n.speed);
        const active = (rx + tx) > 64 || speedMbps > 0;
        return {
          name: n.interface_name,
          rx,
          tx,
          rate: rx + tx,
          label: speedMbps > 0
            ? (speedMbps >= 1000 ? `${(speedMbps / 1000).toFixed(1)} Gbps` : `${speedMbps} Mbps`)
            : (active ? fmtRateBytes(rx + tx) : "N/A"),
          active,
        };
      })
      .sort((a, b) => Number(b.active) - Number(a.active) || b.rate - a.rate);

    // Prefer ProxMenux physical NICs when Glances doesn't expose them (common on bonded/bridged hosts)
    if (!physical.length) {
      const prxPhys = _prxNetCache[nodeCfg.groupName]?.data?.physical_interfaces || [];
      prxPhys.forEach((i) => {
        if (!i?.name) return;
        const speed = Number(i.speed) || 0;
        const rx = Number(i.bytes_recv_rate_per_sec) || 0;
        const tx = Number(i.bytes_sent_rate_per_sec) || 0;
        const active = /up/i.test(String(i.status || "")) || speed > 0 || (rx + tx) > 0;
        physical.push({
          name: i.name,
          rx,
          tx,
          rate: rx + tx,
          label: speed > 0 ? fmtIfaceSpeed(speed) : (active ? (rx + tx > 0 ? fmtRateBytes(rx + tx) : "UP") : "N/A"),
          active,
        });
      });
      physical.sort((a, b) => Number(b.active) - Number(a.active) || b.rate - a.rate);
    }

    if (!physical.length) {
      // Last resort placeholder — still treat as linked so the tree isn't broken
      physical.push({ name: "nic0", rx: 0, tx: 0, rate: 0, label: "N/A", active: true });
    } else if (!physical.some(p => p.active)) {
      physical[0].active = true;
    }

    const bridge = glNet.find(n => n.interface_name === bridgeName)
      || glNet.find(n => isBridgeIface(n.interface_name));
    const bridgeRx = bridge?.bytes_recv_rate_per_sec || 0;
    const bridgeTx = bridge?.bytes_sent_rate_per_sec || 0;
    const bridgeRate = bridgeRx + bridgeTx;
    const hostRx = physical.filter(p => p.active).reduce((s, p) => s + (p.rx || 0), 0) || bridgeRx;
    const hostTx = physical.filter(p => p.active).reduce((s, p) => s + (p.tx || 0), 0) || bridgeTx;
    const hostRate = hostRx + hostTx || bridgeRate;

    const guests = [];
    for (const vm of (pveData?.vms || [])) {
      if (vm.status !== "running") continue;
      const rates = getGuestRates(nodeCfg.groupName, `qemu-${vm.vmid}`);
      guests.push({
        name: vm.name || `vm-${vm.vmid}`,
        vmid: vm.vmid,
        rx: rates.rx,
        tx: rates.tx,
        rate: rates.rate,
        ready: !!rates.ready,
        kind: "vm",
      });
    }
    for (const ct of (pveData?.lxcs || [])) {
      if (ct.status !== "running") continue;
      const rates = getGuestRates(nodeCfg.groupName, `lxc-${ct.vmid}`);
      guests.push({
        name: ct.name || `ct-${ct.vmid}`,
        vmid: ct.vmid,
        rx: rates.rx,
        tx: rates.tx,
        rate: rates.rate,
        ready: !!rates.ready,
        kind: "lxc",
      });
    }
    guests.sort((a, b) => b.rate - a.rate || String(a.name).localeCompare(String(b.name)));
    const shown = guests.slice(0, 24);

    // Readable ProxMenux-style tree geometry (sized for label legibility)
    const R_NIC = 22, R_HOST = 32, R_BR = 20, R_GUEST = 18;
    const nicX = 64, hostX = 220, brX = 350;
    const cols = 4;
    const colGap = 118;
    const gridX0 = 470;
    const pairGap = 160;  // vertical distance between above/below pair
    const bandGap = 56;   // gap between bands
    const bands = Math.max(1, Math.ceil(Math.max(shown.length, 1) / (cols * 2)));
    const bandH = pairGap + 100; // room for outer-side labels above top guests
    const gridH = bands * bandH + (bands - 1) * bandGap;
    const leftH = Math.max(physical.slice(0, 3).length, 1) * 88;
    const H = Math.max(320, 64 + Math.max(leftH, gridH));
    const midY = H / 2;
    const W = gridX0 + (cols - 1) * colGap + 90;

    function shortName(name, max = 16) {
      const s = String(name || "");
      return s.length > max ? s.slice(0, max - 1) + "…" : s;
    }

    const leftCount = Math.min(physical.length, 3);
    function stackY(i, n) {
      if (n <= 1) return midY - 24;
      const span = (n - 1) * 88;
      return midY - 24 - span / 2 + i * 88;
    }

    const physNodes = physical.slice(0, leftCount).map((p, i) => ({
      ...p, x: nicX, y: stackY(i, leftCount), r: R_NIC, kind: "nic",
    }));
    const hostNode = {
      name: "PROXMOX", x: hostX, y: midY, r: R_HOST,
      rate: hostRate, rx: hostRx, tx: hostTx,
      label: fmtRateBytes(hostRate), kind: "host", iface: bridgeName, active: true,
    };
    const brNode = {
      name: bridgeName, x: brX, y: midY, r: R_BR,
      rate: bridgeRate, rx: bridgeRx, tx: bridgeTx,
      label: fmtRateBytes(bridgeRate), kind: "bridge", iface: bridgeName, active: true,
    };

    // Place guests in ProxMenux bands: each band = horizontal bus + 4 cols × (above/below)
    const guestNodes = [];
    const bandBuses = [];
    const list = shown.length ? shown : [{ name: "idle", rate: 0, rx: 0, tx: 0, kind: "lxc" }];
    for (let b = 0; b < bands; b++) {
      const bandTop = (H - gridH) / 2 + b * (bandH + bandGap);
      const busY = bandTop + bandH / 2;
      bandBuses.push(busY);
      for (let slot = 0; slot < cols * 2; slot++) {
        const idx = b * cols * 2 + slot;
        if (idx >= list.length) break;
        const c = Math.floor(slot / 2);
        const above = slot % 2 === 0;
        const g = list[idx];
        guestNodes.push({
          ...g,
          x: gridX0 + c * colGap,
          y: above ? busY - pairGap / 2 : busY + pairGap / 2,
          r: R_GUEST,
          busY,
          col: c,
          label: (!g.ready && !(Number(g.rate) > 0)) ? "—" : fmtRateBytes(g.rate),
          kind: g.kind === "vm" ? "guest" : "guest",
        });
      }
    }

    // ProxMenux nf-link fillets (from their SVG): quadratic corners
    // Guest stubs leave a gap before the circle so lines never kiss the ring,
    // and labels sit on the outer side (not between bus and node).
    const CORNER = 16;
    const STUB_GAP = 8;

    function guestStubEndY(g) {
      // End short of the circle — gap between line tip and ring
      return g.y < g.busY ? (g.y + g.r + STUB_GAP) : (g.y - g.r - STUB_GAP);
    }

    let links = "";
    const beamPaths = []; // { d, dir, sec, pathLen, bps }

    function pushBeam(d, dir, bps) {
      // #5 dirOnly — skip a direction when that side is idle
      const rate = Number(bps) || 0;
      if (PVE_NF_ANIM.dirOnly && rate < 512) return;
      const pathLen = approxPathLen(d);
      const sec = beamTravelSec(rate, pathLen);
      if (sec > 0) beamPaths.push({ d, dir, sec, pathLen, bps: rate });
    }

    // Active NIC → host (H→V→H orthogonal S-bend, enters host from the left)
    // Idle NICs are shown as nodes only — no stray dim link into PROXMOX.
    physNodes.forEach(p => {
      if (!p.active) return;
      const x0 = p.x + p.r;
      const y0 = p.y;
      const x1 = hostNode.x - hostNode.r;
      const y1 = hostNode.y;
      const elbowX = Math.round((x0 + x1) / 2);
      const dy = Math.sign(y1 - y0);
      let d = `M ${x0} ${y0}`;
      if (Math.abs(y1 - y0) < 2) {
        d += ` L ${x1} ${y1}`;
      } else {
        const r = Math.min(CORNER, Math.abs(x1 - x0) / 4, Math.abs(y1 - y0) / 2);
        d += ` L ${elbowX - r} ${y0}`;
        d += ` Q ${elbowX} ${y0} ${elbowX} ${y0 + dy * r}`;
        d += ` L ${elbowX} ${y1 - dy * r}`;
        d += ` Q ${elbowX} ${y1} ${elbowX + r} ${y1}`;
        d += ` L ${x1} ${y1}`;
      }
      links += `<path class="pve-nf-link" d="${d}" stroke-width="4"/>`;
      const uplinkRx = Math.max(Number(p.rx) || 0, bridgeRx || 0, hostRx || 0);
      const uplinkTx = Math.max(Number(p.tx) || 0, bridgeTx || 0, hostTx || 0);
      pushBeam(d, "rx", uplinkRx);
      pushBeam(d, "tx", uplinkTx);
    });

    // Host → bridge (straight)
    {
      const d = `M ${hostNode.x + hostNode.r} ${hostNode.y} L ${brNode.x - brNode.r} ${brNode.y}`;
      links += `<path class="pve-nf-link" d="${d}" stroke-width="4"/>`;
      pushBeam(d, "rx", bridgeRx || hostRx);
      pushBeam(d, "tx", bridgeTx || hostTx);
    }

    // Bridge → guests via band bus — ProxMenux path style:
    //   bridge ─H→ spine ─V→ bus ─H→ column ─V→ guest  (Q fillet at EVERY turn)
    const hubX = brNode.x + 44;
    const guestRxSum = guestNodes.reduce((s, g) => s + (Number(g.rx) || 0), 0);
    const guestTxSum = guestNodes.reduce((s, g) => s + (Number(g.tx) || 0), 0);
    const trunkRx = bridgeRx || hostRx || guestRxSum;
    const trunkTx = bridgeTx || hostTx || guestTxSum;
    const busJoinX = hubX + CORNER;

    function pathBridgeToBusJoin(busY) {
      const dy = Math.sign(busY - brNode.y);
      let d = `M ${brNode.x + brNode.r} ${brNode.y}`;
      if (dy !== 0 && Math.abs(busY - brNode.y) > CORNER * 2) {
        d += ` L ${hubX - CORNER} ${brNode.y}`;
        d += ` Q ${hubX} ${brNode.y} ${hubX} ${brNode.y + dy * CORNER}`;
        d += ` L ${hubX} ${busY - dy * CORNER}`;
        d += ` Q ${hubX} ${busY} ${busJoinX} ${busY}`;
      } else {
        d += ` L ${busJoinX} ${busY}`;
      }
      return d;
    }

    function pathGuestStub(g) {
      const busY = g.busY;
      const dropY = guestStubEndY(g);
      const dy = Math.sign(dropY - busY) || 1;
      const r = Math.min(CORNER, Math.abs(dropY - busY) / 2);
      return (
        `M ${g.x - r} ${busY} ` +
        `Q ${g.x} ${busY} ${g.x} ${busY + dy * r} ` +
        `L ${g.x} ${dropY}`
      );
    }

    // #2 splitBranches — full bridge→guest beam path for one guest
    function pathBranchToGuest(g) {
      const busY = g.busY;
      let d = pathBridgeToBusJoin(busY);
      const stubStart = g.x - CORNER;
      if (stubStart > busJoinX + 0.5) d += ` L ${stubStart} ${busY}`;
      const dropY = guestStubEndY(g);
      const dy = Math.sign(dropY - busY) || 1;
      const r = Math.min(CORNER, Math.abs(dropY - busY) / 2);
      d += ` L ${g.x - r} ${busY}`;
      d += ` Q ${g.x} ${busY} ${g.x} ${busY + dy * r}`;
      d += ` L ${g.x} ${dropY}`;
      return d;
    }

    // Shared spine + horizontal bus rail (static links always; beams depend on splitBranches)
    // Bus stops at each column's stub-start (g.x - CORNER), never through g.x.
    bandBuses.forEach((busY) => {
      const bandGuests = guestNodes.filter((g) => g.busY === busY);
      const colXs = [...new Set(bandGuests.map((g) => g.x))].sort((a, b) => a - b);
      let d = pathBridgeToBusJoin(busY);
      let x = busJoinX;
      colXs.forEach((cx) => {
        const stubStart = cx - CORNER;
        if (stubStart > x + 0.5) d += ` L ${stubStart} ${busY}`;
        x = Math.max(x, stubStart);
      });
      links += `<path class="pve-nf-link" d="${d}" stroke-width="3"/>`;
      if (!PVE_NF_ANIM.splitBranches) {
        pushBeam(d, "rx", trunkRx);
        pushBeam(d, "tx", trunkTx);
      }
    });

    // Guest stubs (static links always)
    guestNodes.forEach((g) => {
      const d = pathGuestStub(g);
      links += `<path class="pve-nf-link" d="${d}" stroke-width="3"/>`;
      // No beams when the node label would show 0 B/s
      if (!PVE_NF_ANIM.splitBranches && !isZeroFlowLabel(g.rate)) {
        pushBeam(d, "rx", g.rx);
        pushBeam(d, "tx", g.tx);
      }
    });

    // #2 splitBranches — beams only for guests with non-zero labels (no shared-trunk fallback)
    if (PVE_NF_ANIM.splitBranches) {
      guestNodes.forEach((g) => {
        if (isZeroFlowLabel(g.rate)) return;
        const d = pathBranchToGuest(g);
        pushBeam(d, "rx", g.rx);
        pushBeam(d, "tx", g.tx);
      });
    }

    function nodeHtml(n) {
      const kind = n.kind || "guest";
      const active = n.active !== false;
      const stroke = kind === "nic"
        ? (active ? "var(--pve-nf-amber, #f59e0b)" : "#525252")
        : kind === "host"
          ? "var(--pve-nf-amber, #f59e0b)"
          : "var(--pve-nf-cyan, #06b6d4)";
      const opacity = kind === "nic" && !active ? "0.45" : "1";
      const sw = kind === "host" ? "3" : "2.2";
      const icon = kind === "nic" ? ICONS.nic : kind === "host" ? ICONS.host : kind === "bridge" ? ICONS.bridge : ICONS.guest;
      const scale = kind === "host" ? 1.15 : kind === "nic" ? 0.9 : kind === "bridge" ? 0.82 : 0.74;
      const iconOff = 12 * scale;
      const iface = n.iface || n.name || "";
      const guestAttr = kind === "guest"
        ? ` data-guest="${escH(n.name || "")}" data-vmid="${escH(n.vmid != null ? n.vmid : "")}" data-gtype="${escH(n.kind === "vm" ? "qemu" : "lxc")}"`
        : "";
      // #4 nodePulse — ring breath when node has meaningful traffic (never on 0 B/s labels)
      const hot = PVE_NF_ANIM.nodePulse && active && !isZeroFlowLabel(n.rate)
        && ((Number(n.rate) || 0) >= 2048 || (Number(n.rx) || 0) >= 1024 || (Number(n.tx) || 0) >= 1024);
      const pulse = hot
        ? `<circle class="pve-nf-pulse" cx="${n.x}" cy="${n.y}" r="${n.r + 4}" stroke="${stroke}" fill="none" pointer-events="none"/>`
        : "";
      const nameMax = kind === "guest" ? 17 : kind === "host" ? 10 : 14;
      // Guests above the bus: labels on the outer (top) side so stubs never cross text.
      // Guests below the bus (and all other nodes): labels underneath.
      const aboveBus = kind === "guest" && n.busY != null && n.y < n.busY;
      const nameY = aboveBus ? (n.y - n.r - 18) : (n.y + n.r + 17);
      const subY = aboveBus ? (n.y - n.r - 32) : (n.y + n.r + 32);

      return `
        <g class="pve-nf-node pve-nf-node--${kind} pve-nf-node--clickable${hot ? " pve-nf-node--hot" : ""}" opacity="${opacity}" style="color:${stroke}"
           role="button" tabindex="0" data-kind="${escH(kind)}" data-iface="${escH(iface)}"${guestAttr}>
          <circle class="pve-nf-hit" cx="${n.x}" cy="${n.y}" r="${n.r + 12}" fill="transparent"/>
          ${pulse}
          <circle class="pve-nf-circle" cx="${n.x}" cy="${n.y}" r="${n.r}" stroke="${stroke}" stroke-width="${sw}" fill="rgba(10,14,20,0.92)"/>
          <g transform="translate(${n.x - iconOff}, ${n.y - iconOff}) scale(${scale})" pointer-events="none">${icon}</g>
          <text class="pve-nf-label" x="${n.x}" y="${nameY}" text-anchor="middle" pointer-events="none">${escH(shortName(n.name, nameMax))}</text>
          <text class="pve-nf-sub" x="${n.x}" y="${subY}" text-anchor="middle" pointer-events="none">${escH(n.label || fmtRateBytes(n.rate || 0))}</text>
        </g>`;
    }

    function beamGroup(d, dir, sec, pathLen, bps) {
      if (!sec || sec <= 0) return "";
      const soft = PVE_NF_ANIM.softComet ? " pve-nf-beam--soft" : "";
      const ease = PVE_NF_ANIM.cornerEase ? "cubic-bezier(0.45, 0.05, 0.55, 0.95)" : "linear";
      const base = dir === "tx" ? "pve-nf-beam-base-tx" : "pve-nf-beam-base-rx";
      const mid = (dir === "tx" ? "pve-nf-beam-tx" : "pve-nf-beam-rx") + soft;
      const head = (dir === "tx" ? "pve-nf-beam-head-tx" : "pve-nf-beam-head-rx") + soft;
      const dur = sec.toFixed(2);
      const packets = beamPacketCount(bps, pathLen);
      // #3 softComet — longer head, softer trail dashes
      const dash = PVE_NF_ANIM.softComet ? (packets > 2 ? 5.5 : 7) : (packets > 2 ? 4.5 : 6);
      const gap = Math.max(12, (100 / packets) - dash);
      const headDash = PVE_NF_ANIM.softComet ? Math.max(3, dash * 0.7) : Math.max(2.5, dash * 0.55);
      const headGap = Math.max(12, (100 / packets) - headDash);
      const dashStyle = `stroke-dasharray:${dash} ${gap}`;
      const headStyle = `stroke-dasharray:${headDash} ${headGap}`;
      const span = sec / packets;
      const trail = PVE_NF_ANIM.softComet
        ? [
            { delay: span * 0.34, op: 0.12, sw: 3.2 },
            { delay: span * 0.22, op: 0.22, sw: 2.8 },
            { delay: span * 0.12, op: 0.4, sw: 2.5 },
            { delay: span * 0.05, op: 0.62, sw: 2.3 },
          ]
        : [
            { delay: span * 0.28, op: 0.18, sw: 2.5 },
            { delay: span * 0.16, op: 0.38, sw: 2.5 },
            { delay: span * 0.08, op: 0.62, sw: 2.5 },
          ];
      const trailHtml = trail.map((t) =>
        `<path class="${mid}" d="${d}" stroke-width="${t.sw}" pathLength="100" style="animation-duration:${dur}s;animation-delay:${t.delay.toFixed(2)}s;animation-timing-function:${ease};opacity:${t.op};${dashStyle}"/>`
      ).join("");
      return `<g>
        <path class="${base}" d="${d}" stroke-width="2.5" pathLength="100"/>
        ${trailHtml}
        <path class="${head}" d="${d}" stroke-width="${PVE_NF_ANIM.softComet ? 3.2 : 2.5}" pathLength="100" style="animation-duration:${dur}s;animation-timing-function:${ease};${headStyle}"/>
      </g>`;
    }

    // Beams: cyan download (rx, forward) + amber upload (tx, reverse)
    let beams = "";
    beamPaths.forEach((bp) => {
      beams += beamGroup(bp.d, bp.dir, bp.sec, bp.pathLen, bp.bps);
    });

    return `
      <div class="pve-nf-wrap">
        <svg class="pve-flow-svg pve-nf-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMin meet" role="img" aria-label="Network flow diagram">
          <g class="pve-nf-links">${links}</g>
          ${physNodes.map(nodeHtml).join("")}
          ${nodeHtml(hostNode)}
          ${nodeHtml(brNode)}
          ${guestNodes.map(nodeHtml).join("")}
        </svg>
        <svg class="pve-nf-beams" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMin meet" aria-hidden="true">
          ${beams}
        </svg>
      </div>
      <div class="pve-flow-note">PoC · ProxMenux-style flow · ${shown.length || 0} running guests</div>`;
  }

  // ── Interface Details modal (Network Flow clicks) ────────────────
  function fmtCount(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return "—";
    return Math.round(v).toLocaleString("en-US");
  }

  function fmtIfaceSpeed(speed) {
    const n = Number(speed);
    if (!Number.isFinite(n) || n <= 0) return "—";
    // ProxMenux reports Mbps (e.g. 10000 → 10.0 Gbps)
    if (n >= 1000) return `${(n / 1000).toFixed(1)} Gbps`;
    return `${n} Mbps`;
  }

  function capitalizeWord(s) {
    const t = String(s || "").trim();
    if (!t) return "—";
    return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
  }

  function ifaceBadge(text, tone = "green") {
    const t = String(text || "—");
    return `<span class="pve-if-badge pve-if-badge--${tone}">${escH(t)}</span>`;
  }

  async function fetchPrxNetwork(nodeCfg, { force = false, silent = false } = {}) {
    const key = nodeCfg.groupName;
    const cached = _prxNetCache[key];
    const age = cached ? Date.now() - (cached.at || 0) : Infinity;
    if (!force && cached?.data && age < 20_000) return cached.data;

    const data = await prxApiFetch(nodeCfg, "/api/network", { silent });
    _prxNetCache[key] = { data, at: Date.now() };
    return data;
  }

  async function fetchPrxHardware(nodeCfg, { force = false, silent = true } = {}) {
    const key = nodeCfg.groupName;
    const cached = _prxHwCache[key];
    const age = cached ? Date.now() - (cached.at || 0) : Infinity;
    if (!force && cached?.data && age < 30_000) return cached.data;
    const data = await prxApiFetch(nodeCfg, "/api/hardware", { silent });
    _prxHwCache[key] = { data, at: Date.now() };
    return data;
  }

  async function fetchPrxVms(nodeCfg, { force = false, silent = false } = {}) {
    const key = nodeCfg.groupName;
    const cached = _prxVmsCache[key];
    const age = cached ? Date.now() - (cached.at || 0) : Infinity;
    if (!force && cached?.byVmid && age < 60_000) return cached;

    const raw = await prxApiFetch(nodeCfg, "/api/vms", { silent });
    const list = Array.isArray(raw) ? raw : (raw.vms || []);
    const byVmid = {};
    list.forEach((g) => {
      if (g?.vmid == null) return;
      const id = String(g.vmid);
      byVmid[id] = mergePrxUpdateCheck(nodeCfg, id, g.update_check || null);
    });
    // Keep live overrides for guests ProxMenux omitted from this payload
    const overrides = _liveUpdateOverride[key] || {};
    Object.keys(overrides).forEach((id) => {
      if (Object.prototype.hasOwnProperty.call(byVmid, id)) return;
      byVmid[id] = mergePrxUpdateCheck(nodeCfg, id, null);
    });
    const entry = { at: Date.now(), byVmid, list };
    _prxVmsCache[key] = entry;
    return entry;
  }

  function updateCheckTimeMs(uc) {
    const raw = uc?.last_check ?? uc?.last_checked ?? uc?.last_checked_iso ?? 0;
    if (typeof raw === "string" && raw && Number.isNaN(Number(raw))) {
      const parsed = Date.parse(raw);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    const n = Number(raw) || 0;
    if (!n) return 0;
    return n < 1e12 ? n * 1000 : n;
  }

  function getLiveUpdateOverride(nodeCfg, vmid) {
    const key = nodeCfg.groupName;
    const id = String(vmid);
    const entry = _liveUpdateOverride[key]?.[id];
    if (!entry) return null;
    if (Date.now() - entry.at > LIVE_UPDATE_OVERRIDE_TTL_MS) {
      delete _liveUpdateOverride[key][id];
      persistLiveUpdateOverrides();
      return null;
    }
    return entry;
  }

  function setLiveUpdateOverride(nodeCfg, vmid, uc) {
    const key = nodeCfg.groupName;
    const id = String(vmid);
    if (!_liveUpdateOverride[key]) _liveUpdateOverride[key] = {};
    _liveUpdateOverride[key][id] = { at: Date.now(), uc: uc || null };
    setGuestUpdateCheck(nodeCfg, vmid, uc || null);
    persistLiveUpdateOverrides();
  }

  /** Prefer a recent live Recheck over stale ProxMenux scanner counts. */
  function mergePrxUpdateCheck(nodeCfg, vmid, incoming) {
    const override = getLiveUpdateOverride(nodeCfg, vmid);
    if (!override) return incoming || null;
    const prxAt = updateCheckTimeMs(incoming);
    const liveCount = Number(override.uc?.count) || 0;
    const prxCount = Number(incoming?.count) || 0;
    // MONITOR often bumps last_check while still returning cached package counts.
    // Only drop our live result when it rescanned AFTER us AND reports <= our count.
    if (prxAt > override.at && prxCount <= liveCount) {
      delete _liveUpdateOverride[nodeCfg.groupName][String(vmid)];
      persistLiveUpdateOverrides();
      return incoming || null;
    }
    return override.uc;
  }

  function getGuestUpdateCheck(nodeCfg, vmid) {
    const override = getLiveUpdateOverride(nodeCfg, vmid);
    if (override) return override.uc; // may be {count:0} (cleared) or null
    return _prxVmsCache[nodeCfg.groupName]?.byVmid?.[String(vmid)] || null;
  }

  function setGuestUpdateCheck(nodeCfg, vmid, uc) {
    const key = nodeCfg.groupName;
    if (!_prxVmsCache[key]) _prxVmsCache[key] = { at: Date.now(), byVmid: {}, list: [] };
    _prxVmsCache[key].byVmid[String(vmid)] = uc || null;
    _prxVmsCache[key].at = Date.now();
  }

  function normalizeUpdateCheck(uc) {
    if (!uc || typeof uc !== "object") return null;
    const count = Number(uc.count) || 0;
    const available = uc.available === true || count > 0;
    if (!available && count <= 0) return null;
    const packages = Array.isArray(uc.packages) ? uc.packages : [];
    return {
      available: true,
      count: count || packages.length,
      security_count: Number(uc.security_count) || 0,
      last_check: uc.last_check || uc.last_checked || uc.last_checked_iso || null,
      packages,
    };
  }

  function parseAptUpgradableList(text) {
    const packages = [];
    const clean = String(text || "").replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
    const re = /^([a-z0-9][a-z0-9+._-]*)\/\S+\s+(\S+)\s+.*\[upgradable from:\s*([^\]]+)\]/gim;
    let m;
    while ((m = re.exec(clean))) {
      packages.push({
        name: m[1],
        latest: m[2],
        current: String(m[3] || "").trim(),
        security: /security/i.test(m[0]),
      });
    }
    return packages;
  }

  function paintGuestUpdateBadges(nodeCfg) {
    const group = findGroupContainer(nodeCfg.groupName);
    if (!group) return;
    group.querySelectorAll(".pve-g-row[data-vmid]").forEach((row) => {
      const vmid = row.getAttribute("data-vmid");
      const meta = row.querySelector(".pve-g-row-meta");
      if (!meta) return;
      const uc = normalizeUpdateCheck(getGuestUpdateCheck(nodeCfg, vmid));
      const html = uc ? guestUpdatesBadgeHtml(uc) : "";
      const existing = meta.querySelector(".pve-g-updates");
      if (!html) {
        existing?.remove();
        return;
      }
      if (existing) existing.outerHTML = html;
      else meta.insertAdjacentHTML("beforeend", html);
    });
  }

  // Quietly live-probe guests that still show update badges (MONITOR data is often stale).
  const _bgUpdateProbeAt = {};
  const BG_UPDATE_PROBE_COOLDOWN_MS = 10 * 60 * 1000;
  let _bgUpdateProbeChain = Promise.resolve();

  function scheduleStaleUpdateReconcile(nodeCfg, pveData) {
    const key = nodeCfg.groupName;
    const now = Date.now();
    if (now - (_bgUpdateProbeAt[key] || 0) < BG_UPDATE_PROBE_COOLDOWN_MS) return;
    const guests = [
      ...(pveData?.lxcs || []).map((g) => ({ ...g, _type: "lxc" })),
      ...(pveData?.vms || []).map((g) => ({ ...g, _type: "qemu" })),
    ].filter((g) => g?.status === "running" && g.vmid != null);

    const targets = guests.filter((g) => {
      if (getLiveUpdateOverride(nodeCfg, g.vmid)) return false;
      const uc = normalizeUpdateCheck(getGuestUpdateCheck(nodeCfg, g.vmid));
      return !!(uc && uc.count > 0);
    });
    if (!targets.length) return;

    _bgUpdateProbeAt[key] = now;
    _bgUpdateProbeChain = _bgUpdateProbeChain.then(async () => {
      for (let i = 0; i < targets.length; i++) {
        const g = targets[i];
        if (i) await new Promise((r) => setTimeout(r, 1200));
        try {
          await refreshGuestUpdateStatus(nodeCfg, g._type, g.vmid);
        } catch (err) {
          console.warn("[PveWidget] background update probe failed:", g.vmid, err?.message || err);
        }
      }
    }).catch(() => {});
  }

  const _bulkRecheckBusy = {};

  async function runBulkGuestUpdateRecheck(nodeCfg, { onProgress } = {}) {
    const key = nodeCfg.groupName;
    if (_bulkRecheckBusy[key]) return _bulkRecheckBusy[key];

    const cache = _nodeCache[key]?.pveData;
    const lxcs = (cache?.lxcs || [])
      .filter((g) => g?.status === "running" && g.vmid != null)
      .map((g) => ({ ...g, _type: "lxc" }))
      .sort((a, b) => String(a.name || a.vmid).localeCompare(String(b.name || b.vmid), undefined, { sensitivity: "base" }));

    if (!lxcs.length) {
      onProgress?.({ done: 0, total: 0, label: "No running LXCs" });
      return { done: 0, total: 0 };
    }

    _bulkRecheckBusy[key] = (async () => {
      onProgress?.({ done: 0, total: lxcs.length, label: `0 / ${lxcs.length}` });
      try {
        await fetchPrxVms(nodeCfg, { force: true, silent: true });
      } catch {}

      let done = 0;
      for (const g of lxcs) {
        try {
          await refreshGuestUpdateStatus(nodeCfg, "lxc", g.vmid, { skipPrxFetch: true });
        } catch (err) {
          console.warn("[PveWidget] bulk recheck failed:", g.vmid, err?.message || err);
        }
        done += 1;
        onProgress?.({
          done,
          total: lxcs.length,
          label: `${done} / ${lxcs.length}`,
          current: g.name || g.vmid,
        });
        if (done < lxcs.length) await new Promise((r) => setTimeout(r, 400));
      }
      paintGuestUpdateBadges(nodeCfg);
      return { done, total: lxcs.length };
    })().finally(() => { delete _bulkRecheckBusy[key]; });

    return _bulkRecheckBusy[key];
  }

  async function issuePrxTerminalTicket(nodeCfg, { silent = false } = {}) {
    const targets = prxTargets(nodeCfg);
    if (!targets.length) throw new Error("No ProxMenux MONITOR URL configured");

    let token = getStoredPrxToken(nodeCfg);
    const issue = async (base, bearer) => {
      const headers = { "Content-Type": "application/json", Accept: "application/json" };
      if (bearer) headers.Authorization = `Bearer ${bearer}`;
      const res = await fetch(`${base}/api/terminal/ticket`, {
        method: "POST",
        headers,
        cache: "no-store",
        signal: (() => { const c = new AbortController(); setTimeout(() => c.abort(), 10000); return c.signal; })(),
      });
      if (res.status === 401 || res.status === 403) return { auth: true, ticket: null };
      if (!res.ok) return { auth: false, ticket: null };
      const j = await res.json().catch(() => ({}));
      return { auth: false, ticket: j?.ticket || null };
    };

    const tryAll = async (bearer) => {
      let authReject = false;
      for (const base of targets) {
        try {
          // Prefer hosts that answer health, but don't hard-fail if health is flaky.
          try {
            const h = await fetch(`${base}/api/terminal/health`, {
              cache: "no-store",
              signal: (() => { const c = new AbortController(); setTimeout(() => c.abort(), 4000); return c.signal; })(),
            });
            if (!h.ok) continue;
          } catch {
            // Still attempt ticket — some builds omit health.
          }
          const out = await issue(base, bearer);
          if (out.ticket) {
            nodeCfg.activePrxUrl = base;
            return out.ticket;
          }
          if (out.auth) authReject = true;
        } catch {}
      }
      return authReject ? "__auth__" : null;
    };

    let ticket = await tryAll(token);
    if (ticket && ticket !== "__auth__") return ticket;

    if (!silent && (ticket === "__auth__" || !token)) {
      const entered = await promptPrxTokenGuide(nodeCfg, { rejected: ticket === "__auth__" });
      if (entered) {
        rememberPrxToken(nodeCfg, entered);
        token = entered;
        ticket = await tryAll(token);
        if (ticket && ticket !== "__auth__") return ticket;
      }
    }
    if (ticket === "__auth__") throw new Error("ProxMenux token rejected");
    throw new Error("ProxMenux terminal ticket required");
  }

  /** Live package check via ProxMenux host shell (`pct exec` / `qm guest exec`). */
  async function probeGuestPackageUpdates(nodeCfg, type, vmid, { timeoutMs = 25000 } = {}) {
    const id = Number(vmid);
    if (!Number.isInteger(id) || id <= 0) throw new Error("Invalid VMID");
    const ticket = await issuePrxTerminalTicket(nodeCfg, { silent: false });
    const isLxc = type !== "qemu";
    const cmd = isLxc
      ? `pct exec ${id} -- bash -lc 'echo __HP_UPD_START__; apt list --upgradable 2>/dev/null | grep -v "^Listing"; echo __HP_UPD_END__'\r`
      : `qm guest exec ${id} -- bash -lc 'echo __HP_UPD_START__; apt list --upgradable 2>/dev/null | grep -v "^Listing"; echo __HP_UPD_END__'\r`;

    return new Promise((resolve, reject) => {
      let settled = false;
      let buf = "";
      let ws;
      try {
        ws = new WebSocket(`${prxWsBase(getPrxUrl(nodeCfg))}?ticket=${encodeURIComponent(ticket)}`);
      } catch (err) {
        reject(err);
        return;
      }

      const done = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { ws.close(); } catch {}
        fn(arg);
      };

      const timer = setTimeout(() => done(reject, new Error("Update check timed out")), timeoutMs);

      ws.onopen = () => {
        setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try { ws.send(JSON.stringify({ type: "ping" })); } catch {}
            ws.send(cmd);
          }
        }, 280);
      };

      ws.onmessage = (ev) => {
        const raw = typeof ev.data === "string" ? ev.data : "";
        if (!raw) return;
        if (raw.includes('"type":"pong"') || raw.includes('"type": "pong"')) return;
        buf += raw;
        const clean = buf.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
        const start = clean.indexOf("__HP_UPD_START__");
        const end = clean.indexOf("__HP_UPD_END__");
        if (start < 0 || end <= start) return;
        const body = clean.slice(start + "__HP_UPD_START__".length, end);
        const packages = parseAptUpgradableList(body);
        const count = packages.length;
        done(resolve, {
          available: count > 0,
          count,
          security_count: packages.filter((p) => p.security).length,
          last_check: Date.now(),
          packages,
        });
      };

      ws.onerror = () => done(reject, new Error("Terminal socket error during update check"));
      ws.onclose = () => {
        if (!settled) done(reject, new Error("Terminal closed before update check finished"));
      };
    });
  }

  async function refreshGuestUpdateStatus(nodeCfg, type, vmid, { skipPrxFetch = false } = {}) {
    // Refresh MONITOR inventory first, then live-probe so our result isn't
    // immediately overwritten by a concurrent /api/vms poll.
    if (!skipPrxFetch) {
      try {
        await fetchPrxVms(nodeCfg, { force: true, silent: true });
      } catch {}
    }

    let live = null;
    let liveErr = null;
    try {
      live = await probeGuestPackageUpdates(nodeCfg, type, vmid);
    } catch (err) {
      liveErr = err;
      console.warn("[PveWidget] live update probe failed:", err);
    }

    if (live) {
      // Always persist an explicit live result (incl. count:0) so stale MONITOR
      // payloads cannot revive purple badges until they report <= our count.
      const store = {
        available: live.count > 0,
        count: live.count || 0,
        security_count: live.security_count || 0,
        last_check: live.last_check || Date.now(),
        packages: live.count > 0 ? (live.packages || []) : [],
        _live: true,
      };
      setLiveUpdateOverride(nodeCfg, vmid, store);
      paintGuestUpdateBadges(nodeCfg);
      return store;
    }

    // Live probe failed — do NOT fall back to stale MONITOR counts as "success".
    if (liveErr) {
      const override = getLiveUpdateOverride(nodeCfg, vmid);
      if (override?.uc) {
        paintGuestUpdateBadges(nodeCfg);
        return override.uc;
      }
      throw liveErr;
    }
    const cleared = {
      available: false,
      count: 0,
      security_count: 0,
      last_check: Date.now(),
      packages: [],
      _live: true,
    };
    setLiveUpdateOverride(nodeCfg, vmid, cleared);
    paintGuestUpdateBadges(nodeCfg);
    return cleared;
  }

  function guestUpdatesBadgeHtml(uc, { chevron = false, compact = false, clickable = false } = {}) {
    const n = normalizeUpdateCheck(uc);
    if (!n || n.count <= 0) return "";
    const label = `${n.count} update${n.count === 1 ? "" : "s"}`;
    const box = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M22 7.7c0-.6-.4-1.2-.8-1.5l-6.3-3.9a1.72 1.72 0 0 0-1.7 0l-10.3 6c-.5.2-.9.8-.9 1.4v6.6c0 .5.4 1.2.8 1.5l6.3 3.9a1.72 1.72 0 0 0 1.7 0l10.3-6c.5-.3.9-1 .9-1.5Z"/></svg>`;
    const tip = chevron ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>` : "";
    const cls = `pve-g-updates${compact ? " pve-g-updates--compact" : ""}${clickable ? " pve-g-updates--btn" : ""}`;
    if (clickable) {
      return `<button type="button" class="${cls}" data-gc-goto="updates" title="${escH(label)} available">${box}<span>${escH(label)}</span>${tip}</button>`;
    }
    return `<span class="${cls}" title="${escH(label)} available">${box}<span>${escH(label)}</span>${tip}</span>`;
  }

  function buildGuestUpdatesPane(guest, updateCheck) {
    const raw = updateCheck && typeof updateCheck === "object" ? updateCheck : null;
    const uc = normalizeUpdateCheck(raw);
    const count = uc?.count || 0;
    const checkedAt = raw?.last_check || uc?.last_check || null;
    const checked = checkedAt ? new Date(checkedAt).toLocaleString() : "—";
    const recheckBtn = `<button type="button" class="pve-gc-updates-recheck" data-gc-recheck title="Re-scan pending packages on this guest">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>
      Recheck
    </button>`;

    if (!uc || count <= 0) {
      return `<div class="pve-gc-section">
        <div class="pve-gc-updates-card">
          <div class="pve-gc-updates-hdr">
            <div class="pve-gc-updates-title">
              <span class="pve-gc-updates-ico"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 7.7c0-.6-.4-1.2-.8-1.5l-6.3-3.9a1.72 1.72 0 0 0-1.7 0l-10.3 6c-.5.2-.9.8-.9 1.4v6.6c0 .5.4 1.2.8 1.5l6.3 3.9a1.72 1.72 0 0 0 1.7 0l10.3-6c.5-.3.9-1 .9-1.5Z"/></svg></span>
              Pending package updates
            </div>
            <div class="pve-gc-updates-hdr-actions">
              ${recheckBtn}
            </div>
          </div>
          <div class="pve-gc-updates-meta">Last checked: ${escH(checked)} · Apply with <code>Open Terminal → apt update &amp;&amp; apt upgrade</code> · status refreshes automatically</div>
          <div class="pve-gc-updates-empty">No pending package updates reported for this guest.</div>
        </div>
      </div>`;
    }

    const pkgs = uc.packages || [];
    const showList = pkgs.length > 0 && !(uc.count > pkgs.length);

    let body;
    if (showList) {
      body = `<div class="pve-gc-updates-list">
        ${pkgs.map((p) => {
          const name = p.name || p.Package || "package";
          const cur = p.current || p.current_version || "—";
          const lat = p.latest || p.latest_version || p.new_version || "—";
          const sec = p.security
            ? `<svg class="pve-gc-updates-sec" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-label="Security update"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`
            : `<svg class="pve-gc-updates-pkg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>`;
          return `<div class="pve-gc-updates-row">
            <div class="pve-gc-updates-name">${sec}<span>${escH(name)}</span></div>
            <div class="pve-gc-updates-ver"><span>${escH(cur)}</span><span class="pve-gc-updates-arrow">→</span><span class="pve-gc-updates-latest">${escH(lat)}</span></div>
          </div>`;
        }).join("")}
      </div>`;
    } else {
      body = `<div class="pve-gc-updates-summary">
        <div><strong>${uc.count}</strong> package${uc.count === 1 ? "" : "s"} pending</div>
        ${uc.security_count > 0 ? `<div class="pve-gc-updates-sec-line"><strong>${uc.security_count}</strong> security</div>` : ""}
      </div>`;
    }

    return `<div class="pve-gc-section">
      <div class="pve-gc-updates-card">
        <div class="pve-gc-updates-hdr">
          <div class="pve-gc-updates-title">
            <span class="pve-gc-updates-ico"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 7.7c0-.6-.4-1.2-.8-1.5l-6.3-3.9a1.72 1.72 0 0 0-1.7 0l-10.3 6c-.5.2-.9.8-.9 1.4v6.6c0 .5.4 1.2.8 1.5l6.3 3.9a1.72 1.72 0 0 0 1.7 0l10.3-6c.5-.3.9-1 .9-1.5Z"/></svg></span>
            Pending package updates
          </div>
          <div class="pve-gc-updates-hdr-actions">
            <span class="pve-gc-updates-total">${uc.count} total</span>
            ${recheckBtn}
          </div>
        </div>
        <div class="pve-gc-updates-meta">Last checked: ${escH(checked)} · Apply with <code>Open Terminal → apt update &amp;&amp; apt upgrade</code> · status refreshes automatically</div>
        ${body}
      </div>
    </div>`;
  }

  function resolveIfaceFromNetwork(netData, target) {
    const kind = target.kind || "bridge";
    const ifaceName = target.iface || "";
    const guestName = target.guest || "";
    const vmid = target.vmid != null && target.vmid !== "" ? String(target.vmid) : "";

    const bridges = netData?.bridge_interfaces || [];
    const physical = netData?.physical_interfaces || [];
    const guests = netData?.vm_lxc_interfaces || [];

    if (kind === "nic") {
      return pickPrxPhysical(netData, ifaceName);
    }

    if (kind === "guest") {
      let hit = null;
      if (vmid) hit = guests.find(i => String(i.vmid) === vmid);
      if (!hit && guestName) {
        hit = guests.find(i => i.vm_name === guestName)
          || guests.find(i => String(i.vm_name || "").toLowerCase() === guestName.toLowerCase());
      }
      if (!hit && ifaceName) hit = guests.find(i => i.name === ifaceName);
      return hit || null;
    }

    // host + bridge → bridge record
    const want = ifaceName || netData?.hostname || "";
    return bridges.find(i => i.name === want)
      || bridges.find(i => String(i.name).toLowerCase() === String(want).toLowerCase())
      || bridges[0]
      || null;
  }

  function closeIfaceDetails() {
    if (_ifaceModal) {
      const modal = _ifaceModal.querySelector(".pve-if-modal");
      if (modal?._ifaceRangeOutside) {
        document.removeEventListener("click", modal._ifaceRangeOutside, true);
        modal._ifaceRangeOutside = null;
      }
      _ifaceModal.remove();
      _ifaceModal = null;
    }
    document.removeEventListener("keydown", _ifaceEscHandler, true);
  }

  function _ifaceEscHandler(e) {
    if (e.key !== "Escape") return;
    if (_termModal && document.body.contains(_termModal)) return;
    if (_guestModal && document.body.contains(_guestModal)) return;
    closeIfaceDetails();
  }

  function bindIfaceFlowNodes(host, nodeCfg) {
    host.querySelectorAll(".pve-nf-node--clickable").forEach((node) => {
      const open = (e) => {
        e.preventDefault();
        e.stopPropagation();
        openIfaceDetails(nodeCfg, {
          kind: node.getAttribute("data-kind") || "bridge",
          iface: node.getAttribute("data-iface") || "",
          guest: node.getAttribute("data-guest") || "",
          vmid: node.getAttribute("data-vmid") || "",
          guestType: node.getAttribute("data-gtype") || "",
        });
      };
      node.addEventListener("click", open);
      node.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(e); }
      });
    });
  }

  async function openIfaceDetails(nodeCfg, target) {
    closeIfaceDetails();

    const backdrop = document.createElement("div");
    backdrop.className = "pve-if-backdrop";
    const modal = document.createElement("div");
    modal.className = "pve-if-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.innerHTML = `
      <div class="pve-if-loading">Loading interface details…</div>
      <button type="button" class="pve-if-close" aria-label="Close">×</button>`;
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    _ifaceModal = backdrop;
    document.addEventListener("keydown", _ifaceEscHandler, true);

    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closeIfaceDetails(); });
    modal.querySelector(".pve-if-close")?.addEventListener("click", closeIfaceDetails);

    try {
      const netData = await fetchPrxNetwork(nodeCfg);
      let iface = resolveIfaceFromNetwork(netData, target);
      if (!iface) {
        const name = target.iface || target.guest || "unknown";
        iface = {
          name: target.kind === "guest" ? (target.iface && /^veth|tap/i.test(target.iface) ? target.iface : name) : name,
          type: target.kind === "guest" ? "virtual" : (target.kind === "nic" ? "physical" : "bridge"),
          status: "unknown",
          speed: 0,
          duplex: "unknown",
          mtu: null,
          mac_address: "",
          addresses: [],
          bytes_recv: 0,
          bytes_sent: 0,
          packets_recv: 0,
          packets_sent: 0,
          errors_in: 0,
          errors_out: 0,
          drops_in: 0,
          drops_out: 0,
          bridge_members: [],
          vm_name: target.guest || "",
          vmid: target.vmid || "",
          vm_type: target.guestType || "",
        };
      }
      iface = enrichIfaceRecord(iface, target, nodeCfg);

      // Fill gaps from Glances + PVE network config (ProxMenux sometimes omits NICs)
      const glancesNet = _nodeCache[nodeCfg.groupName]?.glancesData?.network || [];
      iface = enrichIfaceFromGlances(iface, glancesNet, iface.name || target.iface);
      if (target.kind === "nic" || String(iface.type || "").toLowerCase() === "physical") {
        const pveNet = await fetchPveNetworkConfig(nodeCfg);
        iface = enrichIfaceFromPveNet(iface, pveNet, iface.name || target.iface);
        // Keep displayed name on the resolved ProxMenux record
        if (iface.name) target.iface = iface.name;
      }

      // Prefer real veth name from ProxMenux; keep guest click target in sync
      if (target.kind === "guest" && iface.name) target.iface = iface.name;

      const timeframe = "week";
      let rrd = [];
      try {
        rrd = await fetchIfaceRrd(nodeCfg, target, iface, timeframe);
      } catch (rrdErr) {
        console.warn("[PveWidget] iface RRD failed:", rrdErr);
        rrd = [];
      }
      renderIfaceDetails(modal, nodeCfg, iface, target, rrd, timeframe);
    } catch (err) {
      console.warn("[PveWidget] iface details failed:", err);
      modal.innerHTML = `
        <button type="button" class="pve-if-close" aria-label="Close">×</button>
        <div class="pve-if-loading">Couldn’t load interface details.<br><span class="pve-if-err">${escH(err?.message || err)}</span></div>`;
      modal.querySelector(".pve-if-close")?.addEventListener("click", closeIfaceDetails);
    }
  }

  function renderIfaceDetails(modal, nodeCfg, iface, target, rrdPoints, timeframe = "week") {
    const kind = target.kind || "bridge";
    const isBridge = String(iface.type || "").toLowerCase() === "bridge" || kind === "bridge" || kind === "host";
    const isGuest = kind === "guest"
      || !!(iface.vm_name || iface.vmid || target.guest || target.vmid)
      || /^(veth|tap)/i.test(iface.name || "")
      || /virtual|veth|lxc|qemu/i.test(String(iface.type || ""));
    const isNic = kind === "nic" || String(iface.type || "").toLowerCase() === "physical";
    const range = ifaceRangeMeta(timeframe);

    // ProxMenux titles use the interface name: "veth206i0 - Interface Details"
    const titleName = iface.name || target.iface || target.guest || "interface";

    const statusRaw = String(iface.status || "unknown").toUpperCase();
    const statusTone = /up/i.test(statusRaw) ? "green" : (/down/i.test(statusRaw) ? "red" : "muted");
    const typeLabel = ifaceDisplayType(iface, isGuest ? "guest" : kind);
    const typeTone = ifaceTypeTone(typeLabel, isGuest ? "guest" : kind);

    const addrs = Array.isArray(iface.addresses) ? iface.addresses : [];
    const members = Array.isArray(iface.bridge_members) ? iface.bridge_members : [];

    const guestVmid = iface.vmid || target.vmid || resolveVmidFromCache(nodeCfg, iface.vm_name || target.guest, "");
    const canChart = isBridge || isNic || (isGuest && guestVmid);
    const useRrd = canChart && (rrdPoints || []).length >= 2;
    const vols = useRrd ? sumRrdVolumes(rrdPoints) : null;
    const rxBytes = vols ? vols.rx : (Number(iface.bytes_recv) || 0);
    const txBytes = vols ? vols.tx : (Number(iface.bytes_sent) || 0);
    const trafficLabel = useRrd
      ? `Network Traffic Statistics (${range.title})`
      : "Network Traffic Statistics";
    const chartLegend = useRrd
      ? `<div class="pve-if-chart-legend">
           <span class="pve-net-legend-item"><i class="pve-net-swatch pve-net-swatch--rx"></i>Received</span>
           <span class="pve-net-legend-item"><i class="pve-net-swatch pve-net-swatch--tx"></i>Sent</span>
         </div>`
      : "";
    const chartHtml = useRrd
      ? buildTrafficChart(rrdPoints, {
          height: 180,
          pad: { t: 14, r: 12, b: 44, l: 40 },
          className: "pve-net-traffic-svg pve-if-chart-svg",
          timeframe: range.id,
        })
      : `<div class="pve-net-empty pve-if-chart-empty">Per-interface history isn’t available — showing lifetime counters above.</div>`;

    const routerIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="20" height="8" x="2" y="14" rx="2"></rect><path d="M6.01 18H6"></path><path d="M10.01 18H10"></path><path d="M15 10v4"></path><path d="M17.84 7.17a4 4 0 0 0-5.66 0"></path><path d="M20.66 4.34a8 8 0 0 0-11.31 0"></path></svg>`;
    const chevronIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>`;
    const checkIcon = `<svg class="pve-if-range-check" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"></path></svg>`;

    const rangeMenu = IFACE_RANGES.map(r => `
      <button type="button" class="pve-if-range-opt${r.id === range.id ? " is-active" : ""}" role="option" aria-selected="${r.id === range.id ? "true" : "false"}" data-range="${escH(r.id)}">
        <span>${escH(r.label)}</span>
        ${r.id === range.id ? checkIcon : `<span class="pve-if-range-check-spacer" aria-hidden="true"></span>`}
      </button>`).join("");

    const guestLabel = iface.vm_name || target.guest || "";
    const guestBadge = guestKindBadge(iface, target, nodeCfg);
    const guestNameRow = (isGuest && guestLabel)
      ? `<div>
           <div class="pve-if-label">VM/LXC Name</div>
           <div class="pve-if-val pve-if-guest-name">
             <span class="pve-if-guest-link">${escH(guestLabel)}</span>
             ${ifaceBadge(guestBadge, "blue")}
           </div>
         </div>`
      : "";

    const ipSection = addrs.length
      ? `<div class="pve-if-section">
          <h3 class="pve-if-section-title">IP Addresses</h3>
          <div class="pve-if-ips">${addrs.map(a => `
            <div class="pve-if-ip">
              <div class="pve-if-ip-addr">${escH(a.ip || a.address || "—")}</div>
              <div class="pve-if-ip-mask">Netmask: ${escH(a.netmask || a.mask || "—")}</div>
            </div>`).join("")}</div>
        </div>`
      : "";

    const membersBlock = isBridge
      ? `<div class="pve-if-section">
          <h3 class="pve-if-section-title">Bridge Configuration</h3>
          <div class="pve-if-muted" style="margin-bottom:8px">Virtual Member Interfaces</div>
          <div class="pve-if-members">
            ${members.length
              ? members.map(m => ifaceBadge(typeof m === "string" ? m : (m.name || m), "green")).join("")
              : `<span class="pve-if-muted">No members reported</span>`}
          </div>
        </div>`
      : "";

    // Keep enriched iface on ctx so range changes keep working
    const enriched = { ...iface, vmid: guestVmid || iface.vmid };
    modal._ifaceCtx = { nodeCfg, iface: enriched, target: { ...target, vmid: guestVmid || target.vmid }, timeframe: range.id };
    modal.innerHTML = `
      <button type="button" class="pve-if-close" aria-label="Close">×</button>
      <div class="pve-if-hdr">
        <div>
          <h2 class="pve-if-title">${routerIcon}<span>${escH(titleName)} - Interface Details</span></h2>
          <p class="pve-if-sub">View detailed information and network traffic statistics for this interface</p>
        </div>
        <div class="pve-if-range-wrap">
          <button type="button" class="pve-if-range" aria-haspopup="listbox" aria-expanded="false" aria-label="Traffic time range">
            <span class="pve-if-range-label">${escH(range.label)}</span>
            ${chevronIcon}
          </button>
          <div class="pve-if-range-menu" role="listbox" hidden>${rangeMenu}</div>
        </div>
      </div>

      <div class="pve-if-body">
        <div class="pve-if-section">
          <h3 class="pve-if-section-title">Basic Information</h3>
          <div class="pve-if-grid">
            <div><div class="pve-if-label">Interface Name</div><div class="pve-if-val">${escH(iface.name || "—")}</div></div>
            <div><div class="pve-if-label">Type</div><div>${ifaceBadge(typeLabel, typeTone)}</div></div>
            ${guestNameRow}
            <div><div class="pve-if-label">Status</div><div>${ifaceBadge(statusRaw, statusTone)}</div></div>
            <div><div class="pve-if-label">Speed</div><div class="pve-if-val">${escH(fmtIfaceSpeed(iface.speed))}</div></div>
            <div><div class="pve-if-label">Duplex</div><div class="pve-if-val pve-if-val--cap">${escH(capitalizeWord(iface.duplex))}</div></div>
            <div><div class="pve-if-label">MTU</div><div class="pve-if-val">${escH(iface.mtu != null ? iface.mtu : "—")}</div></div>
            <div class="pve-if-span2"><div class="pve-if-label">MAC Address</div><div class="pve-if-val pve-if-mono">${escH(iface.mac_address || "—")}</div></div>
          </div>
        </div>

        ${ipSection}

        <div class="pve-if-section">
          <h3 class="pve-if-section-title">${escH(trafficLabel)}</h3>
          <div class="pve-if-traffic-sum">
            <div>
              <div class="pve-if-label">Bytes Received</div>
              <div class="pve-if-traffic-rx">${escH(fmtBytes(rxBytes))}</div>
            </div>
            <div>
              <div class="pve-if-label">Bytes Sent</div>
              <div class="pve-if-traffic-tx">${escH(fmtBytes(txBytes))}</div>
            </div>
          </div>
          <div class="pve-if-chart">${chartLegend}${chartHtml}</div>
          <div class="pve-if-packets">
            <div><div class="pve-if-label">Packets Received</div><div class="pve-if-val">${escH(fmtCount(iface.packets_recv))}</div></div>
            <div><div class="pve-if-label">Packets Sent</div><div class="pve-if-val">${escH(fmtCount(iface.packets_sent))}</div></div>
            <div><div class="pve-if-label">Errors In</div><div class="pve-if-val pve-if-err-val">${escH(fmtCount(iface.errors_in))}</div></div>
            <div><div class="pve-if-label">Errors Out</div><div class="pve-if-val pve-if-err-val">${escH(fmtCount(iface.errors_out))}</div></div>
            <div><div class="pve-if-label">Drops In</div><div class="pve-if-val pve-if-drop-val">${escH(fmtCount(iface.drops_in))}</div></div>
            <div><div class="pve-if-label">Drops Out</div><div class="pve-if-val pve-if-drop-val">${escH(fmtCount(iface.drops_out))}</div></div>
          </div>
        </div>

        ${membersBlock}
      </div>`;

    modal.querySelector(".pve-if-close")?.addEventListener("click", closeIfaceDetails);
    bindIfaceRangeMenu(modal);
  }

  function bindIfaceRangeMenu(modal) {
    if (modal._ifaceRangeOutside) {
      document.removeEventListener("click", modal._ifaceRangeOutside, true);
      modal._ifaceRangeOutside = null;
    }

    const wrap = modal.querySelector(".pve-if-range-wrap");
    const btn = modal.querySelector(".pve-if-range");
    const menu = modal.querySelector(".pve-if-range-menu");
    if (!wrap || !btn || !menu) return;

    const setOpen = (open) => {
      menu.hidden = !open;
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      wrap.classList.toggle("is-open", open);
    };

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      setOpen(menu.hidden);
    });

    menu.querySelectorAll("[data-range]").forEach((opt) => {
      opt.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = opt.getAttribute("data-range");
        setOpen(false);
        const ctx = modal._ifaceCtx;
        if (!ctx || !id || ctx.timeframe === id) return;

        const labelEl = btn.querySelector(".pve-if-range-label");
        if (labelEl) labelEl.textContent = ifaceRangeMeta(id).label;
        btn.disabled = true;
        try {
          const rrd = await fetchIfaceRrd(ctx.nodeCfg, ctx.target, ctx.iface, id);
          renderIfaceDetails(modal, ctx.nodeCfg, ctx.iface, ctx.target, rrd, id);
        } catch (err) {
          console.warn("[PveWidget] iface range RRD failed:", err);
          renderIfaceDetails(modal, ctx.nodeCfg, ctx.iface, ctx.target, [], id);
        }
      });
    });

    const onOutside = (e) => {
      if (!wrap.contains(e.target)) setOpen(false);
    };
    document.addEventListener("click", onOutside, true);
    modal._ifaceRangeOutside = onOutside;
  }

  function fmtUptimeFull(sec) {
    if (sec == null || sec < 0) return "—";
    const s = Math.floor(sec);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${d}d ${h}h ${m}m`;
  }

  function ringGauge(pct, color, size = 64) {
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    const r = 22;
    const c = 2 * Math.PI * r;
    const dash = (p / 100) * c;
    return `<svg class="pve-g-ring" width="${size}" height="${size}" viewBox="0 0 56 56" aria-hidden="true">
      <circle cx="28" cy="28" r="${r}" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="5"/>
      <circle cx="28" cy="28" r="${r}" fill="none" stroke="${color}" stroke-width="5"
        stroke-linecap="round" stroke-dasharray="${dash.toFixed(1)} ${c.toFixed(1)}"
        transform="rotate(-90 28 28)"/>
      <text x="28" y="31" text-anchor="middle" class="pve-g-ring-text">${Math.round(p)}%</text>
    </svg>`;
  }

  function miniBar(pct, color) {
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    return `<div class="pve-g-bar"><div class="pve-g-bar-fill" style="width:${p}%;background:${color}"></div></div>`;
  }

  function buildGuestsTab(nodeCfg, pveData) {
    const vms = (pveData?.vms || []).map(v => ({ ...v, _type: "qemu" }));
    const lxcs = (pveData?.lxcs || []).map(v => ({ ...v, _type: "lxc" }));
    const guests = [...vms, ...lxcs].sort((a, b) => {
      const ar = a.status === "running" ? 0 : 1;
      const br = b.status === "running" ? 0 : 1;
      if (ar !== br) return ar - br;
      return String(a.name || a.vmid).localeCompare(String(b.name || b.vmid), undefined, { sensitivity: "base" });
    });

    const total = guests.length;
    const running = guests.filter(g => g.status === "running").length;
    const lxcCount = lxcs.length;
    const vmCount = vms.length;

    const hostMemTotal = pveData?.status?.memory?.total || 0;
    const hostCpus = pveData?.status?.cpuinfo?.cpus
      || pveData?.status?.cpuinfo?.cores
      || 0;

    let cpuUsedSum = 0;   // effective used vCPU (cpu fraction * cpus)
    let cpuAllocSum = 0;
    let memUsedSum = 0;
    let memAllocSum = 0;
    let diskUsedSum = 0;
    let diskAllocSum = 0;

    guests.forEach(g => {
      const cpus = Number(g.cpus) || 1;
      const cpuFrac = Number(g.cpu) || 0;
      cpuAllocSum += cpus;
      cpuUsedSum += cpuFrac * cpus;
      memUsedSum += Number(g.mem) || 0;
      memAllocSum += Number(g.maxmem) || 0;
      diskUsedSum += Number(g.disk) || 0;
      diskAllocSum += Number(g.maxdisk) || 0;
    });

    const cpuPct = cpuAllocSum > 0 ? (cpuUsedSum / cpuAllocSum) * 100 : 0;
    const memPct = memAllocSum > 0 ? (memUsedSum / memAllocSum) * 100 : 0;
    const diskPct = diskAllocSum > 0 ? (diskUsedSum / diskAllocSum) * 100 : 0;
    const cpuColor = pctColor(cpuPct);
    const memColor = pctColor(memPct);
    const diskColor = pctColor(diskPct);

    const rows = guests.map(g => {
      const isLxc = g._type === "lxc";
      const running = g.status === "running";
      const cpus = Number(g.cpus) || 1;
      const cpuPctG = Math.round((Number(g.cpu) || 0) * 1000) / 10;
      const memUsed = Number(g.mem) || 0;
      const memMax = Number(g.maxmem) || 0;
      const memPctG = memMax > 0 ? (memUsed / memMax) * 100 : 0;
      const diskUsed = Number(g.disk) || 0;
      const diskMax = Number(g.maxdisk) || 0;
      const diskPctG = diskMax > 0 ? (diskUsed / diskMax) * 100 : 0;
      const statusCls = running ? "pve-g-pill--run" : "pve-g-pill--stop";
      const statusTxt = running ? "RUNNING" : String(g.status || "STOPPED").toUpperCase();
      const typeCls = isLxc ? "pve-g-pill--lxc" : "pve-g-pill--vm";
      const typeTxt = isLxc ? "LXC" : "VM";
      const up = g.uptime != null ? fmtUptimeFull(g.uptime) : "—";
      const uc = normalizeUpdateCheck(getGuestUpdateCheck(nodeCfg, g.vmid));
      const updatesBadge = uc ? guestUpdatesBadgeHtml(uc) : "";
      const cachedIps = getCachedGuestIps(nodeCfg, g._type, g.vmid);
      const ipHtml = cachedIps && cachedIps.length
        ? cachedIps.slice(0, 2).map((ip) => `<span class="pve-g-ip">${escH(ip)}</span>`).join("")
        : `<span class="pve-g-ip pve-g-ip--empty">—</span>`;

      return `
        <div class="pve-g-row" role="button" tabindex="0" data-vmid="${escH(g.vmid)}" data-gtype="${isLxc ? "lxc" : "qemu"}" title="Open guest controller">
          <div class="pve-g-row-top">
            <div class="pve-g-row-id">
              <span class="pve-g-pill ${statusCls}">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                ${statusTxt}
              </span>
              <span class="pve-g-pill ${typeCls}">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 7.7c0-.6-.4-1.2-.8-1.5l-6.3-3.9a1.72 1.72 0 0 0-1.7 0l-10.3 6c-.5.2-.9.8-.9 1.4v6.6c0 .5.4 1.2.8 1.5l6.3 3.9a1.72 1.72 0 0 0 1.7 0l10.3-6c.5-.3.9-1 .9-1.5Z"/></svg>
                ${typeTxt}
              </span>
              <span class="pve-g-name">${escH(g.name || `guest-${g.vmid}`)}</span>
              <span class="pve-g-vmid">ID: ${escH(g.vmid)}</span>
            </div>
            <div class="pve-g-row-meta">
              <span class="pve-g-uptime">Uptime: ${escH(up)}</span>
              ${updatesBadge}
            </div>
          </div>
          <div class="pve-g-metrics">
            <div class="pve-g-metric">
              <div class="pve-g-metric-label">CPU Usage</div>
              <div class="pve-g-metric-val">${cpuPctG.toFixed(1)}%</div>
              ${miniBar(cpuPctG, pctColor(cpuPctG))}
            </div>
            <div class="pve-g-metric">
              <div class="pve-g-metric-label">Memory</div>
              <div class="pve-g-metric-val">${escH(fmtBytes(memUsed))} / ${escH(fmtBytes(memMax))}</div>
              ${miniBar(memPctG, "#38bdf8")}
            </div>
            <div class="pve-g-metric">
              <div class="pve-g-metric-label">Disk Usage</div>
              <div class="pve-g-metric-val">${diskMax ? `${escH(fmtBytes(diskUsed))} / ${escH(fmtBytes(diskMax))}` : "—"}</div>
              ${diskMax ? miniBar(diskPctG, "#38bdf8") : miniBar(0, "#38bdf8")}
            </div>
            <div class="pve-g-metric">
              <div class="pve-g-metric-label">Disk I/O</div>
              <div class="pve-g-metric-io">
                <span class="pve-g-io pve-g-io--r">↓ ${escH(fmtBytes(g.diskread || 0))}</span>
                <span class="pve-g-io pve-g-io--w">↑ ${escH(fmtBytes(g.diskwrite || 0))}</span>
              </div>
            </div>
            <div class="pve-g-metric">
              <div class="pve-g-metric-label">Network I/O</div>
              <div class="pve-g-metric-io">
                <span class="pve-g-io pve-g-io--rx">↓ ${escH(fmtBytes(g.netin || 0))}</span>
                <span class="pve-g-io pve-g-io--tx">↑ ${escH(fmtBytes(g.netout || 0))}</span>
              </div>
            </div>
            <div class="pve-g-metric">
              <div class="pve-g-metric-label">IP</div>
              <div class="pve-g-metric-ip">${ipHtml}</div>
            </div>
          </div>
        </div>`;
    }).join("");

    return `
      <div class="pve-guests-tab">
        <div class="pve-g-summary">
          <div class="pve-g-card">
            <div class="pve-g-card-hdr">
              <span>Total VMs &amp; LXCs</span>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" opacity=".55"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
            </div>
            <div class="pve-g-card-big">${running} / ${total}</div>
            <div class="pve-g-card-badges">
              <span class="pve-g-pill pve-g-pill--run">${running} running</span>
              <span class="pve-g-pill pve-g-pill--lxc">${lxcCount} LXC</span>
              ${vmCount ? `<span class="pve-g-pill pve-g-pill--vm">${vmCount} VM</span>` : ""}
            </div>
          </div>

          <div class="pve-g-card pve-g-card--split">
            <div class="pve-g-card-hdr">
              <span>Total CPU Allocated</span>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" opacity=".55"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2"/></svg>
            </div>
            <div class="pve-g-card-body">
              ${ringGauge(cpuPct, cpuColor)}
              <div class="pve-g-card-stats">
                <div class="pve-g-stat"><span>Used</span><b>${cpuUsedSum.toFixed(2)} vCPU</b>${miniBar(cpuPct, cpuColor)}</div>
                <div class="pve-g-stat"><span>Configured</span><b>${cpuAllocSum} / ${hostCpus || "—"} vCPU</b></div>
                <div class="pve-g-stat"><span>In use</span><b>${Math.round(cpuUsedSum * 10) / 10} / ${hostCpus || "—"} vCPU</b></div>
              </div>
            </div>
          </div>

          <div class="pve-g-card pve-g-card--split">
            <div class="pve-g-card-hdr">
              <span>Total Memory</span>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" opacity=".55"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10v4M10 10v4M14 10v4M18 10v4"/></svg>
            </div>
            <div class="pve-g-card-body">
              ${ringGauge(memPct, memColor)}
              <div class="pve-g-card-stats">
                <div class="pve-g-stat"><span>Used</span><b>${escH(fmtBytes(memUsedSum))}</b>${miniBar(memPct, "#38bdf8")}</div>
                <div class="pve-g-stat"><span>Alloc</span><b>${escH(fmtBytes(memAllocSum))}</b></div>
                <div class="pve-g-stat"><span>Total</span><b>${hostMemTotal ? escH(fmtBytes(hostMemTotal)) : "—"}</b></div>
              </div>
            </div>
          </div>

          <div class="pve-g-card">
            <div class="pve-g-card-hdr">
              <span>Total Disk</span>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" opacity=".55"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/><path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/></svg>
            </div>
            <div class="pve-g-card-big pve-g-card-big--sm">${escH(fmtBytes(diskUsedSum))} <span>used</span></div>
            <div class="pve-g-card-badges">
              <span class="pve-g-pill" style="color:${diskColor};border-color:${diskColor}55;background:${diskColor}18">${Math.round(diskPct)}% util</span>
            </div>
            <div class="pve-g-disk-track">${miniBar(diskPct, diskColor)}</div>
            <div class="pve-g-disk-sub">${escH(fmtBytes(diskUsedSum))} vs ${escH(fmtBytes(diskAllocSum))} allocated</div>
          </div>
        </div>

        <section class="pve-g-list-card">
          <div class="pve-g-list-hdr">
            <div class="pve-g-list-hdr-title">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2 2 7l10 5 10-5-10-5Z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/></svg>
              Virtual Machines &amp; Containers
            </div>
            <button type="button" class="pve-g-bulk-recheck" data-bulk-recheck title="Live-scan pending packages on every running LXC">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 12a9 9 0 1 1-2.6-6.3"/><polyline points="21 3 21 9 15 9"/></svg>
              <span data-bulk-recheck-label>Recheck updates</span>
            </button>
          </div>
          <div class="pve-g-list">
            ${rows || `<div class="pve-g-empty">No VMs or LXCs found on this node</div>`}
          </div>
        </section>
      </div>`;
  }

  function isRemoteStorage(s) {
    const t = String(s?.type || "").toLowerCase();
    if (s?.shared === 1 || s?.shared === true) return true;
    return /^(nfs|cifs|rbd|cephfs|iscsi|iscsidirect|esxi|glusterfs|pbs)$/i.test(t);
  }

  function storageTypePillClass(type) {
    const t = String(type || "").toLowerCase();
    if (t === "lvmthin" || t === "lvm") return "pve-st-type--lvm";
    if (t === "zfspool" || t === "zfs") return "pve-st-type--zfs";
    if (t === "dir" || t === "btrfs") return "pve-st-type--dir";
    if (isRemoteStorage({ type: t, shared: 1 })) return "pve-st-type--remote";
    return "pve-st-type--other";
  }

  function classifyPhysicalDisk(d) {
    const path = String(d?.devpath || d?.name || "").toLowerCase();
    const type = String(d?.type || "").toLowerCase();
    const model = String(d?.model || "").toLowerCase();
    const vendor = String(d?.vendor || "").toLowerCase();
    const transport = String(d?.transport || d?.protocol || "").toLowerCase();
    const blob = `${type} ${transport} ${model} ${vendor}`;

    if (/usb|uas/.test(blob) || /usb/.test(path)) return "usb";

    // Device path is authoritative for native NVMe controllers
    if (/\/nvme\d|nvme\d+n\d/.test(path)) return "nvme";

    // /dev/sd* with "NVMe" in the model is usually a USB/SATA bridge — not native NVMe
    const isSd = /\/sd[a-z]\d*$/.test(path) || /^sd[a-z]\d*$/.test(path.replace(/^\/dev\//, ""));
    if (isSd) {
      if (/ssd|solid|nvme/.test(model + type) || d?.rpm === 0 || d?.rota === 0) return "ssd";
      if ((Number(d?.rpm) > 0) || d?.rota === 1 || /hdd|rota/.test(blob)) return "hdd";
      return "ssd";
    }

    if (/nvme/.test(type)) return "nvme";
    if (/ssd|solid/.test(type + model)) return "ssd";
    if (/hdd|rota|sata|sas/.test(type + model) || Number(d?.rpm) > 0) return "hdd";
    return type || "disk";
  }

  function diskKindLabel(kind) {
    if (kind === "nvme") return "NVMe";
    if (kind === "usb") return "USB";
    if (kind === "ssd") return "SSD";
    if (kind === "hdd") return "HDD";
    return String(kind || "Disk").toUpperCase();
  }

  function fmtPowerOnHours(hours) {
    const h = Number(hours);
    if (!Number.isFinite(h) || h < 0) return "—";
    const days = Math.floor(h / 24);
    const months = Math.floor(days / 30);
    const remDays = days % 30;
    if (months > 0) return `${months}m ${remDays}d`;
    if (days > 0) return `${days}d`;
    return `${Math.round(h)}h`;
  }

  function parseSmartNumber(v) {
    if (v == null || v === "" || v === "N/A" || v === "n/a") return NaN;
    if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
    if (typeof v === "object") {
      return parseSmartNumber(v.current ?? v.value ?? v.raw ?? v.hours ?? null);
    }
    const s = String(v).trim();
    // Prefer leading integer (handles "3831 Hours", "47 Celsius", "12345 [0x…]")
    const m = s.match(/-?\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : NaN;
  }

  function smartAttrMap(smart) {
    const map = {};
    if (!smart || typeof smart !== "object") return map;
    const attrs = smart.attributes || smart.ata_smart_attributes?.table || smart.nvme_smart_health_information_log;
    if (Array.isArray(attrs)) {
      attrs.forEach((a) => {
        if (!a || typeof a !== "object") return;
        const name = String(a.name || a.attrname || a.id || "")
          .toLowerCase()
          .replace(/[%()]/g, "")
          .replace(/[-\s]+/g, "_")
          .replace(/_+/g, "_")
          .replace(/^_|_$/g, "");
        if (!name) return;
        const raw = a.raw?.value ?? a.raw_value ?? a.raw ?? a.value ?? a.worst;
        const n = parseSmartNumber(raw);
        if (Number.isFinite(n)) map[name] = n;
        else if (raw != null && raw !== "") map[name] = raw;
      });
    } else if (attrs && typeof attrs === "object" && !Array.isArray(attrs)) {
      // NVMe health log object from some smartctl JSON dumps
      Object.keys(attrs).forEach((k) => {
        const key = String(k).toLowerCase().replace(/[-\s]+/g, "_");
        const n = parseSmartNumber(attrs[k]);
        if (Number.isFinite(n)) map[key] = n;
      });
    }
    // Flatten common top-level SMART fields into the map as fallbacks
    [
      ["temperature", smart.temperature],
      ["temp", smart.temp],
      ["power_on_hours", smart.power_on_hours],
      ["power_cycles", smart.power_cycles],
      ["percentage_used", smart.percentage_used ?? smart.percent_used],
      ["available_spare", smart.available_spare ?? smart.avail_spare],
      ["data_units_written", smart.data_units_written],
      ["critical_warning", smart.critical_warning],
    ].forEach(([k, v]) => {
      const n = parseSmartNumber(v);
      if (Number.isFinite(n) && map[k] == null) map[k] = n;
    });
    return map;
  }

  function firstFinite(...vals) {
    for (const v of vals) {
      const n = parseSmartNumber(v);
      if (Number.isFinite(n)) return n;
    }
    return null;
  }

  function diskSmartInfo(disk) {
    const prxStatus = disk?.__prxSmart || {};
    const sd = prxStatus.smart_data || {};
    const nr = sd.nvme_raw || {};
    const prxDisk = disk?.__prxDisk || {};
    const smart = disk?.smart || {};
    const attrs = {
      ...smartAttrMap(smart),
      ...smartAttrMap(sd),
      ...smartAttrMap({ attributes: Array.isArray(sd.attributes) ? sd.attributes : [] }),
    };

    // ProxMenux percentage_used = endurance consumed. PVE wearout = life remaining (higher is better).
    const prxUsed = firstFinite(
      prxDisk.percentage_used,
      nr.percent_used,
      sd.percent_used,
      attrs.percentage_used,
      attrs.percent_used,
      disk.percentage_used
    );
    const pveWearout = disk.wearout != null && disk.wearout !== "N/A"
      ? parseSmartNumber(disk.wearout)
      : NaN;
    let wear = prxUsed;
    if (wear == null && Number.isFinite(pveWearout)) {
      wear = Math.max(0, Math.min(100, 100 - pveWearout));
    }
    if (wear == null) {
      wear = firstFinite(attrs.wear_leveling_count, attrs.media_wearout_indicator);
    }
    if (wear != null && wear > 100) wear = 100;

    // Some SSDs expose "life left" instead of percent used
    const lifeLeft = firstFinite(
      prxDisk.ssd_life_left,
      attrs.ssd_life_left,
      attrs.percent_lifetime_remain
    );

    const tempRaw = firstFinite(
      prxDisk.temperature,
      sd.temperature,
      nr.temperature,
      Array.isArray(sd.temperature_sensors) ? sd.temperature_sensors.find((t) => t != null) : null,
      smart.temperature,
      smart.temp,
      attrs.temperature,
      attrs.temperature_celsius,
      attrs.airflow_temperature_cel,
      disk.temperature
    );
    // ProxMenux treats 0 as "no reading" (USB/standby/unavailable)
    const temp = tempRaw != null && tempRaw > 0 ? tempRaw : null;

    const cyclesRaw = firstFinite(
      prxDisk.power_cycles,
      sd.power_cycles,
      nr.power_cycles,
      attrs.power_cycle_count,
      attrs.power_cycles,
      smart.power_cycles,
      disk.power_cycles
    );
    const cycles = cyclesRaw != null && cyclesRaw > 0 ? cyclesRaw : null;

    const pohRaw = firstFinite(
      prxDisk.power_on_hours,
      sd.power_on_hours,
      nr.power_on_hours,
      attrs.power_on_hours,
      attrs.power_on_time,
      smart.power_on_hours,
      disk.power_on_hours
    );
    const poh = pohRaw != null && pohRaw > 0 ? pohRaw : null;

    const crc = firstFinite(
      prxDisk.crc_errors,
      attrs.udma_crc_error_count,
      attrs.crc_error_count,
      attrs.crc_errors,
      attrs.command_timeout
    ) ?? 0;

    const realloc = firstFinite(
      prxDisk.reallocated_sectors,
      attrs.reallocated_sector_ct,
      attrs.reallocated_sectors_count,
      attrs.reallocated_sector_count,
      attrs.reallocated_sectors
    ) ?? 0;

    const pending = firstFinite(
      prxDisk.pending_sectors,
      attrs.current_pending_sector,
      attrs.pending_sector_count,
      attrs.pending_sectors
    ) ?? 0;

    const health = String(
      prxDisk.smart_status
      || prxDisk.health
      || sd.smart_status
      || prxStatus.smart_status
      || disk.health
      || smart.health
      || smart.status
      || ""
    ).toUpperCase() || "UNKNOWN";

    const alerts = [];
    if (smart?.text && /corrupt|filesystem/i.test(smart.text)) alerts.push(String(smart.text));
    if (disk?.alert) alerts.push(String(disk.alert));
    if (health && !/PASSED|OK|UNKNOWN|HEALTHY/.test(health)) alerts.push(`SMART ${health}`);

    // NVMe data units written → bytes (spec: 1000 * 512 bytes per unit)
    const duw = firstFinite(nr.data_units_written, attrs.data_units_written);
    const lbas = firstFinite(attrs.total_lbas_written);
    const prxWrittenGb = firstFinite(prxDisk.total_lbas_written);
    let dataWritten = null;
    if (duw != null) dataWritten = duw * 1000 * 512;
    else if (lbas != null) dataWritten = lbas < 1e6 ? lbas * (1024 ** 3) : lbas * 512;
    else if (prxWrittenGb != null) dataWritten = prxWrittenGb * (1024 ** 3);

    let lifePct = null;
    if (lifeLeft != null && wear == null) {
      lifePct = Math.max(0, Math.min(100, lifeLeft));
      wear = Math.max(0, Math.min(100, 100 - lifePct));
    } else if (wear != null) {
      lifePct = Math.max(0, Math.min(100, 100 - wear));
    }

    let estLife = "—";
    if (wear != null && wear > 0 && poh != null && poh > 0) {
      const totalHours = poh / (wear / 100);
      const remainHours = Math.max(0, totalHours - poh);
      const years = remainHours / 24 / 365;
      estLife = years >= 1 ? `~${years.toFixed(1)} years` : `~${Math.max(1, Math.round(remainHours / 24))} days`;
    } else if (wear === 0 && poh != null && poh > 0) {
      estLife = ">10 years";
    }

    const kind = classifyPhysicalDisk(disk);
    const rotation = kind === "hdd"
      ? (disk.rpm ? `${disk.rpm} RPM` : "HDD")
      : (kind === "nvme" ? "NVMe" : "SSD");

    const availSpare = firstFinite(nr.avail_spare, attrs.available_spare, attrs.avail_spare);

    return {
      wear: wear != null ? wear : null,
      lifePct,
      estLife,
      dataWritten,
      temp,
      cycles,
      powerOnHours: poh,
      powerOn: poh != null ? fmtPowerOnHours(poh) : "—",
      crc,
      realloc,
      pending,
      health,
      rotation,
      kind,
      alerts,
      model: disk.model || prxDisk.model || sd.model || smart.model || "—",
      serial: disk.serial || prxDisk.serial || sd.serial || smart.serial || "",
      size: disk.size != null ? fmtBytes(disk.size) : (prxDisk.size_formatted || "—"),
      isSystem: disk.used === 1 || disk.used === true || Number(disk.osdid) >= 0 || !!prxDisk.is_system_disk,
      availSpare,
      attrs,
      smart,
    };
  }

  function diskHistoryKey(devpath) {
    return `hp-pve-disk-history:${String(devpath || "")}`;
  }
  function diskScheduleKey(devpath) {
    return `hp-pve-disk-schedule:${String(devpath || "")}`;
  }
  function loadDiskHistory(devpath) {
    try {
      const raw = localStorage.getItem(diskHistoryKey(devpath));
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch { return []; }
  }
  function saveDiskHistory(devpath, list) {
    try { localStorage.setItem(diskHistoryKey(devpath), JSON.stringify(list.slice(0, 50))); } catch {}
  }
  function loadDiskSchedule(devpath) {
    try {
      const raw = localStorage.getItem(diskScheduleKey(devpath));
      return raw ? JSON.parse(raw) : { enabled: true, items: [] };
    } catch { return { enabled: true, items: [] }; }
  }
  function saveDiskSchedule(devpath, data) {
    try { localStorage.setItem(diskScheduleKey(devpath), JSON.stringify(data)); } catch {}
  }

  function nvmeHealthRows(info) {
    const s = info.smart || {};
    const a = info.attrs || {};
    const rows = [];
    const push = (label, value, ok = true) => rows.push({ label, value, ok });
    const crit = a.critical_warning ?? s.critical_warning;
    push("Critical Warning", crit == null || Number(crit) === 0 ? "OK" : String(crit), crit == null || Number(crit) === 0);
    if (info.temp != null) push("Temperature", `${Math.round(info.temp)} °C`, info.temp < 60);
    const spare = a.available_spare ?? s.available_spare;
    if (spare != null) push("Available Spare", `${spare}%`, Number(spare) >= 10);
    if (info.wear != null) push("Percentage Used", `${info.wear}%`, info.wear < 90);
    if (info.dataWritten != null) push("Data Units Written", fmtBytes(info.dataWritten), true);
    if (info.cycles != null) push("Power Cycles", String(info.cycles), true);
    if (info.powerOnHours != null) push("Power On Hours", `${info.powerOnHours.toLocaleString()}h`, true);
    // Fallback: list first attrs
    if (rows.length < 4) {
      Object.keys(a).slice(0, 12).forEach((k) => {
        if (rows.some((r) => r.label.toLowerCase() === k.replace(/_/g, " "))) return;
        push(k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()), String(a[k]), true);
      });
    }
    return rows;
  }

  function isUsbDisk(disk) {
    return classifyPhysicalDisk(disk) === "usb"
      || /usb/i.test(String(disk?.transport || disk?.protocol || ""))
      || /usb/i.test(String(disk?.vendor || ""));
  }

  function isWholeDisk(disk) {
    if (!disk?.devpath) return false;
    if (disk.parent && disk.parent !== disk.devpath) return false;
    // skip partition-looking names when siblings exist
    if (/p\d+$|part\d+$/.test(disk.devpath) && disk.parent) return false;
    return true;
  }

  function collectRemoteMounts(pveData, glancesData) {
    const mounts = [];
    const seen = new Set();
    const add = (m) => {
      const key = `${m.path}|${m.source}|${m.type}`;
      if (seen.has(key)) return;
      seen.add(key);
      mounts.push(m);
    };

    (glancesData?.fs || []).forEach((f) => {
      const fsType = String(f.fs_type || f.fstype || "").toLowerCase();
      const device = String(f.device_name || f.device || "");
      const mnt = String(f.mnt_point || f.mountpoint || "");
      const remoteish = /^(nfs|nfs4|nfsd|cifs|smb|smb2|fuse|fuseblk|sshfs|glusterfs|ceph|overlay)/i.test(fsType)
        || /:\/\//.test(device)
        || /^\/proc\/fs\/nfsd/i.test(mnt);
      if (!remoteish || !mnt) return;
      add({
        path: mnt,
        source: device || fsType || "remote",
        type: fsType || "remote",
        reachable: true,
      });
    });

    (pveData?.storage || []).filter(isRemoteStorage).forEach((s) => {
      add({
        path: s.storage,
        source: s.content || s.type || "remote",
        type: s.type || "remote",
        reachable: s.active === 1 || s.active === true,
      });
    });

    return mounts.sort((a, b) => a.path.localeCompare(b.path));
  }

  function buildDiskCardHtml(disk, { external = false } = {}) {
    const kind = classifyPhysicalDisk(disk);
    const info = diskSmartInfo(disk);
    const healthOk = /PASSED|OK|HEALTHY/.test(info.health);
    const healthNa = !info.health || /UNKNOWN|N\/A|NONE/.test(info.health);
    const wearPct = info.wear != null ? Math.max(0, Math.min(100, info.wear)) : null;
    const tempColor = info.temp == null ? "" : (info.temp >= 60 ? "#f87171" : info.temp >= 50 ? "#fbbf24" : "#6ee7b7");
    const alerts = info.alerts || [];
    const path = disk.devpath || "—";
    const typeBadge = (kind === "usb" || external)
      ? `<span class="pve-st-type pve-st-type--remote">USB</span>`
      : `<span class="pve-st-type ${kind === "nvme" ? "pve-st-type--zfs" : "pve-st-type--dir"}">${escH(diskKindLabel(kind))}</span>`;

    return `
      <button type="button" class="pve-st-disk" data-disk-open="${escH(path)}" title="Open disk details">
        <div class="pve-st-disk-top">
          <div class="pve-st-disk-id">
            <span class="pve-st-disk-path">${escH(path)}</span>
            ${typeBadge}
            ${info.isSystem ? `<span class="pve-st-type pve-st-type--remote"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg> System</span>` : ""}
          </div>
          <div class="pve-st-disk-health ${healthOk ? "is-ok" : healthNa ? "is-na" : "is-bad"}">
            <i class="pve-st-dot" style="background:${healthOk ? "#6ee7b7" : healthNa ? "rgba(255,255,255,0.35)" : "#f87171"}"></i>
            ${healthOk ? "PASSED" : healthNa ? "N/A" : escH(info.health)}
          </div>
        </div>
        <div class="pve-st-disk-sub">
          <span>${escH(info.size)}</span>
          ${info.temp != null ? `<span style="color:${tempColor}">${Math.round(info.temp)}°C</span>` : ""}
        </div>
        ${alerts.map((a) => `
          <div class="pve-st-disk-alert">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
            ${escH(a)}
          </div>`).join("")}
        <div class="pve-st-disk-grid">
          <div class="pve-st-disk-kv"><span>MODEL</span><b title="${escH(info.model)}">${escH(info.model)}</b></div>
          <div class="pve-st-disk-kv">
            <span>WEAR LEVEL</span>
            <b>${wearPct != null ? `${wearPct}%` : "—"}</b>
            ${wearPct != null ? `<div class="pve-st-wear"><div style="width:${wearPct}%"></div></div>` : ""}
          </div>
          <div class="pve-st-disk-kv"><span>POWER CYCLES</span><b>${info.cycles != null ? escH(info.cycles) : "—"}</b></div>
          <div class="pve-st-disk-kv"><span>POWER ON</span><b>${escH(info.powerOn)}</b></div>
          <div class="pve-st-disk-kv"><span>CRC ERRORS</span><b class="${info.crc ? "is-bad" : "is-ok"}"><i class="pve-st-dot" style="background:${info.crc ? "#f87171" : "#6ee7b7"}"></i> ${escH(info.crc)}</b></div>
        </div>
        <div class="pve-st-disk-ftr">
          <span>${info.serial ? `S/N: ${escH(info.serial)}` : ""}</span>
          <span class="pve-st-disk-more" aria-hidden="true">→</span>
        </div>
      </button>`;
  }

  function closeDiskDetails() {
    const modal = _diskModal?.querySelector?.(".pve-disk-modal");
    if (modal?.__pveSmartPoll) {
      clearInterval(modal.__pveSmartPoll);
      modal.__pveSmartPoll = null;
    }
    if (_diskModal) {
      _diskModal.remove();
      _diskModal = null;
    }
    document.removeEventListener("keydown", _diskEscHandler, true);
  }

  function _diskEscHandler(e) {
    if (e.key !== "Escape") return;
    if (_termModal && document.body.contains(_termModal)) return;
    closeDiskDetails();
  }

  function smartStatusIconHtml(status) {
    const st = String(status || "ok").toLowerCase();
    if (st === "ok" || st === "passed") {
      return `<span class="pve-disk-ok"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg></span>`;
    }
    if (st === "warning") {
      return `<span class="pve-disk-bad pve-disk-bad--warn">!</span>`;
    }
    return `<span class="pve-disk-bad">!</span>`;
  }

  function smartAttrTableMode(disk, status) {
    const name = diskPrxName(disk);
    const isNvme = name.startsWith("nvme") || classifyPhysicalDisk(disk) === "nvme";
    const isSas = !!(status?.smart_data?.is_sas);
    return {
      isNvme,
      isSas,
      compact: isNvme || isSas,
      title: isNvme ? "NVMe Health Metrics" : (isSas ? "SAS/SCSI Health Metrics" : "SMART Attributes"),
    };
  }

  function buildSmartAttrRowsHtml(disk, status) {
    const attrs = Array.isArray(status?.smart_data?.attributes) ? status.smart_data.attributes : [];
    const { compact, isSas } = smartAttrTableMode(disk, status);
    if (!attrs.length) {
      const msg = status
        ? "No SMART attributes available"
        : "Loading SMART attributes from ProxMenux…";
      return `<div class="pve-smart-row pve-smart-row--empty">${msg}</div>`;
    }
    return attrs.slice(0, 40).map((a) => {
      const val = isSas
        ? (a.raw_value != null && a.raw_value !== "" ? a.raw_value : a.value)
        : (a.value != null && a.value !== "" ? a.value : a.raw_value);
      if (compact) {
        return `
          <div class="pve-smart-row pve-smart-row--compact">
            <div class="pve-smart-name" title="${escH(a.name || "")}">${escH(a.name || "—")}</div>
            <div class="pve-smart-val">${escH(val == null ? "—" : String(val))}</div>
            <div class="pve-smart-status">${smartStatusIconHtml(a.status)}</div>
          </div>`;
      }
      return `
        <div class="pve-smart-row">
          <div class="pve-smart-id">${escH(a.id == null ? "—" : String(a.id))}</div>
          <div class="pve-smart-name" title="${escH(a.name || "")}">${escH(a.name || "—")}</div>
          <div class="pve-smart-val">${escH(val == null ? "—" : String(val))}</div>
          <div class="pve-smart-worst">${escH(a.worst == null || a.worst === "" ? "—" : String(a.worst))}</div>
          <div class="pve-smart-status">${smartStatusIconHtml(a.status)}</div>
        </div>`;
    }).join("");
  }

  function buildSmartTabHtml(disk, status) {
    const mode = smartAttrTableMode(disk, status);
    const head = mode.compact
      ? `<div class="pve-smart-head pve-smart-head--compact"><div>Attribute</div><div>Value</div><div>Status</div></div>`
      : `<div class="pve-smart-head"><div>ID</div><div>Attribute</div><div>Value</div><div>Worst</div><div>Status</div></div>`;
    return `
      <div class="pve-disk-pane">
        <div class="pve-disk-sec">
          <div class="pve-disk-sec-title">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            Run SMART Test
          </div>
          <div class="pve-disk-test-actions">
            <button type="button" class="pve-disk-test-btn" data-disk-test="short">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
              Short Test (~2 min)
            </button>
            <button type="button" class="pve-disk-test-btn" data-disk-test="long">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
              Extended Test (background)
            </button>
          </div>
          <div class="pve-disk-hint">Short test takes ~2 minutes. Extended test runs in the background and can take several hours for large disks. You will receive a notification when the test completes.</div>
          <div class="pve-disk-progress" data-disk-progress hidden></div>
        </div>
        <div class="pve-disk-sec">
          <div class="pve-disk-sec-title">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
            <span data-smart-title>${escH(mode.title)}</span>
          </div>
          <div class="pve-smart-table ${mode.compact ? "pve-smart-table--compact" : ""}" data-smart-table>
            ${head}
            <div class="pve-smart-body" data-smart-body>${buildSmartAttrRowsHtml(disk, status)}</div>
          </div>
        </div>
        <div class="pve-disk-report-wrap">
          <button type="button" class="pve-disk-report-btn" data-disk-report>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/></svg>
            View Full SMART Report
          </button>
          <div class="pve-disk-hint" style="text-align:center;margin-top:8px">Generate a comprehensive professional report with detailed analysis and recommendations.</div>
        </div>
      </div>`;
  }

  function buildDiskDetailsPane(disk, pane) {
    const info = diskSmartInfo(disk);
    const healthOk = /PASSED|OK|HEALTHY/.test(info.health);
    const tempOk = info.temp == null || info.temp < 60;
    const life = info.lifePct != null ? info.lifePct : null;

    if (pane === "smart") {
      return buildSmartTabHtml(disk, disk.__prxSmart || null);
    }

    if (pane === "history") {
      return `
        <div class="pve-disk-pane" data-prx-hist-root>
          <div class="pve-disk-empty">
            <div class="pve-disk-empty-title">Loading history…</div>
            <div class="pve-disk-empty-sub">Fetching SMART test history from ProxMenux Monitor.</div>
          </div>
        </div>`;
    }

    if (pane === "schedule") {
      return `
        <div class="pve-disk-pane" data-prx-sched-root>
          <div class="pve-disk-empty">
            <div class="pve-disk-empty-title">Loading schedules…</div>
            <div class="pve-disk-empty-sub">Fetching automatic SMART schedules from ProxMenux Monitor.</div>
          </div>
        </div>`;
    }

    // overview — ProxMenux layout: identity → optional Wear → SMART attrs with temp sparkline
    const showWear = info.kind !== "hdd" && info.wear != null;
    const tempColor = info.temp == null ? "rgba(255,255,255,0.45)" : (tempOk ? "#22c55e" : "#f87171");
    const spark = buildTempSparklineSvg(disk.__prxTempHour?.data || disk.__prxTempHour?.points || disk.__prxTempHour || [], tempOk ? "#22c55e" : "#f87171");
    return `
      <div class="pve-disk-pane">
        <div class="pve-disk-sec">
          <div class="pve-disk-kv-grid">
            <div class="pve-disk-kv2"><span>Model</span><b>${escH(info.model)}</b></div>
            <div class="pve-disk-kv2"><span>Serial Number</span><b>${escH(info.serial || "—")}</b></div>
            <div class="pve-disk-kv2"><span>Capacity</span><b>${escH(info.size)}</b></div>
            <div class="pve-disk-kv2"><span>Health Status</span>
              <b><span class="pve-st-health ${healthOk ? "pve-st-health--ok" : "pve-st-health--warn"}">${healthOk ? "Healthy" : escH(info.health)}</span></b>
            </div>
          </div>
        </div>

        ${showWear ? `
        <div class="pve-disk-sec">
          <div class="pve-disk-sec-title">Wear &amp; Lifetime</div>
          <div class="pve-disk-wear-row">
            <div class="pve-disk-life">
              ${life != null ? ringGauge(life, life >= 70 ? "#6ee7b7" : life >= 40 ? "#fbbf24" : "#f87171", 72) : `<div class="pve-disk-life-na">—</div>`}
              <div class="pve-disk-life-caption">life</div>
            </div>
            <div class="pve-disk-wear-meta">
              <div class="pve-disk-wear-bar-hdr"><span>Wear</span><b>${info.wear}%</b></div>
              <div class="pve-st-track"><div class="pve-st-track-fill" style="width:${info.wear}%;background:#3b82f6"></div></div>
              <div class="pve-disk-wear-stats">
                <div><span>Est. Life</span><b>${escH(info.estLife)}</b></div>
                <div><span>Data Written</span><b>${info.dataWritten != null ? escH(fmtBytes(info.dataWritten)) : "—"}</b></div>
              </div>
            </div>
          </div>
        </div>` : ""}

        <div class="pve-disk-sec">
          <div class="pve-disk-sec-title">SMART Attributes</div>
          <button type="button" class="pve-disk-temp-card" data-disk-temp-open title="Open temperature history">
            <div class="pve-disk-temp-top">
              <div>
                <span>Temperature</span>
                <div class="pve-disk-temp-val" style="color:${tempColor}">${info.temp != null ? `${Math.round(info.temp)}°C` : "—"}</div>
              </div>
              <div class="pve-disk-temp-side">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="${tempColor}" stroke-width="2"><path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z"/></svg>
                <span class="pve-disk-temp-badge ${tempOk ? "is-ok" : "is-bad"}">${tempOk ? "Normal" : "Hot"}</span>
              </div>
            </div>
            <div class="pve-disk-temp-spark" data-disk-temp-spark>${spark || `<div class="pve-disk-temp-spark-empty"></div>`}</div>
          </button>
          <div class="pve-disk-attr-grid">
            <div class="pve-disk-attr"><span>Power On Hours</span><b>${info.powerOnHours != null ? `${info.powerOnHours.toLocaleString()}h (${escH(info.powerOn)})` : "—"}</b></div>
            <div class="pve-disk-attr"><span>Rotation Rate</span><b>${escH(info.rotation)}</b></div>
            <div class="pve-disk-attr"><span>Power Cycles</span><b>${info.cycles != null ? Number(info.cycles).toLocaleString() : "—"}</b></div>
            <div class="pve-disk-attr"><span>SMART Status</span><b class="${healthOk ? "is-ok" : "is-bad"}"><i class="pve-st-dot" style="background:${healthOk ? "#6ee7b7" : "#f87171"}"></i> ${healthOk ? "passed" : escH(String(info.health || "").toLowerCase())}</b></div>
            <div class="pve-disk-attr"><span>Reallocated Sectors</span><b class="${info.realloc ? "is-bad" : "is-ok"}"><i class="pve-st-dot" style="background:${info.realloc ? "#f87171" : "#6ee7b7"}"></i> ${escH(info.realloc)}</b></div>
            <div class="pve-disk-attr"><span>Pending Sectors</span><b class="${info.pending ? "is-bad" : "is-ok"}"><i class="pve-st-dot" style="background:${info.pending ? "#f87171" : "#6ee7b7"}"></i> ${escH(info.pending)}</b></div>
            <div class="pve-disk-attr"><span>CRC Errors</span><b class="${info.crc ? "is-bad" : "is-ok"}"><i class="pve-st-dot" style="background:${info.crc ? "#f87171" : "#6ee7b7"}"></i> ${escH(info.crc)}</b></div>
          </div>
        </div>
      </div>`;
  }

  function normalizeTempHistoryPoints(payload) {
    const raw = payload?.data || payload?.points || payload?.history || (Array.isArray(payload) ? payload : []);
    if (!Array.isArray(raw)) return [];
    return raw.map((p) => {
      if (typeof p === "number") return { temp: p, ts: null };
      const t = firstFinite(p.temp, p.temperature, p.value, p.y);
      const ts = p.ts || p.timestamp || p.time || p.t || null;
      return Number.isFinite(t) ? { temp: t, ts } : null;
    }).filter(Boolean);
  }

  function buildTempSparklineSvg(pointsOrPayload, color = "#22c55e", { w = 320, h = 40 } = {}) {
    const points = normalizeTempHistoryPoints(pointsOrPayload);
    if (points.length < 2) return "";
    const temps = points.map((p) => p.temp);
    const minT = Math.min(...temps);
    const maxT = Math.max(...temps);
    const span = Math.max(1, maxT - minT);
    const padY = 3;
    const coords = temps.map((t, i) => {
      const x = (i / (temps.length - 1)) * w;
      const y = h - padY - ((t - minT) / span) * (h - padY * 2);
      return [x, y];
    });
    const line = coords.map((c, i) => `${i ? "L" : "M"}${c[0].toFixed(2)},${c[1].toFixed(2)}`).join(" ");
    const area = `${line} L${w},${h} L0,${h} Z`;
    const gid = `pveTempGrad-${Math.random().toString(36).slice(2, 8)}`;
    return `<svg class="pve-disk-temp-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" width="100%" height="${h}" aria-hidden="true">
      <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity="0.35"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0.02"/>
      </linearGradient></defs>
      <path d="${area}" fill="url(#${gid})" stroke="none"/>
      <path d="${line}" fill="none" stroke="${color}" stroke-width="1.6"/>
    </svg>`;
  }

  function buildTempHistoryChartSvg(points, color = "#22c55e") {
    const list = normalizeTempHistoryPoints({ data: points });
    if (list.length < 2) {
      return `<div class="pve-disk-temp-hist-empty">No temperature samples for this range.</div>`;
    }
    const w = 640;
    const h = 180;
    const temps = list.map((p) => p.temp);
    const minT = Math.min(...temps);
    const maxT = Math.max(...temps);
    const avgT = temps.reduce((a, b) => a + b, 0) / temps.length;
    const span = Math.max(1, maxT - minT);
    const pad = { t: 12, r: 8, b: 22, l: 36 };
    const iw = w - pad.l - pad.r;
    const ih = h - pad.t - pad.b;
    const coords = temps.map((t, i) => {
      const x = pad.l + (i / (temps.length - 1)) * iw;
      const y = pad.t + ih - ((t - minT) / span) * ih;
      return [x, y];
    });
    const line = coords.map((c, i) => `${i ? "L" : "M"}${c[0].toFixed(2)},${c[1].toFixed(2)}`).join(" ");
    const area = `${line} L${pad.l + iw},${pad.t + ih} L${pad.l},${pad.t + ih} Z`;
    const gid = `pveTempHist-${Math.random().toString(36).slice(2, 8)}`;
    return `
      <div class="pve-disk-temp-hist-stats">
        <div><span>Min</span><b>${minT.toFixed(0)}°C</b></div>
        <div><span>Avg</span><b>${avgT.toFixed(1)}°C</b></div>
        <div><span>Max</span><b>${maxT.toFixed(0)}°C</b></div>
        <div><span>Samples</span><b>${temps.length}</b></div>
      </div>
      <svg viewBox="0 0 ${w} ${h}" width="100%" height="180" class="pve-disk-temp-hist-svg" aria-hidden="true">
        <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${color}" stop-opacity="0.28"/>
          <stop offset="100%" stop-color="${color}" stop-opacity="0.02"/>
        </linearGradient></defs>
        <text x="4" y="${pad.t + 4}" fill="rgba(255,255,255,0.35)" font-size="10">${maxT.toFixed(0)}°</text>
        <text x="4" y="${pad.t + ih}" fill="rgba(255,255,255,0.35)" font-size="10">${minT.toFixed(0)}°</text>
        <path d="${area}" fill="url(#${gid})"/>
        <path d="${line}" fill="none" stroke="${color}" stroke-width="2"/>
      </svg>`;
  }

  async function fetchPrxTempHistory(nodeCfg, disk, timeframe = "hour") {
    const name = diskPrxName(disk);
    return prxApiFetch(
      nodeCfg,
      `/api/disk/${encodeURIComponent(name)}/temperature/history?timeframe=${encodeURIComponent(timeframe)}`,
      { silent: true }
    );
  }

  function renderDiskDetails(modal, nodeCfg, disk, pane = "overview") {
    const info = diskSmartInfo(disk);
    const path = disk.devpath || "—";
    modal.__pveDiskCtx = { nodeCfg, disk, pane };
    modal.innerHTML = `
      <div class="pve-disk-hdr">
        <div class="pve-disk-hdr-main">
          <div class="pve-disk-title-row">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 12h.01M10 12h.01"/></svg>
            <span class="pve-disk-title">Disk Details: ${escH(path)}</span>
            ${info.isSystem ? `<span class="pve-st-type pve-st-type--remote"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg> System</span>` : ""}
          </div>
          <div class="pve-disk-sub">${escH(info.model)} — ${escH(info.size)}</div>
        </div>
        <button type="button" class="pve-disk-close" data-disk-close aria-label="Close">×</button>
      </div>
      <div class="pve-disk-tabs" role="tablist">
        <button type="button" class="pve-disk-tab ${pane === "overview" ? "pve-disk-tab--active pve-disk-tab--blue" : ""}" data-disk-pane="overview">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
          Overview
        </button>
        <button type="button" class="pve-disk-tab ${pane === "smart" ? "pve-disk-tab--active pve-disk-tab--green" : ""}" data-disk-pane="smart">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
          SMART
        </button>
        <button type="button" class="pve-disk-tab ${pane === "history" ? "pve-disk-tab--active pve-disk-tab--orange" : ""}" data-disk-pane="history">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/></svg>
          History
        </button>
        <button type="button" class="pve-disk-tab ${pane === "schedule" ? "pve-disk-tab--active pve-disk-tab--purple" : ""}" data-disk-pane="schedule">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
          Schedule
        </button>
      </div>
      <div class="pve-disk-body">${buildDiskDetailsPane(disk, pane)}</div>
      <div class="pve-disk-toast" hidden></div>`;

    bindDiskDetailsEvents(modal, nodeCfg, disk, pane);
  }

  function diskPrxName(disk) {
    return String(disk?.devpath || disk?.name || "").replace(/^\/dev\//, "").trim();
  }

  async function prxApiFetch(nodeCfg, path, opts = {}) {
    const targets = prxTargets(nodeCfg);
    if (!targets.length) throw new Error("No ProxMenux MONITOR URL configured");
    const silent = !!opts.silent;
    let token = getStoredPrxToken(nodeCfg);
    if (!token) {
      if (silent) throw new Error("ProxMenux token required");
      const pasted = await promptPrxTokenGuide(nodeCfg, {});
      if (!pasted) throw new Error("ProxMenux token required");
      rememberPrxToken(nodeCfg, pasted);
      token = pasted;
    }
    const method = opts.method || "GET";
    const body = opts.body != null
      ? (typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body))
      : undefined;

    const doFetch = (base, t) => fetch(`${base}${path}`, {
      method,
      cache: "no-store",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${t}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(opts.headers || {}),
      },
      body,
      signal: (() => { const c = new AbortController(); setTimeout(() => c.abort(), opts.timeoutMs || 12000); return c.signal; })(),
    });

    // Pass 1: try every host with the current token. Only treat auth as failed
    // when *all reachable* hosts return 401/403 (LAN TLS/CORS blips must not wipe tokens).
    let lastErr = null;
    let sawAuthReject = false;
    let sawReachable = false;

    for (const base of targets) {
      try {
        const res = await doFetch(base, token);
        sawReachable = true;
        if (res.status === 401 || res.status === 403) {
          sawAuthReject = true;
          continue;
        }
        if (!res.ok) {
          let detail = "";
          try {
            const j = await res.json();
            detail = j.error || j.message || j.detail || "";
          } catch {}
          throw new Error(detail || `ProxMenux ${path} HTTP ${res.status}`);
        }
        nodeCfg.activePrxUrl = base;
        if (res.status === 204) return null;
        const ct = res.headers.get("content-type") || "";
        if (ct.includes("application/json")) return res.json();
        return res.text();
      } catch (err) {
        lastErr = err;
      }
    }

    if (sawAuthReject && sawReachable) {
      if (silent) throw new Error("ProxMenux token rejected");
      const pasted = await promptPrxTokenGuide(nodeCfg, { rejected: true });
      if (!pasted) throw new Error("ProxMenux token rejected");
      rememberPrxToken(nodeCfg, pasted);
      token = pasted;

      for (const base of targets) {
        try {
          const res = await doFetch(base, token);
          if (res.status === 401 || res.status === 403) continue;
          if (!res.ok) {
            let detail = "";
            try {
              const j = await res.json();
              detail = j.error || j.message || j.detail || "";
            } catch {}
            throw new Error(detail || `ProxMenux ${path} HTTP ${res.status}`);
          }
          nodeCfg.activePrxUrl = base;
          if (res.status === 204) return null;
          const ct = res.headers.get("content-type") || "";
          if (ct.includes("application/json")) return res.json();
          return res.text();
        } catch (err) {
          lastErr = err;
        }
      }
      throw lastErr || new Error("ProxMenux token rejected");
    }

    throw lastErr || new Error(`ProxMenux ${path} failed`);
  }

  function bindDiskDetailsEvents(modal, nodeCfg, disk, pane) {
    modal.querySelector("[data-disk-close]")?.addEventListener("click", closeDiskDetails);
    modal.querySelectorAll("[data-disk-pane]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (modal.__pveSmartPoll) {
          clearInterval(modal.__pveSmartPoll);
          modal.__pveSmartPoll = null;
        }
        renderDiskDetails(modal, nodeCfg, disk, btn.getAttribute("data-disk-pane") || "overview");
      });
    });

    const toast = modal.querySelector(".pve-disk-toast");
    const showToast = (msg, ok = true) => {
      if (!toast) return;
      toast.hidden = false;
      toast.textContent = msg;
      toast.className = `pve-disk-toast ${ok ? "is-ok" : "is-err"}`;
      setTimeout(() => { toast.hidden = true; }, 3500);
    };

    const progressEl = modal.querySelector("[data-disk-progress]");
    const setProgress = (status) => {
      if (!progressEl) return;
      if (!status || status.status !== "running") {
        progressEl.hidden = true;
        progressEl.textContent = "";
        return;
      }
      const pct = status.progress != null ? Math.round(Number(status.progress)) : null;
      const label = status.test_type === "long" ? "Extended" : "Short";
      progressEl.hidden = false;
      progressEl.innerHTML = pct != null
        ? `<div class="pve-disk-progress-bar"><div style="width:${pct}%"></div></div><span>${escH(label)} test running — ${pct}%</span>`
        : `<div class="pve-disk-progress-bar pve-disk-progress-bar--indeterminate"><div></div></div><span>${escH(label)} test running…</span>`;
    };

    const applyPrxSmartToDisk = (status) => {
      if (!status) return;
      disk.__prxSmart = status;
      const mode = smartAttrTableMode(disk, status);
      const titleEl = modal.querySelector("[data-smart-title]");
      if (titleEl) titleEl.textContent = mode.title;
      const table = modal.querySelector("[data-smart-table]");
      const body = modal.querySelector("[data-smart-body]");
      if (table) {
        table.classList.toggle("pve-smart-table--compact", mode.compact);
        const head = table.querySelector(".pve-smart-head");
        if (head) {
          head.className = `pve-smart-head${mode.compact ? " pve-smart-head--compact" : ""}`;
          head.innerHTML = mode.compact
            ? `<div>Attribute</div><div>Value</div><div>Status</div>`
            : `<div>ID</div><div>Attribute</div><div>Value</div><div>Worst</div><div>Status</div>`;
        }
      }
      if (body) body.innerHTML = buildSmartAttrRowsHtml(disk, status);
      setProgress(status);
    };

    const pollSmartStatus = (testType) => {
      if (modal.__pveSmartPoll) clearInterval(modal.__pveSmartPoll);
      let polls = 0;
      const maxPolls = testType === "long" ? 720 : 36;
      modal.__pveSmartPoll = setInterval(async () => {
        polls += 1;
        try {
          const status = await fetchPrxSmartStatus(nodeCfg, disk, { silent: true });
          applyPrxSmartToDisk(status);
          if (status?.status !== "running") {
            clearInterval(modal.__pveSmartPoll);
            modal.__pveSmartPoll = null;
            showToast(status?.result || status?.last_test?.status || "SMART test finished");
          }
        } catch {}
        if (polls >= maxPolls) {
          clearInterval(modal.__pveSmartPoll);
          modal.__pveSmartPoll = null;
        }
      }, 5000);
    };

    modal.querySelectorAll("[data-disk-test]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const kind = btn.getAttribute("data-disk-test") || "short";
        const testType = kind === "long" ? "long" : "short";
        btn.disabled = true;
        try {
          await runPrxSmartTest(nodeCfg, disk, testType);
          showToast(`${testType === "long" ? "Extended" : "Short"} SMART test started via ProxMenux`);
          setProgress({ status: "running", test_type: testType });
          pollSmartStatus(testType);
        } catch (err) {
          showToast(err.message || "Failed to start SMART test", false);
        } finally {
          btn.disabled = false;
        }
      });
    });

    modal.querySelector("[data-disk-report]")?.addEventListener("click", async () => {
      const btn = modal.querySelector("[data-disk-report]");
      if (btn) btn.disabled = true;
      const reportWindow = window.open("about:blank", "_blank");
      if (reportWindow) {
        try {
          reportWindow.document.write(
            '<html><body style="background:#0f172a;color:#e2e8f0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><div style="border:3px solid transparent;border-top-color:#06b6d4;border-radius:50%;width:40px;height:40px;animation:spin 1s linear infinite;margin:0 auto"></div><p style="margin-top:16px">Loading ProxMenux SMART report…</p><style>@keyframes spin{to{transform:rotate(360deg)}}</style></div></body></html>'
          );
        } catch {}
      }
      try {
        await openPrxSmartReport(nodeCfg, disk, reportWindow || undefined);
      } catch (err) {
        if (reportWindow && !reportWindow.closed) {
          try {
            reportWindow.document.body.innerHTML =
              `<div style="padding:40px;font-family:sans-serif;color:#fecaca">${escH(err.message || String(err))}</div>`;
          } catch {}
        }
        showToast(err.message || "Failed to open SMART report", false);
      } finally {
        if (btn) btn.disabled = false;
      }
    });

    if (pane === "smart") {
      fetchPrxSmartStatus(nodeCfg, disk, { silent: true })
        .then(applyPrxSmartToDisk)
        .catch(() => {});
    }
    if (pane === "overview" && (!disk.__prxSmart || !disk.__prxTempHour)) {
      enrichDiskFromPrx(nodeCfg, disk).then(() => {
        if (!_diskModal || !document.body.contains(modal)) return;
        if (modal.__pveDiskCtx?.pane === "overview") {
          renderDiskDetails(modal, nodeCfg, disk, "overview");
        }
      });
    }
    modal.querySelector("[data-disk-temp-open]")?.addEventListener("click", () => {
      openDiskTempHistory(nodeCfg, disk);
    });
    if (pane === "history") hydratePrxSmartHistory(modal, nodeCfg, disk, showToast);
    if (pane === "schedule") hydratePrxSmartSchedule(modal, nodeCfg, disk, showToast);
  }

  async function openDiskTempHistory(nodeCfg, disk) {
    const info = diskSmartInfo(disk);
    const name = diskPrxName(disk);
    const existing = document.querySelector(".pve-temp-backdrop");
    if (existing) existing.remove();

    const backdrop = document.createElement("div");
    backdrop.className = "pve-temp-backdrop";
    const panel = document.createElement("div");
    panel.className = "pve-temp-modal";
    panel.innerHTML = `
      <div class="pve-temp-hdr">
        <div>
          <div class="pve-temp-title">Temperature History</div>
          <div class="pve-temp-sub">${escH(disk.devpath || name)} · ${escH(info.model)}</div>
        </div>
        <button type="button" class="pve-disk-close" data-temp-close aria-label="Close">×</button>
      </div>
      <div class="pve-temp-live" style="color:${info.temp == null ? "" : (info.temp < 60 ? "#22c55e" : "#f87171")}">
        ${info.temp != null ? `${Math.round(info.temp)}°C` : "—"}
        <span>${info.temp == null || info.temp < 60 ? "Normal" : "Hot"}</span>
      </div>
      <div class="pve-temp-ranges" role="tablist">
        <button type="button" class="pve-temp-range" data-temp-tf="hour">1 Hour</button>
        <button type="button" class="pve-temp-range is-active" data-temp-tf="day">24 Hours</button>
        <button type="button" class="pve-temp-range" data-temp-tf="week">7 Days</button>
        <button type="button" class="pve-temp-range" data-temp-tf="month">30 Days</button>
      </div>
      <div class="pve-temp-body" data-temp-body>Loading…</div>`;
    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);

    const close = () => backdrop.remove();
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
    panel.querySelector("[data-temp-close]")?.addEventListener("click", close);

    const body = panel.querySelector("[data-temp-body]");
    const load = async (tf) => {
      panel.querySelectorAll("[data-temp-tf]").forEach((b) => {
        b.classList.toggle("is-active", b.getAttribute("data-temp-tf") === tf);
      });
      body.textContent = "Loading…";
      try {
        const payload = await fetchPrxTempHistory(nodeCfg, disk, tf);
        const points = normalizeTempHistoryPoints(payload);
        if (payload?.stats) {
          // prefer backend stats when present
        }
        const color = info.temp != null && info.temp >= 60 ? "#f87171" : "#22c55e";
        body.innerHTML = buildTempHistoryChartSvg(points, color);
        if (payload?.stats) {
          const stats = payload.stats;
          const row = body.querySelector(".pve-disk-temp-hist-stats");
          if (row && (stats.min != null || stats.avg != null || stats.max != null)) {
            row.innerHTML = `
              <div><span>Min</span><b>${stats.min != null ? `${Number(stats.min).toFixed(0)}°C` : "—"}</b></div>
              <div><span>Avg</span><b>${stats.avg != null ? `${Number(stats.avg).toFixed(1)}°C` : "—"}</b></div>
              <div><span>Max</span><b>${stats.max != null ? `${Number(stats.max).toFixed(0)}°C` : "—"}</b></div>
              <div><span>Samples</span><b>${points.length}</b></div>`;
          }
        }
      } catch (err) {
        body.innerHTML = `<div class="pve-disk-temp-hist-empty">${escH(err.message || String(err))}</div>`;
      }
    };

    panel.querySelectorAll("[data-temp-tf]").forEach((btn) => {
      btn.addEventListener("click", () => load(btn.getAttribute("data-temp-tf") || "day"));
    });
    load("day");
  }

  async function fetchPrxSmartStatus(nodeCfg, disk, { silent = false } = {}) {
    const name = diskPrxName(disk);
    if (!name) throw new Error("Unknown disk name");
    const status = await prxApiFetch(nodeCfg, `/api/storage/smart/${encodeURIComponent(name)}`, { silent });
    disk.__prxSmart = status;
    return status;
  }

  async function enrichDiskFromPrx(nodeCfg, disk) {
    const name = diskPrxName(disk);
    if (!name || !getPrxUrl(nodeCfg)) return disk;
    const tasks = [
      fetchPrxSmartStatus(nodeCfg, disk, { silent: true }).catch(() => null),
    ];
    if (!disk.__prxDisk) {
      tasks.push(
        fetchPrxStorageDisks(nodeCfg)
          .then((list) => {
            const match = findPrxDiskMatch(list, disk);
            if (match) disk.__prxDisk = match;
            return match || null;
          })
          .catch(() => null)
      );
    }
    await Promise.all(tasks);
    // Hourly sparkline for Overview temperature card
    try {
      disk.__prxTempHour = await fetchPrxTempHistory(nodeCfg, disk, "hour");
    } catch {
      disk.__prxTempHour = disk.__prxTempHour || null;
    }
    applyPrxInventoryFields(disk);
    return disk;
  }

  function findPrxDiskMatch(list, disk) {
    const name = diskPrxName(disk);
    if (!Array.isArray(list) || !name) return null;
    return list.find((d) => {
      const n = String(d?.name || "").replace(/^\/dev\//, "");
      return n === name || d?.name === disk.devpath || `/dev/${n}` === disk.devpath
        || (disk.serial && d.serial && String(d.serial) === String(disk.serial));
    }) || null;
  }

  function applyPrxInventoryFields(disk) {
    const sd = disk.__prxSmart?.smart_data || {};
    const nr = sd.nvme_raw || {};
    const prx = disk.__prxDisk || {};
    if (disk.temperature == null) {
      const t = firstFinite(prx.temperature, sd.temperature, nr.temperature);
      if (t != null && t > 0) disk.temperature = t;
    }
    if (disk.power_on_hours == null) {
      const h = firstFinite(prx.power_on_hours, sd.power_on_hours, nr.power_on_hours);
      if (h != null && h > 0) disk.power_on_hours = h;
    }
    if (disk.power_cycles == null) {
      const c = firstFinite(prx.power_cycles, sd.power_cycles, nr.power_cycles);
      if (c != null && c > 0) disk.power_cycles = c;
    }
    const used = firstFinite(prx.percentage_used, nr.percent_used, sd.percent_used);
    if (used != null) disk.percentage_used = used;
    const health = prx.smart_status || prx.health || sd.smart_status;
    if (health && (!disk.health || /unknown/i.test(String(disk.health)))) {
      disk.health = String(health).toUpperCase();
    }
    // Prefer ProxMenux model when PVE model is a cryptic bridge name
    if (prx.model && (!disk.model || /_nvme$/i.test(String(disk.model)))) {
      disk.model = prx.model;
    }
    return disk;
  }

  async function fetchPrxStorageDisks(nodeCfg) {
    if (!getPrxUrl(nodeCfg)) return [];
    const key = prxUrlKey(nodeCfg.prxUrl || nodeCfg.prxFallbackUrl);
    const cached = _prxStorageDiskCache[key];
    if (cached && Date.now() - cached.at < 60_000) return cached.list;
    const storage = await prxApiFetch(nodeCfg, "/api/storage", { silent: true });
    const list = Array.isArray(storage?.disks) ? storage.disks
      : Array.isArray(storage?.physical_disks) ? storage.physical_disks
      : Array.isArray(storage) ? storage
      : [];
    _prxStorageDiskCache[key] = { at: Date.now(), list };
    return list;
  }

  /** Merge ProxMenux /api/storage inventory onto PVE disk cards (power-on, cycles, health, wear). */
  async function enrichPveDisksFromPrx(nodeCfg, disks) {
    if (!getPrxUrl(nodeCfg) || !Array.isArray(disks) || !disks.length) return disks;
    try {
      const list = await fetchPrxStorageDisks(nodeCfg);
      disks.forEach((disk) => {
        const match = findPrxDiskMatch(list, disk);
        if (match) disk.__prxDisk = match;
        applyPrxInventoryFields(disk);
      });
    } catch (err) {
      console.warn(`[PveWidget] ProxMenux disk inventory:`, err.message || err);
    }
    return disks;
  }

  async function runPrxSmartTest(nodeCfg, disk, testType) {
    const name = diskPrxName(disk);
    if (!name) throw new Error("Unknown disk name");
    return prxApiFetch(nodeCfg, `/api/storage/smart/${encodeURIComponent(name)}/test`, {
      method: "POST",
      body: { test_type: testType === "long" ? "long" : "short" },
    });
  }

  async function hydratePrxSmartHistory(modal, nodeCfg, disk, showToast) {
    const root = modal.querySelector("[data-prx-hist-root]");
    if (!root) return;
    const name = diskPrxName(disk);
    try {
      const data = await prxApiFetch(nodeCfg, `/api/storage/smart/${encodeURIComponent(name)}/history?limit=50`);
      const hist = Array.isArray(data?.history) ? data.history : [];
      if (!hist.length) {
        root.innerHTML = `
          <div class="pve-disk-empty">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" opacity=".45"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>
            <div class="pve-disk-empty-title">No test history</div>
            <div class="pve-disk-empty-sub">Run a SMART test to start building history for this disk.</div>
          </div>`;
        return;
      }
      root.innerHTML = `
        <div class="pve-disk-hist-list">
          ${hist.map((h) => `
            <div class="pve-disk-hist-item">
              <div>
                <div class="pve-disk-hist-type">${escH(h.test_type || "test")}</div>
                <div class="pve-disk-hist-when">${escH(h.date_readable || h.timestamp || "")}</div>
              </div>
              <div class="pve-disk-hist-actions">
                <button type="button" class="pve-disk-hist-view" data-hist-view="${escH(h.filename || "")}">View</button>
                <button type="button" class="pve-disk-sched-del" data-hist-del="${escH(h.filename || "")}" title="Remove">×</button>
              </div>
            </div>`).join("")}
        </div>`;
      root.querySelectorAll("[data-hist-view]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const filename = btn.getAttribute("data-hist-view");
          if (!filename) return;
          const reportWindow = window.open("about:blank", "_blank");
          try {
            const entry = await prxApiFetch(
              nodeCfg,
              `/api/storage/smart/${encodeURIComponent(name)}/history/${encodeURIComponent(filename)}`
            );
            const status = await fetchPrxSmartStatus(nodeCfg, disk, { silent: true }).catch(() => disk.__prxSmart);
            openPrxSmartReportFromStatus(nodeCfg, disk, status || {}, reportWindow || undefined, {
              lastTestDate: entry?.timestamp || entry?.date_readable,
              historical: true,
              historyPayload: entry,
            });
          } catch (err) {
            if (reportWindow && !reportWindow.closed) {
              try {
                reportWindow.document.body.innerHTML =
                  `<div style="padding:40px;font-family:sans-serif;color:#fecaca">${escH(err.message || String(err))}</div>`;
              } catch {}
            }
            showToast(err.message || "Failed to open history report", false);
          }
        });
      });
      root.querySelectorAll("[data-hist-del]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const filename = btn.getAttribute("data-hist-del");
          if (!filename || !confirm(`Delete history entry ${filename}?`)) return;
          try {
            await prxApiFetch(
              nodeCfg,
              `/api/storage/smart/${encodeURIComponent(name)}/history/${encodeURIComponent(filename)}`,
              { method: "DELETE" }
            );
            hydratePrxSmartHistory(modal, nodeCfg, disk, showToast);
          } catch (err) {
            showToast(err.message || "Delete failed", false);
          }
        });
      });
    } catch (err) {
      root.innerHTML = `
        <div class="pve-disk-empty">
          <div class="pve-disk-empty-title">History unavailable</div>
          <div class="pve-disk-empty-sub">${escH(err.message || String(err))}</div>
        </div>`;
    }
  }

  async function hydratePrxSmartSchedule(modal, nodeCfg, disk, showToast, opts = {}) {
    const root = modal.querySelector("[data-prx-sched-root]");
    if (!root) return;
    const name = diskPrxName(disk);
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const showForm = !!opts.showForm;
    const editing = opts.editing || null;
    const formDefaults = {
      test_type: "short",
      frequency: "weekly",
      hour: 3,
      minute: 0,
      day_of_week: 0,
      day_of_month: 1,
      retention: 10,
      ...(editing || {}),
    };
    const formatScheduleTime = (s) => {
      const time = `${String(s.hour ?? 0).padStart(2, "0")}:${String(s.minute ?? 0).padStart(2, "0")}`;
      if (s.frequency === "daily") return `Daily at ${time}`;
      if (s.frequency === "weekly") return `${dayNames[s.day_of_week ?? 0]}s at ${time}`;
      return `Day ${s.day_of_month ?? 1} of month at ${time}`;
    };
    const hourOpts = Array.from({ length: 24 }, (_, i) =>
      `<option value="${i}" ${Number(formDefaults.hour) === i ? "selected" : ""}>${String(i).padStart(2, "0")}:00</option>`
    ).join("");
    const dayWeekOpts = dayNames.map((d, i) =>
      `<option value="${i}" ${Number(formDefaults.day_of_week) === i ? "selected" : ""}>${escH(d)}</option>`
    ).join("");
    const dayMonthOpts = Array.from({ length: 28 }, (_, i) => i + 1).map((d) =>
      `<option value="${d}" ${Number(formDefaults.day_of_month) === d ? "selected" : ""}>${d}</option>`
    ).join("");
    const retentionOpts = [5, 10, 20, 50, 0].map((n) =>
      `<option value="${n}" ${Number(formDefaults.retention) === n ? "selected" : ""}>${n === 0 ? "Keep All" : `Last ${n}`}</option>`
    ).join("");

    try {
      const config = await prxApiFetch(nodeCfg, "/api/storage/smart/schedules");
      const all = Array.isArray(config?.schedules) ? config.schedules : [];
      const items = all.filter((s) => {
        const disks = s.disks || [];
        return disks.includes("all") || disks.includes(name);
      });

      const formHtml = showForm ? `
        <div class="pve-disk-sched-form" data-sched-form>
          <div class="pve-disk-sched-form-title">${editing ? "Edit Schedule" : "New Schedule"}</div>
          <div class="pve-disk-sched-form-grid">
            <label class="pve-disk-sched-field">
              <span>Test Type</span>
              <select data-sched-field="test_type">
                <option value="short" ${formDefaults.test_type === "short" ? "selected" : ""}>Short Test (~2 min)</option>
                <option value="long" ${formDefaults.test_type === "long" ? "selected" : ""}>Long Test (1-4 hours)</option>
              </select>
            </label>
            <label class="pve-disk-sched-field">
              <span>Frequency</span>
              <select data-sched-field="frequency">
                <option value="daily" ${formDefaults.frequency === "daily" ? "selected" : ""}>Daily</option>
                <option value="weekly" ${formDefaults.frequency === "weekly" ? "selected" : ""}>Weekly</option>
                <option value="monthly" ${formDefaults.frequency === "monthly" ? "selected" : ""}>Monthly</option>
              </select>
            </label>
            <label class="pve-disk-sched-field" data-sched-dow ${formDefaults.frequency === "weekly" ? "" : "hidden"}>
              <span>Day of Week</span>
              <select data-sched-field="day_of_week">${dayWeekOpts}</select>
            </label>
            <label class="pve-disk-sched-field" data-sched-dom ${formDefaults.frequency === "monthly" ? "" : "hidden"}>
              <span>Day of Month</span>
              <select data-sched-field="day_of_month">${dayMonthOpts}</select>
            </label>
            <label class="pve-disk-sched-field">
              <span>Time (Hour)</span>
              <select data-sched-field="hour">${hourOpts}</select>
            </label>
            <label class="pve-disk-sched-field">
              <span>Keep Results</span>
              <select data-sched-field="retention">${retentionOpts}</select>
            </label>
          </div>
          <div class="pve-disk-sched-form-actions">
            <button type="button" class="pve-disk-sched-save" data-sched-save>Save Schedule</button>
            <button type="button" class="pve-disk-sched-cancel" data-sched-cancel>Cancel</button>
          </div>
        </div>` : `
        <button type="button" class="pve-disk-add-sched" data-disk-sched-add>+ Add Schedule</button>`;

      root.innerHTML = `
        <div class="pve-disk-sched-hdr">
          <div>
            <div class="pve-disk-sched-title">Automatic SMART Tests</div>
            <div class="pve-disk-hint">Enable or disable all scheduled tests</div>
          </div>
          <button type="button" class="pve-disk-sched-toggle ${config?.enabled ? "is-on" : ""}" data-disk-sched-toggle>
            ${config?.enabled ? "Enabled" : "Disabled"}
          </button>
        </div>
        ${items.length ? `
          <div class="pve-disk-hist-list">
            ${items.map((it) => `
              <div class="pve-disk-hist-item">
                <div>
                  <div class="pve-disk-hist-type">
                    <span class="pve-disk-sched-badge ${it.test_type === "long" ? "is-long" : "is-short"}">${escH(it.test_type || "short")}</span>
                    ${escH(formatScheduleTime(it))}
                  </div>
                  <div class="pve-disk-hist-when">${escH((it.disks || []).includes("all") ? "All disks" : (it.disks || []).join(", "))} · Keep ${escH(String(it.retention ?? 10))} results</div>
                </div>
                <div class="pve-disk-hist-actions">
                  <button type="button" class="pve-disk-hist-view" data-disk-sched-edit="${escH(it.id || "")}" title="Edit">✎</button>
                  <button type="button" class="pve-disk-sched-del" data-disk-sched-del="${escH(it.id || "")}" title="Remove">×</button>
                </div>
              </div>`).join("")}
          </div>` : `
          <div class="pve-disk-empty pve-disk-empty--compact">
            <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" opacity=".45"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
            <div class="pve-disk-empty-title">No scheduled tests configured</div>
            <div class="pve-disk-empty-sub">Create a schedule to automatically run SMART tests</div>
          </div>`}
        ${formHtml}
        <div class="pve-disk-hint" style="text-align:center;margin-top:10px">Scheduled tests run automatically via cron. Results are saved to the SMART history.</div>`;

      const syncFreqFields = () => {
        const freq = root.querySelector('[data-sched-field="frequency"]')?.value || "weekly";
        const dow = root.querySelector("[data-sched-dow]");
        const dom = root.querySelector("[data-sched-dom]");
        if (dow) dow.hidden = freq !== "weekly";
        if (dom) dom.hidden = freq !== "monthly";
      };

      root.querySelector("[data-disk-sched-toggle]")?.addEventListener("click", async () => {
        try {
          await prxApiFetch(nodeCfg, "/api/storage/smart/schedules/toggle", {
            method: "POST",
            body: { enabled: !config.enabled },
          });
          hydratePrxSmartSchedule(modal, nodeCfg, disk, showToast, { showForm });
        } catch (err) {
          showToast(err.message || "Toggle failed", false);
        }
      });

      root.querySelector("[data-disk-sched-add]")?.addEventListener("click", () => {
        hydratePrxSmartSchedule(modal, nodeCfg, disk, showToast, { showForm: true });
      });

      root.querySelector("[data-sched-cancel]")?.addEventListener("click", () => {
        hydratePrxSmartSchedule(modal, nodeCfg, disk, showToast, { showForm: false });
      });

      root.querySelector('[data-sched-field="frequency"]')?.addEventListener("change", syncFreqFields);

      root.querySelector("[data-sched-save]")?.addEventListener("click", async () => {
        const btn = root.querySelector("[data-sched-save]");
        const read = (key) => root.querySelector(`[data-sched-field="${key}"]`)?.value;
        const body = {
          test_type: read("test_type") === "long" ? "long" : "short",
          frequency: read("frequency") || "weekly",
          hour: Number(read("hour") || 3),
          minute: editing?.minute != null ? Number(editing.minute) : 0,
          day_of_week: Number(read("day_of_week") || 0),
          day_of_month: Number(read("day_of_month") || 1),
          disks: editing?.disks?.length ? editing.disks : [name],
          retention: Number(read("retention") ?? 10),
          active: editing?.active != null ? !!editing.active : true,
          notify_on_complete: editing?.notify_on_complete != null ? !!editing.notify_on_complete : true,
          notify_only_on_failure: editing?.notify_only_on_failure != null ? !!editing.notify_only_on_failure : false,
        };
        if (editing?.id) body.id = editing.id;
        if (btn) {
          btn.disabled = true;
          btn.textContent = "Saving…";
        }
        try {
          await prxApiFetch(nodeCfg, "/api/storage/smart/schedules", {
            method: "POST",
            body,
          });
          showToast(editing ? "Schedule updated" : "Schedule saved");
          hydratePrxSmartSchedule(modal, nodeCfg, disk, showToast, { showForm: false });
        } catch (err) {
          showToast(err.message || "Failed to save schedule", false);
          if (btn) {
            btn.disabled = false;
            btn.textContent = "Save Schedule";
          }
        }
      });

      root.querySelectorAll("[data-disk-sched-edit]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const id = btn.getAttribute("data-disk-sched-edit");
          const found = items.find((s) => String(s.id) === String(id));
          if (!found) return;
          hydratePrxSmartSchedule(modal, nodeCfg, disk, showToast, {
            showForm: true,
            editing: found,
          });
        });
      });

      root.querySelectorAll("[data-disk-sched-del]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const id = btn.getAttribute("data-disk-sched-del");
          if (!id) return;
          try {
            await prxApiFetch(nodeCfg, `/api/storage/smart/schedules/${encodeURIComponent(id)}`, {
              method: "DELETE",
            });
            hydratePrxSmartSchedule(modal, nodeCfg, disk, showToast, { showForm: false });
          } catch (err) {
            showToast(err.message || "Delete failed", false);
          }
        });
      });
    } catch (err) {
      root.innerHTML = `
        <div class="pve-disk-empty">
          <div class="pve-disk-empty-title">Schedules unavailable</div>
          <div class="pve-disk-empty-sub">${escH(err.message || String(err))}</div>
        </div>`;
    }
  }

  async function openPrxSmartReport(nodeCfg, disk, targetWindow) {
    const status = await fetchPrxSmartStatus(nodeCfg, disk);
    let observations = [];
    let tempHistory = null;
    const name = diskPrxName(disk);
    try {
      const obs = await prxApiFetch(
        nodeCfg,
        `/api/storage/observations?disk=${encodeURIComponent(name)}&limit=20`,
        { silent: true }
      );
      observations = normalizeSmartObservations(obs);
    } catch {}
    try {
      for (const tf of ["month", "week", "day", "hour"]) {
        try {
          const result = await prxApiFetch(
            nodeCfg,
            `/api/disk/${encodeURIComponent(name)}/temperature/history?timeframe=${tf}`,
            { silent: true }
          );
          if (result?.data && result.data.length >= 2) {
            tempHistory = result;
            break;
          }
        } catch {}
      }
    } catch {}
    openPrxSmartReportFromStatus(nodeCfg, disk, status, targetWindow, {
      observations,
      tempHistory,
      lastTestDate: status?.last_test?.timestamp,
    });
  }

  function normalizeSmartObservations(payload) {
    const list = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.observations)
        ? payload.observations
        : Array.isArray(payload?.data)
          ? payload.data
          : [];
    return list.filter((o) => o != null);
  }

  function formatSmartObservationHtml(o) {
    if (typeof o === "string") {
      return `<li class="obs-item"><div class="obs-msg">${escH(o)}</div></li>`;
    }
    const sev = String(o.severity || o.level || o.status || "info").toLowerCase();
    const sevColor = /crit|error|fail/.test(sev)
      ? "#dc2626"
      : /warn/.test(sev)
        ? "#ca8a04"
        : "#2563eb";
    const typeRaw = o.error_type || o.type || o.title || "Observation";
    const typeLabel = String(typeRaw).replace(/_/g, " ");
    const msg = o.raw_message || o.message || o.detail || o.description || "";
    const count = o.occurrence_count != null ? Number(o.occurrence_count) : null;
    const when = o.last_occurrence || o.first_occurrence || o.timestamp || "";
    let whenLabel = "";
    if (when) {
      try {
        const d = new Date(when);
        whenLabel = Number.isNaN(d.getTime()) ? String(when) : d.toLocaleString();
      } catch {
        whenLabel = String(when);
      }
    }
    const msgHtml = msg
      ? escH(String(msg)).replace(/\n/g, "<br>")
      : escH(`${typeLabel}${o.device_name ? ` on ${o.device_name}` : ""}`);
    return `<li class="obs-item" style="border-left-color:${sevColor}">
      <div class="obs-top">
        <span class="obs-sev" style="color:${sevColor}">${escH(sev)}</span>
        <span class="obs-type">${escH(typeLabel)}</span>
        ${count != null && !Number.isNaN(count) ? `<span class="obs-count">×${escH(String(count))}</span>` : ""}
        ${whenLabel ? `<span class="obs-when">${escH(whenLabel)}</span>` : ""}
      </div>
      <div class="obs-msg">${msgHtml}</div>
    </li>`;
  }

  function openPrxSmartReportFromStatus(nodeCfg, disk, testStatus, targetWindow, opts = {}) {
    const info = diskSmartInfo(disk);
    const name = diskPrxName(disk);
    const sd = testStatus?.smart_data || opts.historyPayload?.smart_data || {};
    const attrs = Array.isArray(sd.attributes) ? sd.attributes
      : Array.isArray(testStatus?.smart_data?.attributes) ? testStatus.smart_data.attributes
      : [];
    const healthStatus = String(testStatus?.smart_status || sd.smart_status || info.health || "unknown");
    const isHealthy = /passed|ok/i.test(healthStatus);
    const healthColor = isHealthy ? "#16a34a" : /failed/i.test(healthStatus) ? "#dc2626" : "#ca8a04";
    const healthLabel = isHealthy ? "PASSED" : healthStatus.toUpperCase();
    const isNvme = name.startsWith("nvme") || info.kind === "nvme";
    const diskType = isNvme ? "NVMe" : (info.rotation === "SSD" || !disk.rpm ? "SSD" : "HDD");
    const now = new Date().toLocaleString();
    const reportId = `SMART-${Date.now().toString(36).toUpperCase()}`;
    const nodeLabel = `${nodeCfg.groupName || nodeCfg.pveNode || "node"}-${name}`;
    const powerOnHours = info.powerOnHours || sd.power_on_hours || 0;
    const powerOnDays = Math.round(powerOnHours / 24);
    const temp = info.temp != null ? Math.round(info.temp) : (sd.temperature != null ? Math.round(sd.temperature) : null);
    const wear = info.wear != null ? info.wear : (sd.percent_used != null ? Number(sd.percent_used) : null);
    const life = wear != null ? Math.max(0, 100 - wear) : (info.lifePct != null ? info.lifePct : null);
    const lastTest = testStatus?.last_test || {};
    const observations = opts.observations || [];
    const fmt = (n) => (n == null || Number.isNaN(Number(n)) ? "—" : Number(n).toLocaleString("en-US"));

    const attrRows = attrs.slice(0, 24).map((a) => {
      const st = a.status || "ok";
      const badge = st === "ok"
        ? '<span style="background:#dcfce7;color:#166534;padding:2px 8px;border-radius:6px;font-size:11px;font-weight:700">OK</span>'
        : st === "warning"
          ? '<span style="background:#ffedd5;color:#9a3412;padding:2px 8px;border-radius:6px;font-size:11px;font-weight:700">WARNING</span>'
          : '<span style="background:#fee2e2;color:#991b1b;padding:2px 8px;border-radius:6px;font-size:11px;font-weight:700">CRITICAL</span>';
      const val = a.raw_value != null && a.raw_value !== "" ? a.raw_value : a.value;
      return `<tr><td>${escH(a.name || "—")}</td><td style="font-family:ui-monospace,monospace">${escH(val == null ? "—" : String(val))}</td><td>${badge}</td></tr>`;
    }).join("") || `<tr><td colspan="3">No attributes available</td></tr>`;

    let tempSvg = "";
    const points = opts.tempHistory?.data || opts.tempHistory?.points || opts.tempHistory?.history || [];
    if (Array.isArray(points) && points.length > 1) {
      const temps = points.map((p) => Number(p.temp ?? p.temperature ?? p.value)).filter((n) => !Number.isNaN(n));
      if (temps.length > 1) {
        const minT = opts.tempHistory?.stats?.min != null ? Number(opts.tempHistory.stats.min) : Math.min(...temps);
        const maxT = opts.tempHistory?.stats?.max != null ? Number(opts.tempHistory.stats.max) : Math.max(...temps);
        const avgT = opts.tempHistory?.stats?.avg != null ? Number(opts.tempHistory.stats.avg) : (temps.reduce((a, b) => a + b, 0) / temps.length);
        const w = 560;
        const h = 120;
        const path = temps.map((t, i) => {
          const x = (i / (temps.length - 1)) * w;
          const y = h - ((t - minT) / Math.max(1, maxT - minT)) * (h - 16) - 8;
          return `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
        }).join(" ");
        tempSvg = `
          <div style="margin-top:16px">
            <div style="font-size:12px;color:#64748b;margin-bottom:8px">Temperature History — Min ${minT.toFixed(0)}°C · Avg ${avgT.toFixed(1)}°C · Max ${maxT.toFixed(0)}°C</div>
            <svg viewBox="0 0 ${w} ${h}" width="100%" height="120" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px">
              <path d="${path}" fill="none" stroke="#2563eb" stroke-width="2"/>
            </svg>
          </div>`;
      }
    }

    const recs = isHealthy
      ? [
          ["#16a34a", "Disk is Healthy", "SMART status is within normal parameters. Continue periodic short tests."],
          ["#2563eb", "Regular Maintenance", "Run a short SMART test weekly and an extended test monthly via ProxMenux schedules."],
          ["#2563eb", "Backup Strategy", "Healthy disks still fail. Keep tested backups of critical data."],
        ]
      : [
          ["#dc2626", "Investigate Health", "SMART reported warnings or failures. Review metrics and plan replacement."],
          ["#ca8a04", "Run Extended Test", "Start an extended SMART test now and review History when complete."],
          ["#2563eb", "Backup Immediately", "Back up critical data before the disk degrades further."],
        ];

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>SMART Health Report — ${escH(name)}</title>
<style>
  *{box-sizing:border-box} body{margin:0;font-family:Inter,Segoe UI,system-ui,sans-serif;background:#f1f5f9;color:#0f172a}
  .wrap{max-width:920px;margin:0 auto;padding:28px 20px 48px}
  .hdr{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;margin-bottom:22px}
  .hdr h1{margin:0;font-size:28px} .hdr .sub{color:#64748b;margin-top:4px;font-size:13px}
  .meta{text-align:right;font-size:12px;color:#64748b;line-height:1.5}
  .print{appearance:none;border:0;background:#2563eb;color:#fff;padding:10px 14px;border-radius:8px;font-weight:700;cursor:pointer;margin-top:8px}
  .card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:20px;margin-bottom:16px;box-shadow:0 1px 2px rgba(15,23,42,.04);overflow:hidden;max-width:100%}
  .sec-title{font-size:15px;font-weight:800;margin:0 0 14px;display:flex;align-items:center;gap:8px}
  .sec-title span{display:inline-flex;width:22px;height:22px;border-radius:999px;background:#eff6ff;color:#2563eb;align-items:center;justify-content:center;font-size:11px}
  .pass{display:flex;gap:18px;align-items:center}
  .badge{width:88px;height:88px;border-radius:999px;border:4px solid ${healthColor};color:${healthColor};display:flex;flex-direction:column;align-items:center;justify-content:center;font-weight:900;font-size:13px;flex-shrink:0}
  .badge b{font-size:28px;line-height:1}
  .banner{margin-top:14px;padding:12px 14px;border-radius:8px;background:${isHealthy ? "#dcfce7" : "#fee2e2"};color:${isHealthy ? "#166534" : "#991b1b"};font-size:13px}
  .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
  .kv{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px}
  .kv span{display:block;font-size:11px;color:#64748b;margin-bottom:4px} .kv b{font-size:13px;overflow-wrap:anywhere;word-break:break-word}
  table{width:100%;border-collapse:collapse;font-size:13px;table-layout:fixed}
  th,td{padding:10px 12px;border-bottom:1px solid #e2e8f0;text-align:left;overflow-wrap:anywhere;word-break:break-word}
  th{font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;background:#f8fafc}
  .recs{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
  .rec{border:1px solid #e2e8f0;border-radius:10px;padding:14px;border-top:3px solid var(--c)}
  .rec h4{margin:0 0 6px;font-size:13px} .rec p{margin:0;font-size:12px;color:#64748b;line-height:1.45}
  .obs-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px;max-width:100%}
  .obs-item{background:#f8fafc;border:1px solid #e2e8f0;border-left:3px solid #2563eb;border-radius:8px;padding:10px 12px;max-width:100%;overflow-wrap:anywhere;word-break:break-word}
  .obs-top{display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:11px;margin-bottom:6px}
  .obs-sev{font-weight:800;text-transform:uppercase;letter-spacing:.04em}
  .obs-type{font-weight:700;color:#334155;text-transform:capitalize}
  .obs-count,.obs-when{color:#64748b}
  .obs-msg{font-size:13px;color:#475569;line-height:1.55;white-space:normal;overflow-wrap:anywhere;word-break:break-word}
  .footer{text-align:center;color:#94a3b8;font-size:12px;margin-top:20px}
  .life{display:flex;gap:24px;align-items:center}
  .ring{width:110px;height:110px;border-radius:999px;background:conic-gradient(#16a34a ${life != null ? life : 0}%,#e2e8f0 0);display:flex;align-items:center;justify-content:center}
  .ring i{width:84px;height:84px;border-radius:999px;background:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;font-weight:900}
  .ring small{font-weight:600;color:#64748b;font-size:11px}
  @media print{.print{display:none} body{background:#fff} .wrap{padding:0}}
  @media (max-width:720px){.grid,.recs{grid-template-columns:1fr 1fr}.hdr{flex-direction:column}}
</style></head><body>
<div class="wrap">
  <div class="hdr">
    <div>
      <h1>SMART Health Report</h1>
      <div class="sub">ProxMenux Monitor — Disk Health Analysis</div>
    </div>
    <div class="meta">
      <div>${escH(now)}</div>
      <div>${escH(nodeLabel)}</div>
      <div>${escH(reportId)}</div>
      <button class="print" onclick="window.print()">Print / Save as PDF</button>
    </div>
  </div>

  <div class="card">
    <div class="sec-title"><span>1</span> Executive Summary</div>
    <div class="pass">
      <div class="badge"><b>✓</b>${escH(healthLabel)}</div>
      <div>
        <div style="font-size:15px;font-weight:700;margin-bottom:6px">Disk Health Assessment</div>
        <div style="font-size:13px;color:#475569;line-height:1.5">
          ${isHealthy
            ? `This disk is operating within normal SMART parameters${temp != null ? ` at ${temp}°C` : ""}${powerOnHours ? ` after ~${fmt(powerOnDays)} days powered on` : ""}.`
            : "SMART status indicates this disk needs attention. Review metrics below and plan remediation."}
        </div>
        <div class="banner">${isHealthy
          ? "Disk is healthy. Continue periodic SMART tests through ProxMenux."
          : "Warnings or failures detected. Investigate attributes and verify backups."}</div>
      </div>
    </div>
    <table style="margin-top:16px">
      <tr><th>Report Generated</th><th>Last Test Type</th><th>Test Result</th><th>Attributes Checked</th></tr>
      <tr>
        <td>${escH(now)}</td>
        <td>${escH(lastTest.type || testStatus?.test_type || "—")}</td>
        <td style="color:${healthColor};font-weight:700">${escH(lastTest.status || healthLabel)}</td>
        <td>${attrs.length || "—"}</td>
      </tr>
    </table>
  </div>

  <div class="card">
    <div class="sec-title"><span>2</span> Disk Information</div>
    <div class="grid">
      <div class="kv"><span>Model</span><b>${escH(info.model)}</b></div>
      <div class="kv"><span>Serial Number</span><b>${escH(info.serial || "—")}</b></div>
      <div class="kv"><span>Capacity</span><b>${escH(info.size)}</b></div>
      <div class="kv"><span>Type</span><b>${escH(diskType)}</b></div>
      <div class="kv"><span>Current Temp</span><b>${temp != null ? `${temp}°C` : "—"}</b></div>
      <div class="kv"><span>Power On Time</span><b>${powerOnHours ? `${fmt(powerOnHours)}h` : "—"}</b></div>
      <div class="kv"><span>Power Cycles</span><b>${info.cycles != null ? escH(info.cycles) : "—"}</b></div>
      <div class="kv"><span>SMART Status</span><b style="color:${healthColor}">${escH(healthLabel.toLowerCase())}</b></div>
    </div>
    ${tempSvg}
  </div>

  ${isNvme || life != null || wear != null ? `
  <div class="card">
    <div class="sec-title"><span>3</span> ${isNvme ? "NVMe Wear &amp; Lifetime" : "Wear &amp; Lifetime"}</div>
    <div class="life">
      <div class="ring"><i><span style="font-size:22px">${life != null ? `${Math.round(life)}%` : "—"}</span><small>remaining</small></i></div>
      <div style="flex:1">
        <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:6px"><span>Percentage Used</span><b>${wear != null ? `${wear}%` : "—"}</b></div>
        <div style="height:8px;background:#e2e8f0;border-radius:999px;overflow:hidden;margin-bottom:12px"><div style="height:100%;width:${wear != null ? wear : 0}%;background:#2563eb"></div></div>
        <div class="grid" style="grid-template-columns:1fr 1fr">
          <div class="kv"><span>Est. Life</span><b>${escH(info.estLife || "—")}</b></div>
          <div class="kv"><span>Data Written</span><b>${info.dataWritten != null ? escH(fmtBytes(info.dataWritten)) : "—"}</b></div>
        </div>
      </div>
    </div>
  </div>` : ""}

  <div class="card">
    <div class="sec-title"><span>${isNvme || life != null ? "4" : "3"}</span> ${isNvme ? "NVMe Health Metrics" : "SMART Attributes"}</div>
    <table>
      <thead><tr><th>Metric</th><th>Value</th><th>Status</th></tr></thead>
      <tbody>${attrRows}</tbody>
    </table>
  </div>

  <div class="card">
    <div class="sec-title"><span>${isNvme || life != null ? "5" : "4"}</span> Last Self-Test Result</div>
    <table>
      <tr><th>Type</th><th>Result</th><th>When</th></tr>
      <tr>
        <td>${escH(lastTest.type || "—")}</td>
        <td>${escH(lastTest.status || testStatus?.result || "—")}</td>
        <td>${escH(opts.lastTestDate || lastTest.timestamp || "—")}</td>
      </tr>
    </table>
  </div>

  ${observations.length ? `
  <div class="card">
    <div class="sec-title"><span>${isNvme || life != null ? "6" : "5"}</span> Observations</div>
    <ul class="obs-list">
      ${observations.slice(0, 12).map((o) => formatSmartObservationHtml(o)).join("")}
    </ul>
  </div>` : ""}

  <div class="card">
    <div class="sec-title"><span>${observations.length ? (isNvme || life != null ? "7" : "6") : (isNvme || life != null ? "6" : "5")}</span> Recommendations</div>
    <div class="recs">
      ${recs.map(([c, t, d]) => `<div class="rec" style="--c:${c}"><h4>${escH(t)}</h4><p>${escH(d)}</p></div>`).join("")}
    </div>
  </div>

  <div class="footer">
    <div>Report generated by ProxMenux Monitor</div>
    <div>Opened from Homepage · ${escH(getPrxUrl(nodeCfg) || "")}</div>
  </div>
</div>
</body></html>`;

    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    if (targetWindow && !targetWindow.closed) {
      try { targetWindow.location.href = url; } catch { window.open(url, "_blank"); }
    } else {
      window.open(url, "_blank");
    }
  }

  function openDiskDetails(nodeCfg, devpath) {
    const disks = _nodeCache[nodeCfg.groupName]?.pveData?.disks || [];
    const disk = disks.find((d) => String(d.devpath) === String(devpath));
    if (!disk) return;

    closeDiskDetails();
    const backdrop = document.createElement("div");
    backdrop.className = "pve-disk-backdrop";
    const modal = document.createElement("div");
    modal.className = "pve-disk-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    _diskModal = backdrop;
    document.addEventListener("keydown", _diskEscHandler, true);

    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) closeDiskDetails();
    });

    renderDiskDetails(modal, nodeCfg, disk, "overview");
    // Overview needs ProxMenux SMART fields (temp / POH / cycles / data written)
    enrichDiskFromPrx(nodeCfg, disk).then(() => {
      if (!_diskModal || !document.body.contains(modal)) return;
      const pane = modal.__pveDiskCtx?.pane || "overview";
      if (pane === "overview" || pane === "smart") {
        renderDiskDetails(modal, nodeCfg, disk, pane);
      }
    });
  }

  function buildOverviewTab(ctx) {
    const {
      nodeCfg, hist,
      liveCpuPct, liveCpuColor, liveMemPct, liveMemColor, liveMemUsed, liveMemTotal,
      diskPct, diskColor, diskUsed, diskTotal,
      cpuTemp, loadDisplay, loadSub, loadBarColor,
      swapDisplay, swapSub, swapColor,
      procDisplay, procSub, procColor,
      rxBytes, txBytes, ioWaitPct, ioWaitColor,
      bupPct, bupColor, bupUsed, bupTotal,
      kernelVersion, hasKernelUpdate, updateCount, updateColor, updateLabel, updates,
      topProcs,
    } = ctx;

    const kpi = (label, valueHtml, sub = "") => `
      <div class="pve-ov-kpi">
        <div class="pve-ov-kpi-val">${valueHtml}</div>
        <div class="pve-ov-kpi-label">${escH(label)}</div>
        ${sub ? `<div class="pve-ov-kpi-sub">${sub}</div>` : ""}
      </div>`;

    const summary = `
      <div class="pve-ov-summary">
        ${kpi("CPU", `<span style="color:${liveCpuColor}">${liveCpuPct}%</span>`)}
        ${kpi("Memory", `<span style="color:${liveMemColor}">${liveMemPct}%</span>`)}
        ${kpi("Disk", `<span style="color:${diskColor}">${diskPct}%</span>`)}
        ${cpuTemp != null ? kpi("CPU Temp", `<span style="color:${tempColor(cpuTemp)}">${Math.round(cpuTemp)}°C</span>`) : ""}
        ${kpi("Load Avg", `<span style="color:${loadBarColor}">${escH(loadDisplay)}</span>`, loadSub ? escH(loadSub) : "")}
        ${kpi("Swap", `<span style="color:${swapColor}">${escH(swapDisplay)}</span>`, swapSub ? escH(swapSub) : "")}
        ${kpi("Processes", `<span style="color:${procColor}">${escH(procDisplay)}</span>`, procSub ? escH(procSub) : "")}
        ${kpi("Network", `
          <div class="pve-ov-kpi-net"><span class="is-rx">↓ ${escH(fmtBps(rxBytes))}</span><span class="is-tx">↑ ${escH(fmtBps(txBytes))}</span></div>`)}
        ${ioWaitPct != null ? kpi("IO Wait", `<span style="color:${ioWaitColor}">${ioWaitPct}%</span>`) : ""}
      </div>`;

    const metrics = `
      <section class="pve-ov-list-card">
        <div class="pve-ov-pane-hdr">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
          Live Metrics — Glances
        </div>
        <div class="pve-ov-metrics">
          <div class="pve-ov-metric">
            <div class="pve-ov-metric-hdr">
              <span>CPU</span>
              <b style="color:${liveCpuColor}">${liveCpuPct}%</b>
            </div>
            ${buildSparkline(hist.cpu, liveCpuColor)}
            <div class="pve-ov-track"><div class="pve-ov-track-fill" style="width:${liveCpuPct}%;background:${liveCpuColor}"></div></div>
          </div>
          <div class="pve-ov-metric">
            <div class="pve-ov-metric-hdr">
              <span>Memory</span>
              <b style="color:${liveMemColor}">${liveMemPct}%</b>
            </div>
            ${buildSparkline(hist.mem, liveMemColor)}
            <div class="pve-ov-track"><div class="pve-ov-track-fill" style="width:${liveMemPct}%;background:${liveMemColor}"></div></div>
            <div class="pve-ov-metric-sub">${escH(liveMemUsed)} / ${escH(liveMemTotal)}</div>
          </div>
          <div class="pve-ov-metric pve-ov-metric--wide">
            <div class="pve-ov-metric-hdr">
              <span>Network (${escH(nodeCfg.iface)})</span>
            </div>
            ${buildSparkline(hist.rx, "#6ee7b7")}
            <div class="pve-ov-net-chips">
              <span class="pve-ov-chip is-rx">↓ ${escH(fmtBps(rxBytes))}</span>
              <span class="pve-ov-chip is-tx">↑ ${escH(fmtBps(txBytes))}</span>
            </div>
          </div>
          <div class="pve-ov-metric">
            <div class="pve-ov-metric-hdr">
              <span>Disk (/)</span>
              <b style="color:${diskColor}">${diskPct}%</b>
            </div>
            <div class="pve-ov-track" style="margin-top:10px"><div class="pve-ov-track-fill" style="width:${diskPct}%;background:${diskColor}"></div></div>
            <div class="pve-ov-metric-sub">${escH(diskUsed)} / ${escH(diskTotal)}</div>
          </div>
          <div class="pve-ov-metric pve-ov-metric--wide">
            <div class="pve-ov-metric-hdr">
              <span>Backup (${escH(nodeCfg.backupMount)})</span>
              <b style="color:${bupColor}">${bupPct != null ? `${bupPct}%` : "—"}</b>
            </div>
            ${bupPct != null ? `
              <div class="pve-ov-track" style="margin-top:10px"><div class="pve-ov-track-fill" style="width:${bupPct}%;background:${bupColor}"></div></div>
              <div class="pve-ov-metric-sub">${escH(bupUsed)} / ${escH(bupTotal)}</div>
            ` : `<div class="pve-ov-metric-sub" style="margin-top:10px">Drive not mounted</div>`}
          </div>
          <div class="pve-ov-metric pve-ov-metric--system">
            <div class="pve-ov-metric-hdr">
              <span>System</span>
              <span class="pve-ov-update-badge" style="background:${escH(updateColor)}18;border-color:${escH(updateColor)}40;color:${escH(updateColor)}">
                ${updateCount === 0
                  ? `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`
                  : `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>`}
                ${escH(updateLabel)}
              </span>
            </div>
            <div class="pve-ov-system-body">
              <div class="pve-ov-system-kv">
                <span>Kernel</span>
                <b>${escH(kernelVersion)}${hasKernelUpdate ? ` <i class="pve-ov-kernel-tag">kernel update</i>` : ""}</b>
              </div>
              ${updateCount > 0 ? `
              <div class="pve-ov-pkg-col">
                <span>Pending packages</span>
                <div class="pve-ov-pkg-list">
                  ${updates.slice(0, 8).map((u) => {
                    const pkg = escH(u.Package || u.name || "unknown");
                    const newVer = escH(u.Version || u.NewVersion || "");
                    return `<div class="pve-ov-pkg-row"><span title="${pkg}">${pkg}</span>${newVer ? `<b>${newVer}</b>` : ""}</div>`;
                  }).join("")}
                  ${updateCount > 8 ? `<div class="pve-ov-pkg-more">+${updateCount - 8} more</div>` : ""}
                </div>
              </div>` : ""}
            </div>
          </div>
        </div>
      </section>`;

    const procs = topProcs.length ? `
      <section class="pve-ov-list-card">
        <div class="pve-ov-pane-hdr">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M16 18 22 12 16 6"/><path d="m8 6-6 6 6 6"/></svg>
          Top Processes
        </div>
        <div class="pve-ov-procs">
          <div class="pve-ov-proc-head"><span>Process</span><span>CPU</span><span>Mem</span></div>
          ${topProcs.map((p) => `
            <div class="pve-ov-proc-row">
              <span class="pve-ov-proc-name" title="${escH(p.name || p.cmdline || "")}">${escH(p.name || "?")}</span>
              <span class="pve-ov-proc-cpu">${(p.cpu_percent || 0).toFixed(1)}%</span>
              <span class="pve-ov-proc-mem">${(p.memory_percent || 0).toFixed(1)}%</span>
            </div>`).join("")}
        </div>
      </section>` : "";

    return `
      <div class="pve-overview-tab">
        ${summary}
        ${metrics}
        ${procs}
      </div>`;
  }

  function buildStorageTab(nodeCfg, pveData, glancesData) {
    const stores = (pveData?.storage || [])
      .filter((s) => s && s.storage)
      .slice()
      .sort((a, b) => String(a.storage).localeCompare(String(b.storage), undefined, { sensitivity: "base" }));
    const disks = (Array.isArray(pveData?.disks) ? pveData.disks : []).filter(isWholeDisk);
    const sub = _storageSubTabs[nodeCfg.groupName] || "pve";

    const localStores = stores.filter((s) => !isRemoteStorage(s));
    const remoteStores = stores.filter((s) => isRemoteStorage(s));

    const sum = (list, key) => list.reduce((acc, s) => acc + (Number(s[key]) || 0), 0);
    const localUsed = sum(localStores, "used");
    const localTotal = sum(localStores, "total");
    const localFree = Math.max(0, localTotal - localUsed) || sum(localStores, "avail");
    const remoteUsed = sum(remoteStores, "used");
    const remoteTotal = sum(remoteStores, "total");
    const allUsed = localUsed + remoteUsed;
    const allTotal = localTotal + remoteTotal;
    const allFree = Math.max(0, allTotal - allUsed);

    const localPct = localTotal > 0 ? (localUsed / localTotal) * 100 : 0;
    const localColor = pctColor(localPct);

    const usedShare = allTotal > 0 ? (localUsed / allTotal) * 100 : 0;
    const remoteShare = allTotal > 0 ? (remoteUsed / allTotal) * 100 : 0;
    const freeShare = allTotal > 0 ? (allFree / allTotal) * 100 : 0;

    const kindCounts = {};
    disks.forEach((d) => {
      const kind = classifyPhysicalDisk(d);
      kindCounts[kind] = (kindCounts[kind] || 0) + 1;
    });
    const diskEntries = Object.entries(kindCounts);
    const diskTotal = diskEntries.reduce((a, [, n]) => a + n, 0) || disks.length;
    const kindColor = { nvme: "#a78bfa", usb: "#fb923c", ssd: "#38bdf8", hdd: "#94a3b8", disk: "#64748b" };
    const diskBar = diskEntries.length
      ? diskEntries.map(([k, n]) => {
          const pct = diskTotal > 0 ? (n / diskTotal) * 100 : 0;
          return `<div class="pve-st-seg" style="width:${pct}%;background:${kindColor[k] || kindColor.disk}"></div>`;
        }).join("")
      : `<div class="pve-st-seg" style="width:100%;background:rgba(255,255,255,0.08)"></div>`;
    const diskLegend = diskEntries.length
      ? diskEntries.map(([k, n]) => `
          <span class="pve-st-legend-item">
            <i class="pve-st-dot" style="background:${kindColor[k] || kindColor.disk}"></i>
            ${n} ${escH(diskKindLabel(k))}
          </span>`).join("")
      : `<span class="pve-st-legend-item muted">No disks reported</span>`;

    const unhealthy = disks.filter((d) => {
      const h = String(d?.health || "").toUpperCase();
      return h && h !== "PASSED" && h !== "OK" && h !== "UNKNOWN";
    }).length;
    const healthPill = diskTotal
      ? (unhealthy
          ? `<span class="pve-st-health pve-st-health--warn">${unhealthy} issue${unhealthy === 1 ? "" : "s"}</span>`
          : `<span class="pve-st-health pve-st-health--ok">✔ all healthy</span>`)
      : "";

    const storeIcon = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/><path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/></svg>`;

    const storeRows = stores.map((s) => {
      const total = Number(s.total) || 0;
      const used = Number(s.used) || 0;
      const avail = Number(s.avail) || Math.max(0, total - used);
      const pct = total > 0 ? (used / total) * 100 : (Number(s.used_fraction) || 0) * 100;
      const active = s.active === 1 || s.active === true;
      const type = s.type || "unknown";
      const pctColorVal = pctColor(pct);
      return `
        <div class="pve-st-row">
          <div class="pve-st-row-top">
            <div class="pve-st-row-id">
              <span class="pve-st-row-ico">${storeIcon}</span>
              <span class="pve-st-name">${escH(s.storage)}</span>
              <span class="pve-st-type ${storageTypePillClass(type)}">${escH(type)}</span>
            </div>
            <div class="pve-st-row-meta">
              <span class="pve-st-active ${active ? "pve-st-active--on" : "pve-st-active--off"}">${active ? "active" : "inactive"}</span>
              <span class="pve-st-pct" style="color:${pctColorVal}">${pct.toFixed(2)}%</span>
            </div>
          </div>
          <div class="pve-st-track"><div class="pve-st-track-fill" style="width:${Math.min(100, pct)}%;background:#3b82f6"></div></div>
          <div class="pve-st-stats">
            <div class="pve-st-stat"><span>Total</span><b>${escH(fmtBytes(total))}</b></div>
            <div class="pve-st-stat"><span>Used</span><b class="pve-st-stat--used">${escH(fmtBytes(used))}</b></div>
            <div class="pve-st-stat"><span>Available</span><b class="pve-st-stat--free">${escH(fmtBytes(avail))}</b></div>
          </div>
        </div>`;
    }).join("");

    const remoteMounts = collectRemoteMounts(pveData, glancesData);
    const remoteRows = remoteMounts.map((m) => `
      <div class="pve-st-mount">
        <div class="pve-st-mount-main">
          <i class="pve-st-dot" style="background:${m.reachable ? "#6ee7b7" : "#f87171"}"></i>
          <div class="pve-st-mount-text">
            <div class="pve-st-mount-path">
              <span>${escH(m.path)}</span>
              <span class="pve-st-type pve-st-type--remote">${escH(m.type)}</span>
            </div>
            <div class="pve-st-mount-src">Source: ${escH(m.source)}</div>
          </div>
        </div>
        <span class="pve-st-active ${m.reachable ? "pve-st-active--on" : "pve-st-active--off"}">${m.reachable ? "reachable" : "unreachable"}</span>
      </div>`).join("");

    const physicalDisks = disks.filter((d) => !isUsbDisk(d));
    const externalDisks = disks.filter((d) => isUsbDisk(d));

    const subPanes = {
      pve: `
        <div class="pve-st-pane-hdr">${storeIcon} Proxmox Storage</div>
        <div class="pve-st-list">${storeRows || `<div class="pve-st-empty">No storage configured on this node</div>`}</div>`,
      remote: `
        <div class="pve-st-pane-hdr">
          ${storeIcon} Remote Mounts
          <span class="pve-st-count">${remoteMounts.length}</span>
        </div>
        <div class="pve-st-list pve-st-list--mounts">${remoteRows || `<div class="pve-st-empty">No remote mounts detected</div>`}</div>`,
      physical: `
        <div class="pve-st-pane-hdr">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 12h.01M10 12h.01"/></svg>
          Physical Disks &amp; SMART Status
        </div>
        <div class="pve-st-disk-grid-wrap">
          ${physicalDisks.map((d) => buildDiskCardHtml(d)).join("") || `<div class="pve-st-empty">No physical disks reported</div>`}
        </div>`,
      external: `
        <div class="pve-st-pane-hdr">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 12h8"/><path d="M12 8v8"/><rect x="14" y="6" width="7" height="12" rx="1"/></svg>
          External Storage (USB)
        </div>
        <div class="pve-st-disk-grid-wrap">
          ${externalDisks.map((d) => buildDiskCardHtml(d, { external: true })).join("") || `<div class="pve-st-empty">No USB storage detected</div>`}
        </div>`,
    };

    return `
      <div class="pve-storage-tab">
        <div class="pve-st-summary">
          <div class="pve-st-card">
            <div class="pve-st-card-hdr">
              <span>Storage Used</span>
              <span class="pve-st-card-badge">${storeIcon} ${stores.length} disk${stores.length === 1 ? "" : "s"}</span>
            </div>
            <div class="pve-st-card-big">${escH(fmtBytes(allUsed))}</div>
            <div class="pve-st-stack">${allTotal > 0 ? `
              <div class="pve-st-seg" style="width:${usedShare}%;background:#3b82f6"></div>
              <div class="pve-st-seg" style="width:${remoteShare}%;background:#2dd4bf"></div>
              <div class="pve-st-seg" style="width:${freeShare}%;background:rgba(148,163,184,0.35)"></div>
            ` : `<div class="pve-st-seg" style="width:100%;background:rgba(255,255,255,0.08)"></div>`}</div>
            <div class="pve-st-legend">
              <span class="pve-st-legend-item"><i class="pve-st-dot" style="background:#3b82f6"></i>Local ${escH(fmtBytes(localUsed))}</span>
              <span class="pve-st-legend-item"><i class="pve-st-dot" style="background:#2dd4bf"></i>Remote ${escH(fmtBytes(remoteUsed))}</span>
              <span class="pve-st-legend-item"><i class="pve-st-dot" style="background:rgba(148,163,184,0.55)"></i>Free ${escH(fmtBytes(allFree))}</span>
            </div>
          </div>

          <div class="pve-st-card pve-st-card--split">
            <div class="pve-st-card-hdr">
              <span>Local Used</span>
              ${storeIcon}
            </div>
            <div class="pve-st-card-body">
              ${ringGauge(localPct, localColor)}
              <div class="pve-st-card-stats">
                <div class="pve-st-mini"><span>Used</span><b style="color:#6ee7b7">${escH(fmtBytes(localUsed))}</b>${miniBar(localPct, "#6ee7b7")}</div>
                <div class="pve-st-mini"><span>Free</span><b style="color:#38bdf8">${escH(fmtBytes(localFree))}</b>${miniBar(localTotal > 0 ? (localFree / localTotal) * 100 : 0, "#38bdf8")}</div>
                <div class="pve-st-mini"><span>Total</span><b>${escH(fmtBytes(localTotal))}</b></div>
              </div>
            </div>
          </div>

          <div class="pve-st-card">
            <div class="pve-st-card-hdr">
              <span>Remote Used</span>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" opacity=".55"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>
            </div>
            ${remoteStores.length ? `
              <div class="pve-st-card-big">${escH(fmtBytes(remoteUsed))}</div>
              <div class="pve-st-card-sub">${remoteStores.length} remote · ${escH(fmtBytes(remoteTotal))} total</div>
            ` : `
              <div class="pve-st-card-big pve-st-card-big--muted">None</div>
              <div class="pve-st-card-sub">No remote storage</div>
            `}
          </div>

          <div class="pve-st-card">
            <div class="pve-st-card-hdr">
              <span>Physical Disks</span>
              ${healthPill}
            </div>
            <div class="pve-st-card-big">${diskTotal} disk${diskTotal === 1 ? "" : "s"}</div>
            <div class="pve-st-stack">${diskBar}</div>
            <div class="pve-st-legend">${diskLegend}</div>
          </div>
        </div>

        <section class="pve-st-list-card">
          <div class="pve-st-subtabs" role="tablist" aria-label="Storage details">
            <button type="button" class="pve-st-subtab ${sub === "pve" ? "pve-st-subtab--active" : ""}" data-st-sub="pve">Proxmox Storage</button>
            <button type="button" class="pve-st-subtab ${sub === "remote" ? "pve-st-subtab--active" : ""}" data-st-sub="remote">Remote Mounts</button>
            <button type="button" class="pve-st-subtab ${sub === "physical" ? "pve-st-subtab--active" : ""}" data-st-sub="physical">Physical Disks</button>
            <button type="button" class="pve-st-subtab ${sub === "external" ? "pve-st-subtab--active" : ""}" data-st-sub="external">External Storage</button>
          </div>
          <div class="pve-st-subpane">
            ${subPanes[sub] || subPanes.pve}
          </div>
        </section>
      </div>`;
  }

  function buildNetworkTab(nodeCfg, pveData, glancesData, rrdData) {
    const glNet = Array.isArray(glancesData?.network) ? glancesData.network : [];
    const bridge = glNet.find(n => n.interface_name === (nodeCfg.iface || "vmbr0"));
    const rx = bridge?.bytes_recv_rate_per_sec ?? 0;
    const tx = bridge?.bytes_sent_rate_per_sec ?? 0;
    const sub = _networkSubTabs[nodeCfg.groupName] || "flow";

    return `
      <div class="pve-network-tab">
        <section class="pve-net-card">
          <div class="pve-net-card-hdr">
            <div class="pve-net-card-title">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>
              </svg>
              Network Traffic
            </div>
            <div class="pve-net-legend">
              <span class="pve-net-legend-item"><i class="pve-net-swatch pve-net-swatch--rx"></i>Received</span>
              <span class="pve-net-legend-item"><i class="pve-net-swatch pve-net-swatch--tx"></i>Sent</span>
            </div>
            <div class="pve-net-live">
              <span class="pve-net-chip pve-net-chip--rx">↓ ${escH(fmtBps(rx))}</span>
              <span class="pve-net-chip pve-net-chip--tx">↑ ${escH(fmtBps(tx))}</span>
            </div>
          </div>
          <div class="pve-net-card-body">
            ${buildTrafficChart(rrdData)}
          </div>
        </section>

        <section class="pve-net-card pve-net-card--flow-ifaces">
          <div class="pve-net-subtabs" role="tablist" aria-label="Network views">
            <button type="button" class="pve-net-subtab ${sub === "flow" ? "pve-net-subtab--active" : ""}" data-net-sub="flow" role="tab" aria-selected="${sub === "flow"}">
              Network Flow <span class="pve-net-poc-tag">PoC</span>
            </button>
            <button type="button" class="pve-net-subtab ${sub === "ifaces" ? "pve-net-subtab--active" : ""}" data-net-sub="ifaces" role="tab" aria-selected="${sub === "ifaces"}">
              Interfaces
            </button>
          </div>
          <div class="pve-net-card-body ${sub === "flow" ? "pve-net-card-body--flow" : "pve-net-card-body--ifaces"}">
            ${sub === "flow"
              ? buildNetworkFlow(nodeCfg, pveData, glancesData)
              : buildNetworkInterfaces(nodeCfg, glancesData)}
          </div>
        </section>
      </div>`;
  }

  function ifacePrimaryIp(iface) {
    const addrs = Array.isArray(iface?.addresses) ? iface.addresses : [];
    const pick = addrs.find((a) => {
      const s = typeof a === "string" ? a : (a?.address || a?.ip || "");
      return s && !String(s).includes(":");
    }) || addrs[0];
    if (!pick) return "—";
    if (typeof pick === "string") return pick.replace(/\/\d+$/, "");
    return String(pick.address || pick.ip || "—").replace(/\/\d+$/, "");
  }

  function collectIfaceCards(nodeCfg, glancesData) {
    const glNet = Array.isArray(glancesData?.network) ? glancesData.network : [];
    const prx = _prxNetCache[nodeCfg.groupName]?.data || null;

    const physical = [];
    const bridges = [];

    if (Array.isArray(prx?.physical_interfaces) && prx.physical_interfaces.length) {
      prx.physical_interfaces.forEach((raw, idx) => {
        if (!raw?.name) return;
        let iface = { ...raw, type: raw.type || "physical" };
        iface = enrichIfaceFromGlances(iface, glNet, iface.name);
        const rx = Number(iface.bytes_recv_rate_per_sec) || Number(glNet.find(n => n.interface_name === iface.name)?.bytes_recv_rate_per_sec) || 0;
        const tx = Number(iface.bytes_sent_rate_per_sec) || Number(glNet.find(n => n.interface_name === iface.name)?.bytes_sent_rate_per_sec) || 0;
        const speed = Number(iface.speed) || glancesSpeedToMbps(glNet.find(n => n.interface_name === iface.name)?.speed) || 0;
        const up = /up/i.test(String(iface.status || "")) || speed > 0 || (rx + tx) > 0;
        physical.push({
          name: iface.name || `nic${idx}`,
          kind: "nic",
          typeLabel: "Physical",
          up,
          status: up ? "UP" : "DOWN",
          duplex: capitalizeWord(iface.duplex || "unknown"),
          speed,
          mtu: iface.mtu ?? "—",
          rx, tx,
          drops: (Number(iface.drops_in) || 0) + (Number(iface.drops_out) || 0),
          mac: iface.mac_address || iface.mac || "—",
          ip: ifacePrimaryIp(iface),
        });
      });
    } else {
      glNet.filter((n) => isPhysicalIface(n.interface_name)).forEach((n, idx) => {
        const rx = n.bytes_recv_rate_per_sec || 0;
        const tx = n.bytes_sent_rate_per_sec || 0;
        const speed = glancesSpeedToMbps(n.speed);
        const up = n.isup === true || speed > 0 || (rx + tx) > 0;
        physical.push({
          name: n.interface_name || `nic${idx}`,
          kind: "nic",
          typeLabel: "Physical",
          up,
          status: up ? "UP" : "DOWN",
          duplex: capitalizeWord(n.duplex || "unknown"),
          speed,
          mtu: n.mtu ?? "—",
          rx, tx,
          drops: (Number(n.dropin) || Number(n.dropout) || 0),
          mac: n.mac || n.macaddress || n.hwaddr || "—",
          ip: "—",
        });
      });
    }

    if (Array.isArray(prx?.bridge_interfaces) && prx.bridge_interfaces.length) {
      prx.bridge_interfaces.forEach((raw) => {
        if (!raw?.name) return;
        let iface = { ...raw, type: raw.type || "bridge" };
        iface = enrichIfaceFromGlances(iface, glNet, iface.name);
        const g = glNet.find(n => n.interface_name === iface.name);
        const rx = Number(iface.bytes_recv_rate_per_sec) || Number(g?.bytes_recv_rate_per_sec) || 0;
        const tx = Number(iface.bytes_sent_rate_per_sec) || Number(g?.bytes_sent_rate_per_sec) || 0;
        const speed = Number(iface.speed) || glancesSpeedToMbps(g?.speed) || 0;
        const up = /up/i.test(String(iface.status || "")) || speed > 0 || (rx + tx) > 0
          || String(iface.name) === String(nodeCfg.iface || "vmbr0");
        bridges.push({
          name: iface.name,
          kind: "bridge",
          typeLabel: "Bridge",
          up,
          status: up ? "UP" : "DOWN",
          duplex: capitalizeWord(iface.duplex || "unknown"),
          speed,
          mtu: iface.mtu ?? "—",
          rx, tx,
          drops: (Number(iface.drops_in) || 0) + (Number(iface.drops_out) || 0),
          mac: iface.mac_address || iface.mac || "—",
          ip: ifacePrimaryIp(iface),
        });
      });
    } else {
      glNet.filter((n) => isBridgeIface(n.interface_name)).forEach((n) => {
        const rx = n.bytes_recv_rate_per_sec || 0;
        const tx = n.bytes_sent_rate_per_sec || 0;
        const speed = glancesSpeedToMbps(n.speed);
        bridges.push({
          name: n.interface_name,
          kind: "bridge",
          typeLabel: "Bridge",
          up: true,
          status: "UP",
          duplex: capitalizeWord(n.duplex || "unknown"),
          speed,
          mtu: n.mtu ?? "—",
          rx, tx,
          drops: 0,
          mac: n.mac || n.macaddress || n.hwaddr || "—",
          ip: "—",
        });
      });
    }

    physical.sort((a, b) => Number(b.up) - Number(a.up) || String(a.name).localeCompare(String(b.name)));
    bridges.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return { physical, bridges };
  }

  function buildNetworkInterfaces(nodeCfg, glancesData) {
    const { physical, bridges } = collectIfaceCards(nodeCfg, glancesData);
    const physActive = physical.filter((p) => p.up).length;
    const brActive = bridges.filter((b) => b.up).length;

    const bolt = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg>`;
    const arrow = `<svg class="pve-ni-card-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>`;
    const routerIco = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="20" height="8" x="2" y="14" rx="2"/><path d="M6.01 18H6"/><path d="M10.01 18H10"/><path d="M15 10v4"/><path d="M17.84 7.17a4 4 0 0 0-5.66 0"/><path d="M20.66 4.34a8 8 0 0 0-11.31 0"/></svg>`;
    const bridgeIco = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/></svg>`;

    const physCards = physical.length
      ? physical.map((p) => {
          const dropsHtml = p.drops > 0
            ? `<div class="pve-ni-stat pve-ni-stat--drops"><span class="pve-ni-stat-k">Drops</span><span class="pve-ni-stat-v"><i class="pve-ni-dot pve-ni-dot--red"></i>${escH(fmtCount(p.drops))}</span></div>`
            : "";
          return `
            <button type="button" class="pve-ni-card pve-ni-card--physical ${p.up ? "" : "pve-ni-card--down"}"
              data-iface-open data-kind="nic" data-iface="${escH(p.name)}">
              <div class="pve-ni-card-top">
                <div class="pve-ni-card-id">
                  <span class="pve-ni-name">${escH(p.name)}</span>
                  ${ifaceBadge("Physical", "blue")}
                </div>
                <div class="pve-ni-card-status">
                  <span class="pve-ni-status ${p.up ? "is-up" : "is-down"}"><i class="pve-ni-dot"></i>${escH(p.status)}</span>
                  <span class="pve-ni-duplex">${escH(p.duplex)}</span>
                </div>
              </div>
              <div class="pve-ni-card-grid">
                <div class="pve-ni-stat"><span class="pve-ni-stat-k">Speed</span><span class="pve-ni-stat-v pve-ni-stat-v--speed">${bolt}${escH(p.speed > 0 ? fmtIfaceSpeed(p.speed) : "N/A")}</span></div>
                <div class="pve-ni-stat"><span class="pve-ni-stat-k">MTU</span><span class="pve-ni-stat-v">${escH(String(p.mtu))}</span></div>
                <div class="pve-ni-stat"><span class="pve-ni-stat-k">Received</span><span class="pve-ni-stat-v is-rx">${escH(fmtRateBytes(p.rx))}</span></div>
                <div class="pve-ni-stat"><span class="pve-ni-stat-k">Sent</span><span class="pve-ni-stat-v is-tx">${escH(fmtRateBytes(p.tx))}</span></div>
                ${dropsHtml}
              </div>
              <div class="pve-ni-card-foot">
                <span class="pve-ni-mac">${escH(p.mac)}</span>
                ${arrow}
              </div>
            </button>`;
        }).join("")
      : `<div class="pve-net-empty">No physical interfaces found.</div>`;

    const bridgeCards = bridges.length
      ? bridges.map((b) => `
          <button type="button" class="pve-ni-card pve-ni-card--bridge ${b.up ? "" : "pve-ni-card--down"}"
            data-iface-open data-kind="bridge" data-iface="${escH(b.name)}">
            <div class="pve-ni-card-top">
              <div class="pve-ni-card-id">
                <span class="pve-ni-name">${escH(b.name)}</span>
                ${ifaceBadge("Bridge", "green")}
              </div>
              <span class="pve-ni-status ${b.up ? "is-up" : "is-down"}"><i class="pve-ni-dot"></i>${escH(b.status)}</span>
            </div>
            <div class="pve-ni-card-row">
              <div class="pve-ni-stat"><span class="pve-ni-stat-k">IP Address</span><span class="pve-ni-stat-v pve-ni-stat-v--mono">${escH(b.ip)}</span></div>
              <div class="pve-ni-stat"><span class="pve-ni-stat-k">Speed</span><span class="pve-ni-stat-v pve-ni-stat-v--speed">${bolt}${escH(b.speed > 0 ? fmtIfaceSpeed(b.speed) : "N/A")}</span></div>
              <div class="pve-ni-stat"><span class="pve-ni-stat-k">Duplex</span><span class="pve-ni-stat-v">${escH(b.duplex)}</span></div>
              <div class="pve-ni-stat"><span class="pve-ni-stat-k">MTU</span><span class="pve-ni-stat-v">${escH(String(b.mtu))}</span></div>
            </div>
            <div class="pve-ni-card-foot">
              <span class="pve-ni-mac">${escH(b.mac)}</span>
              ${arrow}
            </div>
          </button>`).join("")
      : `<div class="pve-net-empty">No bridge interfaces found.</div>`;

    return `
      <div class="pve-ni-wrap">
        <section class="pve-ni-section">
          <div class="pve-ni-section-hdr">
            <div class="pve-ni-section-title">${routerIco}<span>Physical Interfaces</span></div>
            <span class="pve-ni-count-badge pve-ni-count-badge--blue">${physActive}/${physical.length || 0} Active</span>
          </div>
          <div class="pve-ni-grid">${physCards}</div>
        </section>
        <section class="pve-ni-section">
          <div class="pve-ni-section-hdr">
            <div class="pve-ni-section-title">${bridgeIco}<span>Bridge Interfaces</span></div>
            <span class="pve-ni-count-badge pve-ni-count-badge--green">${brActive}/${bridges.length || 0} Active</span>
          </div>
          <div class="pve-ni-bridge-list">${bridgeCards}</div>
        </section>
      </div>`;
  }



  // ── Hardware tab ────────────────────────────────────────────────────
  function fmtMemModuleSize(raw) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return "—";
    // ProxMenux reports KiB for DIMM size (e.g. 33554432 → 32.0 GB)
    const gb = n / (1024 * 1024);
    if (gb >= 1) return `${gb.toFixed(1)} GB`;
    const mb = n / 1024;
    if (mb >= 1) return `${mb.toFixed(0)} MB`;
    return `${Math.round(n)} KiB`;
  }

  function thermalCategory(t) {
    const name = String(t?.name || "");
    const low = name.toLowerCase();
    if (/\bgpu\b|amdgpu|radeon|nvidia|edge/i.test(name) || low.includes("gpu")) return "GPU";
    if (/nvme|ssd/i.test(name) && /nvme|ssd/i.test(name)) {
      if (/nvme/i.test(name)) return "NVME";
    }
    if (/nvme/i.test(name)) return "NVME";
    if (/pci\s*device|^sensor\s*\d/i.test(name) || low.startsWith("pci")) return "PCI";
    return "OTHER";
  }

  function thermalBarPct(t) {
    const cur = Number(t?.current);
    if (!Number.isFinite(cur) || cur < 0) return 0;
    let ceil = Number(t?.high);
    if (!Number.isFinite(ceil) || ceil <= 0 || ceil > 200) ceil = Number(t?.critical);
    if (!Number.isFinite(ceil) || ceil <= 0 || ceil > 200) ceil = 100;
    return Math.max(0, Math.min(100, Math.round((cur / ceil) * 100)));
  }

  function pciTypeBadgeClass(type) {
    const t = String(type || "").toLowerCase();
    if (t.includes("graphics") || t.includes("vga") || t.includes("display")) return "pve-hw-pci-badge--gfx";
    if (t.includes("audio")) return "pve-hw-pci-badge--audio";
    if (t.includes("usb")) return "pve-hw-pci-badge--usb";
    if (t.includes("storage") || t.includes("sata") || t.includes("nvme") || t.includes("raid")) return "pve-hw-pci-badge--storage";
    if (t.includes("network") || t.includes("ethernet") || t.includes("wireless")) return "pve-hw-pci-badge--net";
    return "pve-hw-pci-badge--other";
  }

  function hwChipIco() {
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M15 2v2M9 2v2M15 20v2M9 20v2M2 15h2M2 9h2M20 15h2M20 9h2"/></svg>`;
  }
  function hwMemIco() {
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10v4M10 10v4M14 10v4M18 10v4"/></svg>`;
  }
  function hwThermIco() {
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z"/></svg>`;
  }
  function hwCpuMiniIco() {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M15 2v2M9 2v2M15 20v2M9 20v2M2 15h2M2 9h2M20 15h2M20 9h2"/></svg>`;
  }

  function buildSystemInfoCard(hw) {
    const cpu = hw?.cpu || {};
    const mb = hw?.motherboard || {};
    const bios = mb.bios || hw?.bios || {};
    const sockets = Number(cpu.sockets) || 1;
    const cps = Number(cpu.cores_per_socket) || 0;
    const totalCores = sockets * cps;
    const coresLabel = cps
      ? `${sockets} × ${cps} = ${totalCores} core${totalCores === 1 ? "" : "s"}`
      : "—";
    const kv = (label, value) => `
      <div class="pve-hw-kv">
        <span class="pve-hw-k">${escH(label)}</span>
        <span class="pve-hw-v">${value}</span>
      </div>`;

    return `
      <section class="pve-hw-card">
        <div class="pve-hw-card-hdr">
          <div class="pve-hw-card-title">${hwChipIco()}<span>System Information</span></div>
        </div>
        <div class="pve-hw-sys-grid">
          <div class="pve-hw-sys-col">
            <div class="pve-hw-sys-col-title">${hwCpuMiniIco()}<span>CPU</span></div>
            ${kv("Model", escH(cpu.model || "—"))}
            ${kv("Cores", escH(coresLabel))}
            ${kv("Threads", escH(cpu.total_threads != null ? String(cpu.total_threads) : "—"))}
            ${kv("Virtualization", escH(cpu.virtualization || "—"))}
          </div>
          <div class="pve-hw-sys-col">
            <div class="pve-hw-sys-col-title">${hwCpuMiniIco()}<span>Motherboard</span></div>
            ${kv("Manufacturer", escH(mb.manufacturer || "—"))}
            ${kv("Model", escH(mb.model || "—"))}
            ${kv("BIOS", escH(bios.vendor || mb.manufacturer || "—"))}
            ${kv("Version", escH(bios.version || "—"))}
            ${kv("Date", escH(bios.date || "—"))}
          </div>
        </div>
      </section>`;
  }

  function buildMemoryModulesCard(hw) {
    const mods = Array.isArray(hw?.memory_modules) ? hw.memory_modules : [];
    const cards = mods.length
      ? mods.map((m, i) => `
          <div class="pve-hw-dimm">
            <div class="pve-hw-dimm-slot">${escH(m.slot || `DIMM ${i + 1}`)}</div>
            <div class="pve-hw-dimm-size">${escH(fmtMemModuleSize(m.size))}</div>
            <div class="pve-hw-dimm-meta">
              <div><span class="pve-hw-k">Type</span><span class="pve-hw-v">${escH(m.type || "—")}</span></div>
              <div><span class="pve-hw-k">Speed</span><span class="pve-hw-v">${escH(m.configured_speed || m.max_speed || "—")}</span></div>
              <div><span class="pve-hw-k">Manufacturer</span><span class="pve-hw-v">${escH(m.manufacturer || "—")}</span></div>
            </div>
          </div>`).join("")
      : `<div class="pve-hw-empty">No memory modules reported.</div>`;

    return `
      <section class="pve-hw-card">
        <div class="pve-hw-card-hdr">
          <div class="pve-hw-card-title">${hwMemIco()}<span>Memory Modules</span></div>
          <span class="pve-hw-count-badge">${mods.length} installed</span>
        </div>
        <div class="pve-hw-dimm-grid">${cards}</div>
      </section>`;
  }

  function buildThermalPane(hw) {
    const temps = Array.isArray(hw?.temperatures) ? hw.temperatures : [];
    const order = ["GPU", "NVME", "PCI", "OTHER"];
    const groups = {};
    order.forEach((k) => { groups[k] = []; });
    temps.forEach((t) => {
      const cat = thermalCategory(t);
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(t);
    });
    const sections = order.filter((k) => groups[k]?.length).map((cat) => {
      const items = groups[cat].map((t) => {
        const pct = thermalBarPct(t);
        const cur = Number(t.current);
        const tempStr = Number.isFinite(cur) ? `${cur.toFixed(1)}°C` : "—";
        return `
          <div class="pve-hw-therm-item">
            <div class="pve-hw-therm-top">
              <span class="pve-hw-therm-name">${escH(t.name || "Sensor")}</span>
              <span class="pve-hw-therm-temp">${escH(tempStr)}</span>
            </div>
            <div class="pve-hw-therm-bar"><i style="width:${pct}%"></i></div>
            <div class="pve-hw-therm-adapter">${escH(t.adapter || "")}</div>
          </div>`;
      }).join("");
      return `
        <div class="pve-hw-therm-group">
          <div class="pve-hw-therm-group-hdr">
            <span class="pve-hw-therm-group-title">${escH(cat)}</span>
            <span class="pve-hw-therm-group-count">${groups[cat].length}</span>
          </div>
          <div class="pve-hw-therm-list">${items}</div>
        </div>`;
    }).join("");

    return `
      <section class="pve-hw-card">
        <div class="pve-hw-card-hdr">
          <div class="pve-hw-card-title">${hwThermIco()}<span>Thermal Monitoring</span></div>
          <span class="pve-hw-count-badge">${temps.length} sensor${temps.length === 1 ? "" : "s"}</span>
        </div>
        <div class="pve-hw-therm-grid">
          ${sections || `<div class="pve-hw-empty">No temperature sensors found.</div>`}
        </div>
      </section>`;
  }

  function gpuActualMode(gpu) {
    const role = String(gpu?.sriov_role || "");
    if (role === "vf" || role === "pf-active") return "sriov";
    const driver = String(gpu?.pci_driver || "").toLowerCase();
    const mod = String(gpu?.pci_kernel_module || "").toLowerCase();
    if (driver === "vfio-pci" || driver.includes("vfio")) return "vm";
    const native = /^(nvidia|amdgpu|radeon|i915|xe|nouveau|mgag200)$/;
    if (native.test(driver) || (driver && driver !== "none")) return "lxc";
    if (mod.includes("vfio")) return "vm";
    if (/nvidia|amdgpu|radeon|i915|xe|nouveau|mgag200/.test(mod) || (mod && mod !== "none")) return "lxc";
    return "unknown";
  }

  function gpuSwitchUi(groupName) {
    if (!_gpuSwitchUi[groupName]) _gpuSwitchUi[groupName] = { editingSlot: null, pending: {} };
    return _gpuSwitchUi[groupName];
  }

  function gpuModeStatus(mode) {
    if (mode === "sriov") return { primary: "SR-IOV active", secondary: "Virtual Functions managed externally", accent: "teal" };
    if (mode === "vm") return { primary: "Ready for VM passthrough", secondary: "VFIO-PCI driver active", accent: "purple" };
    if (mode === "lxc") return { primary: "Ready for LXC containers", secondary: "Native driver active", accent: "blue" };
    return { primary: "Mode unknown", secondary: "No driver detected", accent: "muted" };
  }

  /** ProxMenux-style GPU ↔ LXC/VM switch diagram (viewBox 220×100). */
  function gpuSwitchDiagramSvg(display, editing, slot) {
    const isLxc = display === "lxc";
    const isVm = display === "vm";
    const isSriov = display === "sriov";
    const active = isSriov ? "#14b8a6" : isLxc ? "#3b82f6" : isVm ? "#a855f7" : "#6b7280";
    const inactive = "#374151";
    const hub = editing ? "#f59e0b" : active;
    const hubFill = editing ? "#f59e0b20" : `${active}20`;
    const lxcC = isLxc ? "#3b82f6" : inactive;
    const vmC = isVm ? "#a855f7" : inactive;
    const lxcFill = isLxc ? "#3b82f625" : "transparent";
    const vmStroke = isVm ? "#a855f7" : inactive;
    const vmFill = isVm ? "#a855f710" : "#37415110";
    const lxcW = isLxc ? "3.5" : "2";
    const vmW = isVm ? "3.5" : "2";
    const lxcLabelSize = isLxc ? "14" : "12";
    const vmLabelSize = isVm ? "14" : "12";
    const lxcWeight = isLxc ? "bold" : "500";
    const vmWeight = isVm ? "bold" : "500";
    const hubCursor = editing ? "pointer" : "default";

    return `
      <svg viewBox="0 0 220 100" class="pve-hw-gpu-svg" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <g transform="translate(0, 22)">
          <rect x="4" y="8" width="44" height="36" rx="6" fill="${active}20" stroke="${active}" stroke-width="2.5"></rect>
          <line x1="14" y1="2" x2="14" y2="8" stroke="${active}" stroke-width="2.5" stroke-linecap="round"></line>
          <line x1="26" y1="2" x2="26" y2="8" stroke="${active}" stroke-width="2.5" stroke-linecap="round"></line>
          <line x1="38" y1="2" x2="38" y2="8" stroke="${active}" stroke-width="2.5" stroke-linecap="round"></line>
          <line x1="14" y1="44" x2="14" y2="50" stroke="${active}" stroke-width="2.5" stroke-linecap="round"></line>
          <line x1="26" y1="44" x2="26" y2="50" stroke="${active}" stroke-width="2.5" stroke-linecap="round"></line>
          <line x1="38" y1="44" x2="38" y2="50" stroke="${active}" stroke-width="2.5" stroke-linecap="round"></line>
          <text x="26" y="32" text-anchor="middle" fill="${active}" style="font:700 14px system-ui,sans-serif">GPU</text>
        </g>
        <line x1="52" y1="50" x2="78" y2="50" stroke="${active}" stroke-width="3" stroke-linecap="round"></line>
        <g class="pve-hw-gpu-hub-hit" data-gpu-sw-hub="${escH(slot)}" style="cursor:${hubCursor}">
          <circle cx="95" cy="50" r="18" fill="transparent"></circle>
          <circle cx="95" cy="50" r="14" fill="${hubFill}" stroke="${hub}" stroke-width="3"></circle>
          <circle cx="95" cy="50" r="6" fill="${hub}"></circle>
        </g>
        <path d="M 109 42 L 135 20" fill="none" stroke="${lxcC}" stroke-width="${lxcW}" stroke-linecap="round"></path>
        <path d="M 109 58 L 135 80" fill="none" stroke="${vmC}" stroke-width="${vmW}" stroke-linecap="round"></path>
        <g transform="translate(138, 2)">
          <rect x="0" y="0" width="32" height="28" rx="4" fill="${lxcFill}" stroke="${lxcC}" stroke-width="${isLxc ? "2.5" : "1.5"}"></rect>
          <line x1="0" y1="10" x2="32" y2="10" stroke="${lxcC}" stroke-width="1.5"></line>
          <line x1="0" y1="19" x2="32" y2="19" stroke="${lxcC}" stroke-width="1.5"></line>
          <circle cx="7" cy="5" r="2" fill="${lxcC}"></circle>
          <circle cx="7" cy="14.5" r="2" fill="${lxcC}"></circle>
          <circle cx="7" cy="23.5" r="2" fill="${lxcC}"></circle>
        </g>
        <text x="188" y="22" text-anchor="start" fill="${lxcC}" style="font:${lxcWeight} ${lxcLabelSize}px system-ui,sans-serif">LXC</text>
        <g transform="translate(138, 65)">
          <rect x="2" y="0" width="28" height="18" rx="3" fill="transparent" stroke="${vmStroke}" stroke-width="${isVm ? "2.5" : "1.5"}"></rect>
          <rect x="5" y="3" width="22" height="12" rx="1" fill="${vmFill}"></rect>
          <line x1="16" y1="18" x2="16" y2="24" stroke="${vmStroke}" stroke-width="1.5" stroke-linecap="round"></line>
          <line x1="8" y1="24" x2="24" y2="24" stroke="${vmStroke}" stroke-width="1.5" stroke-linecap="round"></line>
        </g>
        <text x="188" y="84" text-anchor="start" fill="${vmC}" style="font:${vmWeight} ${vmLabelSize}px system-ui,sans-serif">VM</text>
      </svg>`;
  }

  function gpuSwitchModeHtml(nodeCfg, gpu) {
    const slot = String(gpu?.slot || "");
    const actual = gpuActualMode(gpu);
    const ui = gpuSwitchUi(nodeCfg.groupName);
    const editing = ui.editingSlot === slot && actual !== "sriov";
    const pending = ui.pending[slot] || null;
    const display = pending || actual;
    const status = gpuModeStatus(display);
    const pendingChange = editing && pending && pending !== actual;
    const accentCls = status.accent === "purple" ? "is-vm"
      : status.accent === "blue" ? "is-lxc"
      : status.accent === "teal" ? "is-sriov"
      : "is-unknown";

    const settingsIco = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/></svg>`;
    const checkIco = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;

    const actions = actual === "sriov" ? "" : (editing
      ? `<div class="pve-hw-gpu-switch-actions">
           <button type="button" class="pve-hw-gpu-sw-btn pve-hw-gpu-sw-btn--ghost" data-gpu-sw-cancel="${escH(slot)}">Cancel</button>
           <button type="button" class="pve-hw-gpu-sw-btn pve-hw-gpu-sw-btn--save" data-gpu-sw-save="${escH(slot)}">${checkIco}Save</button>
         </div>`
      : `<div class="pve-hw-gpu-switch-actions">
           <button type="button" class="pve-hw-gpu-sw-btn pve-hw-gpu-sw-btn--ghost" data-gpu-sw-edit="${escH(slot)}">${settingsIco}Edit</button>
         </div>`);

    return `
      <div class="pve-hw-gpu-switch ${editing ? "is-editing" : ""} ${accentCls}" data-gpu-switch="${escH(slot)}">
        <div class="pve-hw-gpu-switch-hdr">
          <span class="pve-hw-gpu-switch-label">Switch Mode</span>
          ${actions}
        </div>
        <div class="pve-hw-gpu-switch-body">
          ${gpuSwitchDiagramSvg(display, editing, slot)}
          <div class="pve-hw-gpu-switch-status">
            <div class="pve-hw-gpu-switch-primary">${escH(status.primary)}</div>
            <div class="pve-hw-gpu-switch-secondary">${escH(status.secondary)}</div>
            ${pendingChange ? `<div class="pve-hw-gpu-switch-pending">Change pending...</div>` : ""}
          </div>
        </div>
      </div>`;
  }

  function buildGraphicsPane(nodeCfg, hw) {
    const gpus = Array.isArray(hw?.gpus) ? hw.gpus : [];
    const cards = gpus.length
      ? gpus.map((g) => {
          const vendor = String(g.vendor || "").toUpperCase() || "GPU";
          const slot = String(g.slot || "");
          return `
            <div class="pve-hw-gpu-card" data-gpu-card="${escH(slot)}">
              <button type="button" class="pve-hw-gpu-card-main" data-gpu-slot="${escH(slot)}" data-gpu-name="${escH(g.name || "")}">
                <div class="pve-hw-gpu-name-row">
                  <span class="pve-hw-gpu-name">${escH(g.name || "Graphics device")}</span>
                  <span class="pve-hw-vendor-pill">${escH(vendor)}</span>
                </div>
                <div class="pve-hw-gpu-props">
                  <div class="pve-hw-gpu-prop"><span class="pve-hw-k">Type</span><span class="pve-hw-v">${escH(g.type || "PCI")}</span></div>
                  <div class="pve-hw-gpu-prop"><span class="pve-hw-k">PCI Slot</span><span class="pve-hw-v pve-hw-mono">${escH(slot || "—")}</span></div>
                  <div class="pve-hw-gpu-prop"><span class="pve-hw-k">Driver</span><span class="pve-hw-v pve-hw-mono pve-hw-v--ok">${escH(g.pci_driver || "—")}</span></div>
                  <div class="pve-hw-gpu-prop"><span class="pve-hw-k">Kernel Module</span><span class="pve-hw-v pve-hw-mono">${escH(g.pci_kernel_module || "—")}</span></div>
                </div>
              </button>
              ${gpuSwitchModeHtml(nodeCfg, g)}
            </div>`;
        }).join("")
      : `<div class="pve-hw-empty">No graphics cards detected.</div>`;

    return `
      <section class="pve-hw-card pve-hw-card--graphics">
        <div class="pve-hw-card-hdr">
          <div class="pve-hw-card-title">${hwChipIco()}<span>Graphics Cards</span></div>
          <span class="pve-hw-count-badge">${gpus.length} GPU${gpus.length === 1 ? "" : "s"}</span>
        </div>
        <div class="pve-hw-gpu-list">${cards}</div>
      </section>`;
  }

  function buildPciPane(hw) {
    const devices = Array.isArray(hw?.pci_devices) ? hw.pci_devices : [];
    const cards = devices.length
      ? devices.map((d) => `
          <button type="button" class="pve-hw-pci-card" data-pci-slot="${escH(d.slot || "")}">
            <div class="pve-hw-pci-top">
              <span class="pve-hw-pci-badge ${pciTypeBadgeClass(d.type)}">${escH(d.type || "PCI")}</span>
              <span class="pve-hw-pci-slot">${escH(d.slot || "")}</span>
            </div>
            <div class="pve-hw-pci-name">${escH(d.device || d.sdevice || "PCI Device")}</div>
            <div class="pve-hw-pci-vendor">${escH(d.vendor || "")}</div>
            <div class="pve-hw-pci-driver">Driver: <span>${escH(d.driver || "—")}</span></div>
          </button>`).join("")
      : `<div class="pve-hw-empty">No PCI devices found.</div>`;

    return `
      <section class="pve-hw-card">
        <div class="pve-hw-card-hdr">
          <div class="pve-hw-card-title">${hwChipIco()}<span>PCI Devices</span></div>
          <span class="pve-hw-count-badge">${devices.length} device${devices.length === 1 ? "" : "s"}</span>
        </div>
        <div class="pve-hw-pci-grid">${cards}</div>
      </section>`;
  }

  function buildHardwareTab(nodeCfg) {
    const hw = _prxHwCache[nodeCfg.groupName]?.data || null;
    const sub = _hardwareSubTabs[nodeCfg.groupName] || "thermal";
    if (!hw) {
      return `
        <div class="pve-hw-tab">
          <div class="pve-hw-empty pve-hw-empty--block">
            Hardware inventory unavailable — check ProxMenux MONITOR connectivity.
          </div>
        </div>`;
    }

    const pane = sub === "graphics" ? buildGraphicsPane(nodeCfg, hw)
      : sub === "pci" ? buildPciPane(hw)
      : buildThermalPane(hw);

    return `
      <div class="pve-hw-tab">
        ${buildSystemInfoCard(hw)}
        ${buildMemoryModulesCard(hw)}
        <div class="pve-hw-subtabs" role="tablist" aria-label="Hardware details">
          <button type="button" class="pve-hw-subtab ${sub === "thermal" ? "pve-hw-subtab--active" : ""}" data-hw-sub="thermal" role="tab" aria-selected="${sub === "thermal"}">Thermal</button>
          <button type="button" class="pve-hw-subtab ${sub === "graphics" ? "pve-hw-subtab--active" : ""}" data-hw-sub="graphics" role="tab" aria-selected="${sub === "graphics"}">Graphics</button>
          <button type="button" class="pve-hw-subtab ${sub === "pci" ? "pve-hw-subtab--active" : ""}" data-hw-sub="pci" role="tab" aria-selected="${sub === "pci"}">PCI Devices</button>
        </div>
        <div class="pve-hw-subpane">${pane}</div>
      </div>`;
  }


  // ── Security / Lynis (ProxMenux) ───────────────────────────────────
  const _prxLynisCache = {}; // groupName -> cache
  const _lynisPoll = {}; // groupName -> interval id
  let _lynisInstallModal = null;

  function lynisState(groupName) {
    if (!_prxLynisCache[groupName]) {
      _prxLynisCache[groupName] = {
        tools: null,
        report: null,
        status: null,
        at: 0,
        expanded: false,
        reportPane: "overview",
        msg: "",
        err: "",
        loading: false,
      };
    }
    return _prxLynisCache[groupName];
  }

  function stopLynisPoll(groupName) {
    if (_lynisPoll[groupName]) {
      clearInterval(_lynisPoll[groupName]);
      delete _lynisPoll[groupName];
    }
  }

  function stripAnsi(str) {
    return String(str || "")
      .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
      .replace(/\[[0-9;]*m/g, "");
  }

  /** ProxMenux sometimes returns `lynis --version` stdout (ANSI + PID warnings). */
  function cleanLynisVersion(raw) {
    const cleaned = stripAnsi(raw).replace(/\s+/g, " ").trim();
    if (!cleaned) return "";
    const m = cleaned.match(/\b(\d+\.\d+(?:\.\d+)?)\b/);
    if (m) return m[1];
    // Reject multi-line / warning dumps
    if (/PID file|Warning:|Note:/i.test(cleaned) || cleaned.length > 24) return "";
    return cleaned.slice(0, 24);
  }

  function normalizeLynisTools(tools) {
    if (!tools || typeof tools !== "object") return tools;
    const lynis = tools.lynis;
    if (!lynis || typeof lynis !== "object") return tools;
    const version = cleanLynisVersion(lynis.version);
    return {
      ...tools,
      lynis: {
        ...lynis,
        version: version || cleanLynisVersion(lynis.lynis_version) || "",
      },
    };
  }

  async function fetchPrxSecurityTools(nodeCfg, { silent = true } = {}) {
    return prxApiFetch(nodeCfg, "/api/security/tools", { silent });
  }

  async function fetchPrxLynisStatus(nodeCfg, { silent = true } = {}) {
    return prxApiFetch(nodeCfg, "/api/security/lynis/status", { silent });
  }

  async function fetchPrxLynisReport(nodeCfg, { silent = true } = {}) {
    return prxApiFetch(nodeCfg, "/api/security/lynis/report", { silent });
  }

  async function refreshLynisCache(nodeCfg, { force = false, silent = true } = {}) {
    const st = lynisState(nodeCfg.groupName);
    if (!force && st.tools && (Date.now() - st.at) < 15000) return st;
    st.loading = true;
    try {
      const [toolsRes, statusRes] = await Promise.all([
        fetchPrxSecurityTools(nodeCfg, { silent }).catch(() => null),
        fetchPrxLynisStatus(nodeCfg, { silent }).catch(() => null),
      ]);
      if (toolsRes?.tools) st.tools = normalizeLynisTools(toolsRes.tools);
      if (statusRes) st.status = statusRes;
      const lynis = st.tools?.lynis;
      if (lynis?.installed && lynis?.last_scan) {
        try {
          const rep = await fetchPrxLynisReport(nodeCfg, { silent });
          if (rep?.success && rep.report) st.report = rep.report;
          // Prefer clean version from report when tools version was junk
          if (st.report?.lynis_version) {
            const ver = cleanLynisVersion(st.report.lynis_version);
            if (ver && st.tools?.lynis) st.tools.lynis.version = ver;
          }
        } catch {
          /* keep previous report */
        }
      }
      st.at = Date.now();
      st.err = "";
    } catch (err) {
      st.err = err.message || String(err);
    } finally {
      st.loading = false;
    }
    return st;
  }

  function lynisScoreColor(score) {
    if (score == null || Number.isNaN(Number(score))) return "muted";
    const n = Number(score);
    if (n >= 70) return "good";
    if (n >= 50) return "warn";
    return "bad";
  }

  function fmtLynisStamp(val) {
    if (!val) return "Never";
    return String(val).replace("T", " ").substring(0, 16);
  }

  function buildLynisReportExpandHtml(report, pane) {
    if (!report) return "";
    const warnings = Array.isArray(report.warnings) ? report.warnings : [];
    const suggestions = Array.isArray(report.suggestions) ? report.suggestions : [];
    const sections = Array.isArray(report.sections) ? report.sections : [];
    const expW = Number(report.proxmox_expected_warnings) || 0;
    const expS = Number(report.proxmox_expected_suggestions) || 0;
    const adj = report.proxmox_adjusted_score != null ? report.proxmox_adjusted_score : report.hardening_index;
    const raw = report.hardening_index;
    const tabs = [
      ["overview", "Overview"],
      ["checks", `Checks (${sections.length})`],
      ["warnings", `Warnings (${warnings.length})`],
      ["suggestions", `Suggestions (${suggestions.length})`],
    ];
    const tabBtns = tabs.map(([id, label]) => `
      <button type="button" class="pve-sec-rpane ${pane === id ? "pve-sec-rpane--active" : ""}" data-lynis-pane="${id}">${escH(label)}</button>
    `).join("");

    let body = "";
    if (pane === "overview") {
      body = `
        <div class="pve-sec-ov-grid">
          <div class="pve-sec-ov"><span>Hardening</span><b class="pve-sec-score--${lynisScoreColor(adj)}">${escH(adj ?? "—")}/100</b></div>
          <div class="pve-sec-ov"><span>Lynis raw</span><b>${escH(raw ?? "—")}/100</b></div>
          <div class="pve-sec-ov"><span>Warnings</span><b>${warnings.length} <small>(${Math.max(0, warnings.length - expW)} actionable)</small></b></div>
          <div class="pve-sec-ov"><span>Suggestions</span><b>${suggestions.length} <small>(${Math.max(0, suggestions.length - expS)} actionable)</small></b></div>
          <div class="pve-sec-ov"><span>Firewall</span><b>${report.firewall_active ? "Active" : "Inactive"}</b></div>
          <div class="pve-sec-ov"><span>Malware scanner</span><b>${report.malware_scanner ? "Present" : "Missing"}</b></div>
          <div class="pve-sec-ov"><span>Packages</span><b>${escH(report.installed_packages ?? "—")}</b></div>
          <div class="pve-sec-ov"><span>Lynis</span><b>${escH(report.lynis_version || "—")}</b></div>
        </div>`;
    } else if (pane === "checks") {
      const rows = sections.slice(0, 40).map((sec) => {
        const checks = Array.isArray(sec.checks) ? sec.checks : [];
        const preview = checks.slice(0, 4).map((c) => escH(c.name || "")).filter(Boolean).join(" · ");
        return `
          <div class="pve-sec-check">
            <div class="pve-sec-check-name">${escH(sec.name || "Section")}</div>
            <div class="pve-sec-check-meta">${checks.length} checks${preview ? ` — ${preview}` : ""}</div>
          </div>`;
      }).join("") || `<div class="pve-sec-empty">No check sections available</div>`;
      body = `<div class="pve-sec-list">${rows}</div>`;
    } else if (pane === "warnings") {
      const rows = warnings.map((w) => `
        <div class="pve-sec-finding ${w.proxmox_expected ? "is-expected" : "is-action"}">
          <div class="pve-sec-finding-top">
            <span class="pve-sec-finding-id">${escH(w.test_id || "WARN")}</span>
            ${w.proxmox_expected ? `<span class="pve-sec-tag">PVE expected</span>` : `<span class="pve-sec-tag pve-sec-tag--warn">Actionable</span>`}
          </div>
          <div class="pve-sec-finding-title">${escH(w.description || "Warning")}</div>
          ${w.proxmox_context ? `<div class="pve-sec-finding-ctx">${escH(w.proxmox_context)}</div>` : ""}
          ${w.solution ? `<div class="pve-sec-finding-sol">${escH(w.solution)}</div>` : ""}
        </div>`).join("") || `<div class="pve-sec-empty">No warnings</div>`;
      body = `<div class="pve-sec-list">${rows}</div>`;
    } else {
      const rows = suggestions.slice(0, 60).map((s) => `
        <div class="pve-sec-finding ${s.proxmox_expected ? "is-expected" : "is-action"}">
          <div class="pve-sec-finding-top">
            <span class="pve-sec-finding-id">${escH(s.test_id || "SUG")}</span>
            ${s.proxmox_expected ? `<span class="pve-sec-tag">PVE expected</span>` : `<span class="pve-sec-tag pve-sec-tag--sug">Actionable</span>`}
          </div>
          <div class="pve-sec-finding-title">${escH(s.description || "Suggestion")}</div>
          ${s.proxmox_context ? `<div class="pve-sec-finding-ctx">${escH(s.proxmox_context)}</div>` : ""}
          ${s.details ? `<div class="pve-sec-finding-sol">${escH(s.details)}</div>` : ""}
          ${s.solution ? `<div class="pve-sec-finding-sol">${escH(s.solution)}</div>` : ""}
        </div>`).join("") || `<div class="pve-sec-empty">No suggestions</div>`;
      body = `<div class="pve-sec-list">${rows}</div>`;
    }

    return `
      <div class="pve-sec-expand">
        <div class="pve-sec-meta-grid">
          <div><span>Hostname</span><b>${escH(report.hostname || "N/A")}</b></div>
          <div><span>OS</span><b>${escH(report.os_fullname || `${report.os_name || ""} ${report.os_version || ""}`.trim() || "N/A")}</b></div>
          <div><span>Kernel</span><b>${escH(report.kernel_version || "N/A")}</b></div>
          <div><span>Tests</span><b>${escH(report.tests_performed ?? "—")}</b></div>
        </div>
        <div class="pve-sec-rpanes">${tabBtns}</div>
        <div class="pve-sec-rbody">${body}</div>
      </div>`;
  }

  function buildLynisPdfHtml(report, nodeCfg) {
    const warnings = Array.isArray(report?.warnings) ? report.warnings : [];
    const suggestions = Array.isArray(report?.suggestions) ? report.suggestions : [];
    const expW = Number(report?.proxmox_expected_warnings) || 0;
    const expS = Number(report?.proxmox_expected_suggestions) || 0;
    const adj = report?.proxmox_adjusted_score != null ? report.proxmox_adjusted_score : report?.hardening_index;
    const raw = report?.hardening_index;
    const actW = Math.max(0, warnings.length - expW);
    const actS = Math.max(0, suggestions.length - expS);
    const color = adj == null ? "#64748b" : adj >= 70 ? "#16a34a" : adj >= 50 ? "#ca8a04" : "#dc2626";
    const now = new Date().toLocaleString();
    const warnRows = warnings.map((w) => `
      <tr>
        <td>${escH(w.test_id || "")}</td>
        <td>${escH(w.description || "")}${w.proxmox_expected ? ' <em style="color:#64748b">(PVE expected)</em>' : ""}</td>
      </tr>`).join("") || `<tr><td colspan="2">None</td></tr>`;
    const sugRows = suggestions.slice(0, 80).map((s) => `
      <tr>
        <td>${escH(s.test_id || "")}</td>
        <td>${escH(s.description || "")}${s.proxmox_expected ? ' <em style="color:#64748b">(PVE expected)</em>' : ""}</td>
      </tr>`).join("") || `<tr><td colspan="2">None</td></tr>`;
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Lynis Security Audit</title>
<style>
  body{font-family:Inter,Segoe UI,system-ui,sans-serif;margin:0;background:#f1f5f9;color:#0f172a}
  .wrap{max-width:920px;margin:0 auto;padding:28px 20px 48px}
  .card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:18px;margin-bottom:14px}
  h1{margin:0 0 6px;font-size:26px} .sub{color:#64748b;font-size:13px;margin-bottom:18px}
  .score{font-size:42px;font-weight:900;color:${color}}
  table{width:100%;border-collapse:collapse;font-size:13px} th,td{padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:left;vertical-align:top}
  th{font-size:11px;color:#64748b;text-transform:uppercase}
  .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
  .kv{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px}
  .kv span{display:block;font-size:11px;color:#64748b} .kv b{font-size:14px}
  @media print{body{background:#fff}.wrap{padding:0}}
</style></head><body><div class="wrap">
  <h1>Lynis Security Audit</h1>
  <div class="sub">${escH(report?.hostname || nodeCfg.pveNode || "")} · ${escH(fmtLynisStamp(report?.datetime_start))} · Generated ${escH(now)}</div>
  <div class="card" style="display:flex;gap:24px;align-items:center">
    <div class="score">${escH(adj ?? "—")}</div>
    <div>
      <div style="font-weight:800">Proxmox-adjusted hardening score</div>
      <div style="color:#64748b;font-size:13px;margin-top:4px">Lynis raw: ${escH(raw ?? "—")}/100 · ${escH(report?.tests_performed ?? "—")} tests</div>
      <div style="color:#64748b;font-size:13px">${actW} actionable warnings · ${actS} actionable suggestions</div>
    </div>
  </div>
  <div class="card"><div class="grid">
    <div class="kv"><span>OS</span><b>${escH(report?.os_fullname || "—")}</b></div>
    <div class="kv"><span>Kernel</span><b>${escH(report?.kernel_version || "—")}</b></div>
    <div class="kv"><span>Lynis</span><b>${escH(report?.lynis_version || "—")}</b></div>
    <div class="kv"><span>Packages</span><b>${escH(report?.installed_packages ?? "—")}</b></div>
  </div></div>
  <div class="card"><h3 style="margin:0 0 10px">Warnings (${warnings.length})</h3><table><tr><th>ID</th><th>Finding</th></tr>${warnRows}</table></div>
  <div class="card"><h3 style="margin:0 0 10px">Suggestions (${suggestions.length})</h3><table><tr><th>ID</th><th>Finding</th></tr>${sugRows}</table></div>
  <div style="text-align:center;color:#94a3b8;font-size:12px">ProxMenux Monitor · Homepage widget</div>
</div></body></html>`;
  }

  function buildSecurityTab(nodeCfg) {
    const st = lynisState(nodeCfg.groupName);
    const lynis = st.tools?.lynis || null;
    const report = st.report;
    const running = !!(st.status?.running || st.localRunning);
    const installed = !!lynis?.installed;

    if (!getPrxUrl(nodeCfg)) {
      return `<div class="pve-sec-tab"><div class="pve-sec-empty-block">ProxMenux MONITOR URL is not configured for this node.</div></div>`;
    }
    if (st.loading && !lynis) {
      return `<div class="pve-sec-tab"><div class="pve-sec-empty-block">Loading Lynis status from ProxMenux…</div></div>`;
    }
    if (st.err && !lynis) {
      return `<div class="pve-sec-tab"><div class="pve-sec-empty-block">${escH(st.err)}</div></div>`;
    }

    if (!installed) {
      return `
        <div class="pve-sec-tab">
          <div class="pve-sec-hdr">
            <div class="pve-sec-hdr-left">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
              <div>
                <div class="pve-sec-title">Lynis Security Audit</div>
                <div class="pve-sec-sub">System security auditing tool that performs comprehensive security scans</div>
              </div>
            </div>
          </div>
          <div class="pve-sec-status">
            <div class="pve-sec-status-left">
              <div class="pve-sec-ico pve-sec-ico--muted">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
              </div>
              <div>
                <div class="pve-sec-status-title">Lynis Not Installed</div>
                <div class="pve-sec-status-sub">Comprehensive security auditing and hardening tool</div>
              </div>
            </div>
          </div>
          <div class="pve-sec-info">
            <div class="pve-sec-info-title">Lynis features:</div>
            <ul>
              <li>System hardening scoring (0–100)</li>
              <li>Vulnerability detection and suggestions</li>
              <li>Compliance checking (PCI-DSS, HIPAA, etc.)</li>
              <li>Installed from latest GitHub source via ProxMenux</li>
            </ul>
          </div>
          <button type="button" class="pve-sec-run" data-lynis-install>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
            Install Lynis
          </button>
          ${st.err ? `<div class="pve-sec-banner pve-sec-banner--err">${escH(st.err)}</div>` : ""}
        </div>`;
    }

    const raw = report?.hardening_index != null ? Number(report.hardening_index)
      : (lynis.hardening_index != null ? Number(lynis.hardening_index) : null);
    const adj = report?.proxmox_adjusted_score != null ? Number(report.proxmox_adjusted_score) : raw;
    const expW = Number(report?.proxmox_expected_warnings) || 0;
    const expS = Number(report?.proxmox_expected_suggestions) || 0;
    const warnTotal = Array.isArray(report?.warnings) ? report.warnings.length : 0;
    const sugTotal = Array.isArray(report?.suggestions) ? report.suggestions.length : 0;
    const warnAction = Math.max(0, warnTotal - expW);
    const sugAction = Math.max(0, sugTotal - expS);
    const warnDisplay = warnAction > 0 ? warnAction : warnTotal;
    const sugDisplay = sugAction > 0 ? sugAction : sugTotal;
    const scoreCls = lynisScoreColor(adj);
    const warnCls = warnAction > 0 ? "bad" : (warnTotal > 0 ? "warn" : "good");
    const sugCls = sugAction > 0 ? "warn" : "good";
    const lastScan = fmtLynisStamp(lynis.last_scan || report?.datetime_start);
    const adjusted = adj != null && raw != null && adj !== raw;
    const expectedFindings = expW + expS;

    const reportRow = report ? `
      <div class="pve-sec-reports">
        <div class="pve-sec-reports-label">Audit Reports</div>
        <div class="pve-sec-report">
          <div class="pve-sec-report-main" data-lynis-toggle role="button" tabindex="0">
            <div class="pve-sec-report-left">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>
              <div>
                <div class="pve-sec-report-title">Security Audit - ${escH(fmtLynisStamp(report.datetime_start || lynis.last_scan))}</div>
                <div class="pve-sec-report-sub">${escH(report.hostname || nodeCfg.pveNode || "System")} - ${escH(report.tests_performed ?? "—")} tests - PVE Score: ${escH(adj ?? "N/A")}/100 - ${warnAction} warnings - ${sugAction} suggestions</div>
              </div>
            </div>
            <div class="pve-sec-report-actions">
              <button type="button" class="pve-sec-pdf" data-lynis-pdf title="Print / Save as PDF">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6"/><rect x="6" y="14" width="12" height="8" rx="1"/></svg>
                PDF
              </button>
              <svg class="pve-sec-chevron ${st.expanded ? "is-open" : ""}" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
              <button type="button" class="pve-sec-del" data-lynis-delete title="Delete report">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
              </button>
            </div>
          </div>
          ${st.expanded ? buildLynisReportExpandHtml(report, st.reportPane || "overview") : ""}
        </div>
      </div>` : "";

    return `
      <div class="pve-sec-tab">
        <div class="pve-sec-hdr">
          <div class="pve-sec-hdr-left">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
            <div>
              <div class="pve-sec-title">Lynis Security Audit</div>
              <div class="pve-sec-sub">System security auditing tool that performs comprehensive security scans</div>
            </div>
          </div>
        </div>

        <div class="pve-sec-status">
          <div class="pve-sec-status-left">
            <div class="pve-sec-ico pve-sec-ico--ok">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
            </div>
            <div>
              <div class="pve-sec-status-title">Lynis ${escH(cleanLynisVersion(lynis.version || report?.lynis_version) || "installed")}</div>
              <div class="pve-sec-status-sub">Security auditing tool installed</div>
            </div>
          </div>
          <span class="pve-sec-badge pve-sec-badge--ok">Installed</span>
        </div>

        <div class="pve-sec-metrics">
          <div class="pve-sec-metric">
            <div class="pve-sec-metric-label">Last Scan</div>
            <div class="pve-sec-metric-val">${escH(lastScan)}</div>
          </div>
          <div class="pve-sec-metric">
            <div class="pve-sec-metric-label">Hardening Index</div>
            <div class="pve-sec-metric-big pve-sec-score--${scoreCls}">${adj != null ? escH(adj) : "—"}</div>
            ${adjusted ? `<div class="pve-sec-metric-sub">Lynis: ${escH(raw)} | PVE: ${escH(adj)}</div>` : ""}
          </div>
          <div class="pve-sec-metric">
            <div class="pve-sec-metric-label">Warnings</div>
            <div class="pve-sec-metric-big pve-sec-score--${report ? warnCls : "muted"}">${report ? warnDisplay : "—"}</div>
            ${expW > 0 ? `<div class="pve-sec-metric-sub">+${expW} PVE expected</div>` : ""}
          </div>
          <div class="pve-sec-metric">
            <div class="pve-sec-metric-label">Suggestions</div>
            <div class="pve-sec-metric-big pve-sec-score--${report ? sugCls : "muted"}">${report ? sugDisplay : "—"}</div>
            ${expS > 0 ? `<div class="pve-sec-metric-sub">+${expS} PVE expected</div>` : ""}
          </div>
        </div>

        ${raw != null ? `
        <div class="pve-sec-scoreblock">
          <div class="pve-sec-scorehdr">
            <span>Security Hardening Score ${adjusted ? `<em>(Proxmox Adjusted)</em>` : ""}</span>
            <b class="pve-sec-score--${scoreCls}">${escH(adj)}/100</b>
          </div>
          <div class="pve-sec-bar">
            ${adjusted ? `<div class="pve-sec-bar-raw" style="width:${Math.max(0, Math.min(100, raw))}%"></div>` : ""}
            <div class="pve-sec-bar-adj pve-sec-bar-adj--${scoreCls}" style="width:${Math.max(0, Math.min(100, Number(adj) || 0))}%"></div>
          </div>
          <div class="pve-sec-bar-legend">
            <span>Critical (0-49)</span><span>Moderate (50-69)</span><span>Good (70-100)</span>
          </div>
          ${adjusted ? `<div class="pve-sec-score-note">Lynis raw score: ${escH(raw)}/100 | ${expectedFindings} findings are expected in Proxmox VE</div>` : ""}
        </div>` : ""}

        ${running ? `
        <div class="pve-sec-progress">
          <div class="pve-sec-spinner"></div>
          <div>
            <div class="pve-sec-progress-title">Security audit in progress...</div>
            <div class="pve-sec-progress-sub">This may take 2-5 minutes. Lynis is scanning your system for vulnerabilities, misconfigurations, and hardening opportunities.</div>
          </div>
        </div>` : ""}

        ${st.msg ? `<div class="pve-sec-banner pve-sec-banner--ok">${escH(st.msg)}</div>` : ""}
        ${st.err ? `<div class="pve-sec-banner pve-sec-banner--err">${escH(st.err)}</div>` : ""}

        ${reportRow}

        <button type="button" class="pve-sec-run" data-lynis-run ${running ? "disabled" : ""}>
          ${running
            ? `<span class="pve-sec-spinner pve-sec-spinner--btn"></span>Running Audit...`
            : `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>Run Security Audit`}
        </button>
      </div>`;
  }

  function startLynisPoll(nodeCfg) {
    const group = nodeCfg.groupName;
    stopLynisPoll(group);
    _lynisPoll[group] = setInterval(async () => {
      try {
        const status = await fetchPrxLynisStatus(nodeCfg, { silent: true });
        const st = lynisState(group);
        st.status = status;
        if (!status?.running) {
          stopLynisPoll(group);
          st.localRunning = false;
          if (status?.progress === "completed") {
            st.msg = "Security audit completed successfully";
            st.err = "";
            await refreshLynisCache(nodeCfg, { force: true, silent: true });
          } else {
            const prog = stripAnsi(status?.progress || "Audit failed").replace(/\s+/g, " ").trim();
            st.err = prog.length > 180 ? `${prog.slice(0, 180)}…` : prog;
          }
          if ((_tabs[group] || "overview") === "security") paintNodeFromCache(nodeCfg);
        } else if ((_tabs[group] || "overview") === "security") {
          paintNodeFromCache(nodeCfg);
        }
      } catch {
        /* keep polling */
      }
    }, 3000);
  }

  async function openLynisInstallModal(nodeCfg) {
    if (_lynisInstallModal) {
      _lynisInstallModal.remove();
      _lynisInstallModal = null;
    }
    const backdrop = document.createElement("div");
    backdrop.className = "pve-hw-swrun-backdrop";
    backdrop.innerHTML = `
      <div class="pve-hw-swrun-modal" role="dialog" aria-modal="true">
        <div class="pve-hw-swrun-title">Lynis Installation</div>
        <div class="pve-hw-swrun-sub">Installing Lynis security auditing tool via ProxMenux…</div>
        <div class="pve-hw-swrun-status" data-lynis-inst-status>Connecting…</div>
        <div class="pve-hw-swrun-log" data-lynis-inst-log></div>
        <div class="pve-hw-swrun-ftr">
          <button type="button" class="pve-hw-gpu-sw-btn pve-hw-gpu-sw-btn--ghost" data-lynis-inst-close>Close</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    _lynisInstallModal = backdrop;
    const statusEl = backdrop.querySelector("[data-lynis-inst-status]");
    const logEl = backdrop.querySelector("[data-lynis-inst-log]");
    const append = (line, cls = "") => {
      const div = document.createElement("div");
      if (cls) div.className = cls;
      div.textContent = line;
      logEl.appendChild(div);
      logEl.scrollTop = logEl.scrollHeight;
    };
    backdrop.querySelector("[data-lynis-inst-close]")?.addEventListener("click", () => {
      try { backdrop.__ws?.close(); } catch {}
      backdrop.remove();
      if (_lynisInstallModal === backdrop) _lynisInstallModal = null;
      refreshLynisCache(nodeCfg, { force: true, silent: true }).then(() => paintNodeFromCache(nodeCfg));
    });
    try {
      const ticket = await fetchPrxTerminalTicket(nodeCfg);
      const sessionId = Math.random().toString(36).slice(2, 8);
      const wsUrl = prxScriptWsUrl(getPrxUrl(nodeCfg), sessionId, ticket);
      const ws = new WebSocket(wsUrl);
      backdrop.__ws = ws;
      statusEl.textContent = "Connected — starting installer…";
      ws.onopen = () => {
        ws.send(JSON.stringify({
          script_path: "/usr/local/share/proxmenux/scripts/security/lynis_installer.sh",
          params: { EXECUTION_MODE: "web" },
        }));
        append("Running lynis_installer.sh", "is-meta");
      };
      ws.onmessage = (ev) => {
        const raw = String(ev.data || "");
        if (raw === '{"type": "pong"}' || raw === '{"type":"pong"}') return;
        try {
          const msg = JSON.parse(raw);
          if (msg?.type === "error") {
            append(msg.message || "Error", "is-err");
            statusEl.textContent = "Failed";
            return;
          }
        } catch {}
        append(raw.replace(/\x1b\[[0-9;]*m/g, ""));
      };
      ws.onerror = () => { statusEl.textContent = "Connection error"; append("WebSocket error", "is-err"); };
      ws.onclose = () => { statusEl.textContent = "Finished"; append("Connection closed", "is-meta"); };
    } catch (err) {
      statusEl.textContent = "Failed to start";
      append(err.message || String(err), "is-err");
    }
  }

  function bindSecurityTab(host, nodeCfg) {
    const st = lynisState(nodeCfg.groupName);

    host.querySelector("[data-lynis-run]")?.addEventListener("click", async (e) => {
      e.preventDefault();
      if (st.localRunning || st.status?.running) return;
      st.err = "";
      st.msg = "";
      st.localRunning = true;
      paintNodeFromCache(nodeCfg);
      try {
        const res = await prxApiFetch(nodeCfg, "/api/security/lynis/run", { method: "POST" });
        if (!res?.success) throw new Error(res?.message || "Failed to start audit");
        st.status = { running: true, progress: "running", success: true };
        startLynisPoll(nodeCfg);
        paintNodeFromCache(nodeCfg);
      } catch (err) {
        st.localRunning = false;
        st.err = err.message || String(err);
        paintNodeFromCache(nodeCfg);
      }
    });

    host.querySelector("[data-lynis-install]")?.addEventListener("click", (e) => {
      e.preventDefault();
      openLynisInstallModal(nodeCfg);
    });

    const toggle = host.querySelector("[data-lynis-toggle]");
    if (toggle) {
      const onToggle = (e) => {
        if (e.target.closest("[data-lynis-pdf], [data-lynis-delete]")) return;
        st.expanded = !st.expanded;
        paintNodeFromCache(nodeCfg);
      };
      toggle.addEventListener("click", onToggle);
      toggle.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle(e);
        }
      });
    }

    host.querySelector("[data-lynis-pdf]")?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!st.report) return;
      const html = buildLynisPdfHtml(st.report, nodeCfg);
      const blob = new Blob([html], { type: "text/html" });
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    });

    host.querySelector("[data-lynis-delete]")?.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!confirm("Delete this audit report? The report file will be removed from the server.")) return;
      try {
        await prxApiFetch(nodeCfg, "/api/security/lynis/report", { method: "DELETE" });
        st.report = null;
        st.expanded = false;
        st.msg = "Report deleted";
        st.err = "";
        await refreshLynisCache(nodeCfg, { force: true, silent: true });
        paintNodeFromCache(nodeCfg);
      } catch (err) {
        st.err = err.message || "Failed to delete report";
        paintNodeFromCache(nodeCfg);
      }
    });

    host.querySelectorAll("[data-lynis-pane]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        st.reportPane = btn.getAttribute("data-lynis-pane") || "overview";
        paintNodeFromCache(nodeCfg);
      });
    });
  }

  function closePciDetails() {
    if (_pciModal) {
      _pciModal.remove();
      _pciModal = null;
    }
  }

  function openPciDetails(nodeCfg, slot) {
    const hw = _prxHwCache[nodeCfg.groupName]?.data;
    const device = (hw?.pci_devices || []).find((d) => String(d.slot) === String(slot));
    if (!device) return;
    closePciDetails();

    const title = device.device || device.sdevice || "PCI Device";
    const backdrop = document.createElement("div");
    backdrop.className = "pve-hw-pci-backdrop";
    backdrop.innerHTML = `
      <div class="pve-hw-pci-modal" role="dialog" aria-modal="true">
        <button type="button" class="pve-hw-gpu-close" data-pci-close aria-label="Close">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
        <div class="pve-hw-pci-modal-hdr">
          <div class="pve-hw-pci-modal-title">${escH(title)}</div>
          <div class="pve-hw-pci-modal-sub">PCI Device Information</div>
        </div>
        <div class="pve-hw-pci-modal-body">
          <div class="pve-hw-gpu-prop">
            <span class="pve-hw-k">Device Type</span>
            <span class="pve-hw-pci-badge ${pciTypeBadgeClass(device.type)}">${escH(device.type || "PCI")}</span>
          </div>
          <div class="pve-hw-gpu-prop">
            <span class="pve-hw-k">PCI Slot</span>
            <span class="pve-hw-v pve-hw-mono">${escH(device.slot || "—")}</span>
          </div>
          <div class="pve-hw-gpu-prop">
            <span class="pve-hw-k">Device Name</span>
            <span class="pve-hw-v pve-hw-pci-val-right">${escH(device.device || "—")}</span>
          </div>
          <div class="pve-hw-gpu-prop">
            <span class="pve-hw-k">Product Name</span>
            <span class="pve-hw-v pve-hw-pci-product">${escH(device.sdevice || "—")}</span>
          </div>
          <div class="pve-hw-gpu-prop">
            <span class="pve-hw-k">Vendor</span>
            <span class="pve-hw-v pve-hw-pci-val-right">${escH(device.vendor || "—")}</span>
          </div>
          <div class="pve-hw-gpu-prop">
            <span class="pve-hw-k">Class</span>
            <span class="pve-hw-v pve-hw-mono">${escH(device.class || "—")}</span>
          </div>
          <div class="pve-hw-gpu-prop">
            <span class="pve-hw-k">Driver</span>
            <span class="pve-hw-v pve-hw-mono pve-hw-v--ok">${escH(device.driver || "—")}</span>
          </div>
          <div class="pve-hw-gpu-prop">
            <span class="pve-hw-k">Kernel Module</span>
            <span class="pve-hw-v pve-hw-mono">${escH(device.kernel_module || "—")}</span>
          </div>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    _pciModal = backdrop;
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closePciDetails(); });
    backdrop.querySelector("[data-pci-close]")?.addEventListener("click", closePciDetails);
  }

  function closeGpuDetails() {
    if (_gpuModal?.__pveGpuPoll) {
      clearInterval(_gpuModal.__pveGpuPoll);
      _gpuModal.__pveGpuPoll = null;
    }
    if (_gpuModal) {
      _gpuModal.remove();
      _gpuModal = null;
    }
  }

  function parseGpuPct(val) {
    if (val == null || val === "") return null;
    if (typeof val === "number" && Number.isFinite(val)) return val;
    const m = String(val).match(/-?\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : null;
  }

  function formatGpuEngineLabel(val) {
    if (val == null || val === "") return "";
    if (typeof val === "number" && Number.isFinite(val)) return `${val.toFixed(1)}%`;
    return String(val);
  }

  /** ProxMenux L(): value in KB → MB/GB label. */
  function formatGpuKiB(kb) {
    const s = typeof kb === "string" ? Number.parseFloat(kb) : Number(kb);
    if (!Number.isFinite(s) || isNaN(s)) return "N/A";
    const mb = s / 1024;
    if (mb >= 1048576) return `${(mb / 1048576).toFixed(1)} TB`;
    if (mb >= 1024) {
      const gb = mb / 1024;
      return gb > 999 ? `${(gb / 1024).toFixed(2)} TB` : `${gb.toFixed(1)} GB`;
    }
    return `${mb.toFixed(0)} MB`;
  }

  function gpuProgressBar(pct) {
    const n = Math.max(0, Math.min(100, Number(pct) || 0));
    return `<div class="pve-hw-therm-bar pve-hw-therm-bar--gpu"><i style="width:${n}%"></i></div>`;
  }

  function renderGpuRealtimeExtras(rt) {
    if (!rt) return "";
    const rows = [];
    if (rt.clock_graphics) {
      rows.push(`<div class="pve-hw-gpu-prop"><span class="pve-hw-k">Graphics Clock</span><span class="pve-hw-v">${escH(String(rt.clock_graphics))}</span></div>`);
    }
    if (rt.clock_memory) {
      rows.push(`<div class="pve-hw-gpu-prop"><span class="pve-hw-k">Memory Clock</span><span class="pve-hw-v">${escH(String(rt.clock_memory))}</span></div>`);
    }
    if (rt.power_draw && String(rt.power_draw) !== "0.00 W") {
      rows.push(`<div class="pve-hw-gpu-prop"><span class="pve-hw-k">Power Draw</span><span class="pve-hw-v" style="color:#3b82f6">${escH(String(rt.power_draw))}</span></div>`);
    }
    if (rt.temperature != null && rt.temperature !== "") {
      rows.push(`<div class="pve-hw-gpu-prop"><span class="pve-hw-k">Temperature</span><span class="pve-hw-v" style="color:#22c55e">${escH(String(rt.temperature))}°C</span></div>`);
    }
    if (rt.fan_speed != null && rt.fan_speed !== "") {
      rows.push(`<div class="pve-hw-gpu-prop"><span class="pve-hw-k">Fan</span><span class="pve-hw-v">${escH(String(rt.fan_speed))}${rt.fan_unit ? ` ${escH(String(rt.fan_unit))}` : ""}</span></div>`);
    }
    if (!rows.length) return "";
    return `
      <div class="pve-hw-modal-sec">
        <div class="pve-hw-modal-sec-title">Real-Time Metrics</div>
        <div class="pve-hw-gpu-rt-grid">${rows.join("")}</div>
      </div>`;
  }

  function renderGpuEngineBars(rt) {
    if (!rt || rt.has_monitoring_tool === false) {
      return `<div class="pve-hw-empty">No GPU monitoring tool available.</div>`;
    }
    const defs = [
      { key: "engine_render", label: "Render/3D" },
      { key: "engine_video", label: "Video" },
      { key: "engine_blitter", label: "Blitter" },
      { key: "engine_video_enhance", label: "VideoEnhance" },
    ];
    // Match ProxMenux: show a row when the key is present (even if null)
    const present = defs.filter((d) => Object.prototype.hasOwnProperty.call(rt, d.key) || rt[d.key] !== undefined);
    const list = present.length ? present : defs;
    return `
      <div class="pve-hw-modal-sec">
        <div class="pve-hw-modal-sec-title">Engine Utilization (Total)</div>
        <div class="pve-hw-gpu-eng-list">
          ${list.map((d) => {
            const raw = rt[d.key];
            const label = formatGpuEngineLabel(raw);
            const pct = parseGpuPct(raw) ?? 0;
            return `
              <div class="pve-hw-gpu-eng">
                <div class="pve-hw-gpu-eng-top">
                  <span class="pve-hw-k">${escH(d.label)}</span>
                  <span class="pve-hw-v">${escH(label)}</span>
                </div>
                ${gpuProgressBar(pct)}
              </div>`;
          }).join("")}
        </div>
      </div>`;
  }

  function renderGpuProcesses(rt) {
    const procs = Array.isArray(rt?.processes) ? rt.processes : [];
    if (!procs.length) {
      return `
        <div class="pve-hw-modal-sec">
          <div class="pve-hw-modal-sec-title">Active Processes (0)</div>
          <div class="pve-hw-empty">No active processes.</div>
        </div>`;
    }
    const cards = procs.map((p) => {
      const name = p.name || p.process || p.cmd || "process";
      const pid = p.pid != null ? String(p.pid) : "—";
      // ProxMenux: L(memory.resident / 1024) where resident is bytes → KB into L
      let memLabel = "0 MB";
      if (p.memory && typeof p.memory === "object") {
        const resident = Number(p.memory.resident);
        if (Number.isFinite(resident)) memLabel = formatGpuKiB(resident / 1024);
        else if (Number.isFinite(Number(p.memory.total))) memLabel = formatGpuKiB(Number(p.memory.total) / 1024);
      } else if (p.memory != null) {
        memLabel = formatGpuKiB(p.memory);
      }

      const engEntries = (p.engines && typeof p.engines === "object")
        ? Object.entries(p.engines)
        : [];
      // ProxMenux hides 0%/NaN engine rows for processes
      const engHtml = engEntries.map(([k, v]) => {
        const raw = (v && typeof v === "object") ? (v.busy ?? v) : v;
        const pct = parseGpuPct(raw);
        if (pct == null || pct === 0) return "";
        return `
          <div class="pve-hw-gpu-eng">
            <div class="pve-hw-gpu-eng-top">
              <span class="pve-hw-k">${escH(k)}</span>
              <span class="pve-hw-v">${escH(formatGpuEngineLabel(raw) || `${pct.toFixed(1)}%`)}</span>
            </div>
            ${gpuProgressBar(pct)}
          </div>`;
      }).filter(Boolean).join("");

      return `
        <div class="pve-hw-gpu-proc">
          <div class="pve-hw-gpu-proc-top">
            <div>
              <div class="pve-hw-gpu-proc-name">${escH(name)}</div>
              <div class="pve-hw-gpu-proc-meta">PID: ${escH(pid)}</div>
            </div>
            <span class="pve-hw-gpu-proc-mem">${escH(memLabel)}</span>
          </div>
          ${engHtml ? `<div class="pve-hw-gpu-proc-engs"><div class="pve-hw-gpu-proc-eng-label">Engine Utilization:</div>${engHtml}</div>` : ""}
        </div>`;
    }).join("");

    return `
      <div class="pve-hw-modal-sec">
        <div class="pve-hw-modal-sec-title">Active Processes (${procs.length})</div>
        <div class="pve-hw-gpu-proc-list">${cards}</div>
      </div>`;
  }

  function renderGpuMemory(rt) {
    const totalLabel = rt?.memory_total != null ? String(rt.memory_total) : "—";
    const usedLabel = rt?.memory_used != null ? String(rt.memory_used) : "—";
    const freeLabel = rt?.memory_free != null ? String(rt.memory_free) : "—";
    let pct = parseGpuPct(rt?.utilization_memory);
    if (pct == null) pct = 0;

    return `
      <div class="pve-hw-modal-sec">
        <div class="pve-hw-modal-sec-title">Memory</div>
        <div class="pve-hw-gpu-props">
          <div class="pve-hw-gpu-prop"><span class="pve-hw-k">Total</span><span class="pve-hw-v">${escH(totalLabel)}</span></div>
          <div class="pve-hw-gpu-prop"><span class="pve-hw-k">Used</span><span class="pve-hw-v">${escH(usedLabel)}</span></div>
          <div class="pve-hw-gpu-prop"><span class="pve-hw-k">Free</span><span class="pve-hw-v">${escH(freeLabel)}</span></div>
        </div>
        <div class="pve-hw-gpu-eng" style="margin-top:10px">
          <div class="pve-hw-gpu-eng-top">
            <span class="pve-hw-k">Memory Utilization</span>
            <span class="pve-hw-v">${pct.toFixed(1)}%</span>
          </div>
          ${gpuProgressBar(pct)}
        </div>
      </div>`;
  }

  async function refreshGpuModalBody(modal, nodeCfg, gpu) {
    const body = modal.querySelector("[data-gpu-live]");
    if (!body) return;
    const slot = gpu.slot || "";
    try {
      const rt = await prxApiFetch(nodeCfg, `/api/gpu/${encodeURIComponent(slot)}/realtime`, { silent: true });
      body.innerHTML = `
        <div class="pve-hw-gpu-live-pill"><span class="pve-hw-live-dot"></span>Updating every 3 seconds</div>
        ${renderGpuRealtimeExtras(rt)}
        ${renderGpuEngineBars(rt)}
        ${renderGpuProcesses(rt)}
        ${renderGpuMemory(rt)}`;
    } catch (err) {
      body.innerHTML = `<div class="pve-hw-empty">Live metrics unavailable (${escH(err.message || "error")}).</div>`;
    }
  }

  function openGpuDetails(nodeCfg, slot) {
    const hw = _prxHwCache[nodeCfg.groupName]?.data;
    const gpu = (hw?.gpus || []).find((g) => String(g.slot) === String(slot))
      || (hw?.pci_devices || []).map((d) => d.gpu_info).find((g) => g && String(g.slot) === String(slot));
    if (!gpu) return;
    closeGpuDetails();

    const vendor = String(gpu.vendor || "").toUpperCase() || "—";
    const driver = gpu.pci_driver || "—";
    const hasDriver = !!(gpu.pci_driver && String(gpu.pci_driver).toLowerCase() !== "none");

    const backdrop = document.createElement("div");
    backdrop.className = "pve-hw-gpu-backdrop";
    backdrop.innerHTML = `
      <div class="pve-hw-gpu-modal" role="dialog" aria-modal="true">
        <button type="button" class="pve-hw-gpu-close" data-gpu-close aria-label="Close">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
        <div class="pve-hw-gpu-modal-hdr">
          <div class="pve-hw-gpu-modal-title">${escH(gpu.name || "GPU")}</div>
          <div class="pve-hw-gpu-modal-sub">GPU Real-Time Monitoring</div>
        </div>
        <div class="pve-hw-modal-body">
          <div class="pve-hw-modal-sec">
            <div class="pve-hw-modal-sec-title">Basic Information</div>
            <div class="pve-hw-gpu-props">
              <div class="pve-hw-gpu-prop"><span class="pve-hw-k">Vendor</span><span class="pve-hw-vendor-pill">${escH(vendor)}</span></div>
              <div class="pve-hw-gpu-prop"><span class="pve-hw-k">Type</span><span class="pve-hw-v">${escH(gpu.type || "PCI")}</span></div>
              <div class="pve-hw-gpu-prop"><span class="pve-hw-k">PCI Slot</span><span class="pve-hw-v pve-hw-mono">${escH(gpu.slot || "—")}</span></div>
              <div class="pve-hw-gpu-prop">
                <span class="pve-hw-k">Driver</span>
                <span class="pve-hw-v pve-hw-driver">
                  <span class="pve-hw-mono pve-hw-v--ok">${escH(driver)}</span>
                  ${hasDriver ? `<span class="pve-hw-driver-ok" title="Driver active">✓</span>` : ""}
                </span>
              </div>
              <div class="pve-hw-gpu-prop"><span class="pve-hw-k">Kernel Module</span><span class="pve-hw-v pve-hw-mono">${escH(gpu.pci_kernel_module || "—")}</span></div>
            </div>
          </div>
          <div data-gpu-live><div class="pve-hw-empty">Loading live metrics…</div></div>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    _gpuModal = backdrop;
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closeGpuDetails(); });
    backdrop.querySelector("[data-gpu-close]")?.addEventListener("click", closeGpuDetails);
    refreshGpuModalBody(backdrop, nodeCfg, gpu);
    backdrop.__pveGpuPoll = setInterval(() => refreshGpuModalBody(backdrop, nodeCfg, gpu), 3000);
  }

  // ── Build HTML ─────────────────────────────────────────────────────
  function buildSkeleton() {
    return `
      <div class="pve-header">
        <div class="pve-header-top">
          <div class="pve-header-left">
            <div class="pve-node-title" style="opacity:.55">Loading…</div>
          </div>
        </div>
        <div class="pve-tabs" role="tablist" aria-label="Node views">
          <button type="button" class="pve-tab pve-tab--active" data-tab="overview">Overview</button>
          <button type="button" class="pve-tab" data-tab="network">Network</button>
          <button type="button" class="pve-tab" data-tab="guests">VMs &amp; LXCs</button>
          <button type="button" class="pve-tab" data-tab="storage">Storage</button>
          <button type="button" class="pve-tab" data-tab="hardware">Hardware</button>
          <button type="button" class="pve-tab" data-tab="security">Security</button>
        </div>
      </div>
      <div class="pve-body">
        <div class="pve-skeleton-row"></div>
        <div class="pve-skeleton-row" style="animation-delay:.12s"></div>
        <div class="pve-skeleton-row" style="animation-delay:.24s"></div>
      </div>`;
  }

  function buildShell(nodeCfg, pveData, glancesData, rrdData) {
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
    const glLoad = glancesData?.load;
    const glQuicklook = glancesData?.quicklook;

    const liveCpuPct = glCpu?.total ?? cpuPct;
    const liveCpuColor = pctColor(liveCpuPct);

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

    // ── Backup Drive ──────────────────────────────────────────────
    const bupFs = Array.isArray(glDisk) ? glDisk.find(d => d.mnt_point === nodeCfg.backupMount) || null : null;
    const bupPct = bupFs ? Math.round((bupFs.used / bupFs.size) * 100) : null;
    const bupColor = bupPct != null ? pctColor(bupPct) : "rgba(255,255,255,0.25)";
    const bupUsed = bupFs ? fmtBytes(bupFs.used) : "—";
    const bupTotal = bupFs ? fmtBytes(bupFs.size) : "—";

    let cpuTemp = null;
    if (Array.isArray(glSensors)) {
      const sensor = glSensors.find(s =>
        (s.label || "").toLowerCase().includes(nodeCfg.cpuSensor.toLowerCase())
      ) || glSensors.find(s =>
        s.type === "cpu_thermal" || (s.label || "").toLowerCase().includes("cpu")
      );
      cpuTemp = sensor?.value ?? null;
    }

    // ── Load Average ──────────────────────────────────────────────
    const loadMin1 = glLoad?.min1 ?? null;
    const loadMin5 = glLoad?.min5 ?? null;
    const cpuCores = glLoad?.cpucore ?? glCpu?.cpucore ?? 1;
    const loadBarColor = loadMin1 != null ? loadColor(loadMin1, cpuCores) : "#6ee7b7";
    const loadDisplay = loadMin1 != null ? loadMin1.toFixed(2) : "—";
    const loadSub = loadMin1 != null && loadMin5 != null
      ? `5m: ${loadMin5.toFixed(2)} · ${cpuCores} cores`
      : cpuCores > 1 ? `${cpuCores} cores` : "";

    // ── Swap ──────────────────────────────────────────────────────
    const glMemSwap = glancesData?.swap;
    const swapPct = glMemSwap
      ? Math.round((glMemSwap.used / glMemSwap.total) * 100)
      : (glQuicklook?.swap != null ? Math.round(glQuicklook.swap) : null);
    const swapUsed = glMemSwap ? fmtBytes(glMemSwap.used) : null;
    const swapTotal = glMemSwap ? fmtBytes(glMemSwap.total) : null;
    const swapColor = swapPct != null ? pctColor(swapPct) : "#6ee7b7";
    const swapDisplay = swapPct != null ? `${swapPct}%` : "—";
    const swapSub = swapUsed && swapTotal ? `${swapUsed} / ${swapTotal}` : "";

    // ── Process Count ─────────────────────────────────────────────
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
    const activeTab = _tabs[nodeCfg.groupName] || "overview";

    return `
      <div class="pve-shell" data-pve-group="${escH(nodeCfg.groupName)}">

        <!-- Header -->
        <div class="pve-header">
          <div class="pve-header-top">
            <div class="pve-header-left">
              <img class="pve-node-icon"
                   src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/webp/proxmox-light.webp"
                   alt="Proxmox" />
              <div>
                <div class="pve-node-title" style="color:${escH(color)};">${escH(nodeCfg.label)}</div>
                <div class="pve-node-subtitle">${escH(nodeCfg.pveNode)} · up ${escH(uptime)}</div>
              </div>
            </div>
            <div class="pve-header-right">
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
              <button type="button" class="pve-open-link pve-open-link--term" data-host-term title="Open host terminal">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/></svg>
                Terminal
              </button>
              <a class="pve-open-link pve-open-link--pve" href="${escH(getPveUrl(nodeCfg))}" target="_blank" rel="noopener">SERVER ↗</a>
              <a class="prx-open-link prx-open-link--prx" href="${escH(getPrxUrl(nodeCfg))}" target="_blank" rel="noopener">MONITOR ↗</a>
            </div>
          </div>
          <div class="pve-tabs" role="tablist" aria-label="Node views" data-pve-tabs="1">
            <button type="button" class="pve-tab ${activeTab === "overview" ? "pve-tab--active" : ""}" data-tab="overview">Overview</button>
            <button type="button" class="pve-tab ${activeTab === "network" ? "pve-tab--active" : ""}" data-tab="network">Network</button>
            <button type="button" class="pve-tab ${activeTab === "guests" ? "pve-tab--active" : ""}" data-tab="guests">VMs &amp; LXCs</button>
            <button type="button" class="pve-tab ${activeTab === "storage" ? "pve-tab--active" : ""}" data-tab="storage">Storage</button>
            <button type="button" class="pve-tab ${activeTab === "hardware" ? "pve-tab--active" : ""}" data-tab="hardware">Hardware</button>
            <button type="button" class="pve-tab ${activeTab === "security" ? "pve-tab--active" : ""}" data-tab="security">Security</button>
          </div>
        </div>

        <div class="pve-body">
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
        ` : activeTab === "network" ? buildNetworkTab(nodeCfg, pveData, glancesData, rrdData)
          : activeTab === "guests" ? buildGuestsTab(nodeCfg, pveData)
          : activeTab === "storage" ? buildStorageTab(nodeCfg, pveData, glancesData)
          : activeTab === "hardware" ? buildHardwareTab(nodeCfg)
          : activeTab === "security" ? buildSecurityTab(nodeCfg)
          : buildOverviewTab({
              nodeCfg,
              hist: _history[nodeCfg.groupName] || { cpu: [], mem: [], rx: [], tx: [] },
              liveCpuPct, liveCpuColor, liveMemPct, liveMemColor, liveMemUsed, liveMemTotal,
              diskPct, diskColor, diskUsed, diskTotal,
              cpuTemp, loadDisplay, loadSub, loadBarColor,
              swapDisplay, swapSub, swapColor,
              procDisplay, procSub, procColor,
              rxBytes, txBytes, ioWaitPct, ioWaitColor,
              bupPct, bupColor, bupUsed, bupTotal,
              kernelVersion, hasKernelUpdate, updateCount, updateColor, updateLabel, updates,
              topProcs,
            })}
        </div>

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
      const [status, vms, lxcs, storage, disks, updates, rrd] = await Promise.all([
        fetchPveNodeStatus(nodeCfg),
        fetchPveVMs(nodeCfg),
        fetchPveLXC(nodeCfg),
        fetchPveStorage(nodeCfg),
        fetchPveDisks(nodeCfg).catch(() => []),
        fetchPveUpdates(nodeCfg).catch(() => []),
        fetchPveRrd(nodeCfg).catch(() => _rrdCache[nodeCfg.groupName] || []),
      ]);
      pveData = { status, vms, lxcs, storage, disks, updates };
      _rrdCache[nodeCfg.groupName] = rrd;
      if (Array.isArray(disks) && disks.length) {
        await enrichPveDisksFromPrx(nodeCfg, disks).catch(() => null);
      }
    } catch (err) {
      console.warn(`[PveWidget] ${nodeCfg.label} PVE fetch failed:`, err.message);
    }

    // Warm ProxMenux network + guest update + hardware caches
    await Promise.all([
      fetchPrxNetwork(nodeCfg, { silent: true }).catch(() => null),
      fetchPrxVms(nodeCfg, { silent: true }).catch(() => null),
      fetchPrxHardware(nodeCfg, { silent: true }).catch(() => null),
      refreshLynisCache(nodeCfg, { silent: true }).catch(() => null),
    ]);

    try {
      const [cpu, mem, network, processlist, sensors, fs, load, swap, quicklook] = await Promise.all([
        fetchGlances(nodeCfg, "cpu"),
        fetchGlances(nodeCfg, "mem"),
        fetchGlances(nodeCfg, "network"),
        fetchGlances(nodeCfg, "processlist").catch(() => []),
        fetchGlances(nodeCfg, "sensors").catch(() => []),
        fetchGlances(nodeCfg, "fs").catch(() => []),
        fetchGlances(nodeCfg, "load").catch(() => null),
        fetchGlances(nodeCfg, "mem/swap").catch(() => null),
        fetchGlances(nodeCfg, "quicklook").catch(() => null),
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


    const rrdData = _rrdCache[nodeCfg.groupName] || [];
    _nodeCache[nodeCfg.groupName] = { nodeCfg, pveData, glancesData };
    // Diff guest net counters here (fresh poll only) — not during tab repaints
    updateGuestNetRates(nodeCfg.groupName, pveData);

    // Cold start: one quick resample ~2.5s later so flow labels aren't stuck on "—" / 0
    // until the normal 30s poll. Baseline from the first fetch makes this produce real rates.
    if (pveData && !_guestNetQuickSample[nodeCfg.groupName]) {
      const rates = _guestNetRates[nodeCfg.groupName] || {};
      const anyReady = Object.keys(rates).some((k) => rates[k]?.ready);
      if (!anyReady) {
        _guestNetQuickSample[nodeCfg.groupName] = true;
        setTimeout(() => {
          Promise.all([
            fetchPveVMs(nodeCfg).catch(() => null),
            fetchPveLXC(nodeCfg).catch(() => null),
          ]).then(([vms, lxcs]) => {
            const cache = _nodeCache[nodeCfg.groupName];
            if (!cache?.pveData) return;
            if (Array.isArray(vms)) cache.pveData.vms = vms;
            if (Array.isArray(lxcs)) cache.pveData.lxcs = lxcs;
            updateGuestNetRates(nodeCfg.groupName, cache.pveData);
            if ((_tabs[nodeCfg.groupName] || "overview") === "network") {
              paintNodeFromCache(nodeCfg);
            }
          }).catch(() => {});
        }, 2500);
      } else {
        _guestNetQuickSample[nodeCfg.groupName] = true;
      }
    }

    // Don't wipe the widget (or lose the active tab UI) while a modal is open
    if ((_guestModal && document.body.contains(_guestModal)) ||
        (_termModal && document.body.contains(_termModal)) ||
        (_ifaceModal && document.body.contains(_ifaceModal)) ||
        (_diskModal && document.body.contains(_diskModal)) ||
        (_gpuModal && document.body.contains(_gpuModal)) ||
        (_pciModal && document.body.contains(_pciModal)) ||
        (_gpuSwitchModal && document.body.contains(_gpuSwitchModal)) ||
        (_lynisInstallModal && document.body.contains(_lynisInstallModal))) {
      return;
    }

    const prevTab = _tabs[nodeCfg.groupName] || "overview";
    const prevScroll = host.querySelector(".pve-g-list")?.scrollTop || 0;
    applyPveShell(host, buildShell(nodeCfg, pveData, glancesData, rrdData), nodeCfg);
    _tabs[nodeCfg.groupName] = prevTab;
    bindPveTabs(host, nodeCfg);
    bindHostTerminalBtn(host, nodeCfg);
    bindGuestRows(host, nodeCfg);
    bindStorageSubTabs(host, nodeCfg);
    bindNetworkSubTabs(host, nodeCfg);
    bindHardwareSubTabs(host, nodeCfg);
    bindSecurityTab(host, nodeCfg);
    bindIfaceFlowNodes(host, nodeCfg);
    const list = host.querySelector(".pve-g-list");
    if (list && prevScroll) list.scrollTop = prevScroll;
    scheduleStaleUpdateReconcile(nodeCfg, pveData);
    scheduleGuestIpWarm(nodeCfg, pveData);
    if ((_tabs[nodeCfg.groupName] || "overview") === "security") {
      refreshLynisCache(nodeCfg, { force: false, silent: true }).then(() => {
        if ((_tabs[nodeCfg.groupName] || "overview") === "security") paintNodeFromCache(nodeCfg);
      }).catch(() => {});
    }
  }

  function paintNodeFromCache(nodeCfg) {
    if ((_guestModal && document.body.contains(_guestModal)) ||
        (_termModal && document.body.contains(_termModal)) ||
        (_ifaceModal && document.body.contains(_ifaceModal)) ||
        (_diskModal && document.body.contains(_diskModal)) ||
        (_gpuModal && document.body.contains(_gpuModal)) ||
        (_pciModal && document.body.contains(_pciModal)) ||
        (_gpuSwitchModal && document.body.contains(_gpuSwitchModal)) ||
        (_lynisInstallModal && document.body.contains(_lynisInstallModal))) {
      return;
    }
    const group = findGroupContainer(nodeCfg.groupName);
    if (!group) return;
    const host = ensureHost(group);
    const cache = _nodeCache[nodeCfg.groupName];
    if (!cache) {
      renderNode(nodeCfg);
      return;
    }
    const prevScroll = host.querySelector(".pve-g-list")?.scrollTop || 0;
    applyPveShell(host, buildShell(nodeCfg, cache.pveData, cache.glancesData, _rrdCache[nodeCfg.groupName] || []), nodeCfg);
    bindPveTabs(host, nodeCfg);
    bindHostTerminalBtn(host, nodeCfg);
    bindGuestRows(host, nodeCfg);
    bindStorageSubTabs(host, nodeCfg);
    bindNetworkSubTabs(host, nodeCfg);
    bindHardwareSubTabs(host, nodeCfg);
    bindSecurityTab(host, nodeCfg);
    bindIfaceFlowNodes(host, nodeCfg);
    const list = host.querySelector(".pve-g-list");
    if (list && prevScroll) list.scrollTop = prevScroll;
    scheduleGuestIpWarm(nodeCfg, cache.pveData);
  }

  /** Keep the tab bar DOM stable — only swap header stats + body/footer. */
  function applyPveShell(host, html, nodeCfg) {
    const activeTab = _tabs[nodeCfg.groupName] || "overview";
    const existing = host.querySelector(".pve-shell");
    const keepTabs = existing?.querySelector(".pve-tabs");
    if (!existing || !keepTabs) {
      host.innerHTML = html;
      return;
    }

    const tmp = document.createElement("div");
    tmp.innerHTML = String(html || "").trim();
    const next = tmp.querySelector(".pve-shell") || tmp.firstElementChild;
    if (!next) {
      host.innerHTML = html;
      return;
    }

    const nextTop = next.querySelector(".pve-header-top");
    const curTop = existing.querySelector(".pve-header-top");
    if (curTop && nextTop) curTop.innerHTML = nextTop.innerHTML;

    existing.querySelectorAll(".pve-tab").forEach((btn) => {
      const tab = btn.getAttribute("data-tab");
      btn.classList.toggle("pve-tab--active", tab === activeTab);
    });

    // If tab set changed (e.g. Storage added), refresh tab buttons once
    const nextTabs = next.querySelector(".pve-tabs");
    const curTabs = existing.querySelector(".pve-tabs");
    if (curTabs && nextTabs) {
      const curKeys = [...curTabs.querySelectorAll(".pve-tab")].map((b) => b.getAttribute("data-tab")).join(",");
      const nextKeys = [...nextTabs.querySelectorAll(".pve-tab")].map((b) => b.getAttribute("data-tab")).join(",");
      if (curKeys !== nextKeys) curTabs.innerHTML = nextTabs.innerHTML;
      curTabs.querySelectorAll(".pve-tab").forEach((btn) => {
        btn.__pveTabBound = false;
        btn.classList.toggle("pve-tab--active", btn.getAttribute("data-tab") === activeTab);
      });
    }

    const nextBody = next.querySelector(".pve-body");
    let curBody = existing.querySelector(".pve-body");
    if (nextBody) {
      if (curBody) curBody.innerHTML = nextBody.innerHTML;
      else {
        const hdr = existing.querySelector(".pve-header");
        curBody = document.createElement("div");
        curBody.className = "pve-body";
        curBody.innerHTML = nextBody.innerHTML;
        if (hdr?.nextSibling) existing.insertBefore(curBody, hdr.nextSibling);
        else existing.appendChild(curBody);
      }
    }

    const nextFooter = next.querySelector(".pve-footer");
    const curFooter = existing.querySelector(".pve-footer");
    if (nextFooter && curFooter) curFooter.replaceWith(nextFooter);
    else if (nextFooter && !curFooter) existing.appendChild(nextFooter);
  }

  function bindPveTabs(host, nodeCfg) {
    host.querySelectorAll(".pve-tab").forEach(btn => {
      if (btn.__pveTabBound) return;
      btn.__pveTabBound = true;
      btn.addEventListener("click", () => {
        const next = btn.getAttribute("data-tab") || "overview";
        if (_tabs[nodeCfg.groupName] === next) return;
        _tabs[nodeCfg.groupName] = next;
        paintNodeFromCache(nodeCfg);
        if (next === "security") {
          refreshLynisCache(nodeCfg, { force: true, silent: true }).then(() => {
            if ((_tabs[nodeCfg.groupName] || "overview") === "security") paintNodeFromCache(nodeCfg);
          }).catch(() => {});
        }
      });
    });
  }

  function bindHostTerminalBtn(host, nodeCfg) {
    host.querySelectorAll("[data-host-term]").forEach((btn) => {
      if (btn.__pveHostTermBound) return;
      btn.__pveHostTermBound = true;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openHostTerminal(nodeCfg);
      });
    });
  }

  function bindNetworkSubTabs(host, nodeCfg) {
    host.querySelectorAll("[data-net-sub]").forEach((btn) => {
      if (btn.__pveNetSubBound) return;
      btn.__pveNetSubBound = true;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const next = btn.getAttribute("data-net-sub") || "flow";
        if (_networkSubTabs[nodeCfg.groupName] === next) return;
        _networkSubTabs[nodeCfg.groupName] = next;
        paintNodeFromCache(nodeCfg);
      });
    });

    host.querySelectorAll("[data-iface-open]").forEach((btn) => {
      if (btn.__pveIfaceOpenBound) return;
      btn.__pveIfaceOpenBound = true;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openIfaceDetails(nodeCfg, {
          kind: btn.getAttribute("data-kind") || "bridge",
          iface: btn.getAttribute("data-iface") || "",
        });
      });
    });
  }

  function closeGpuSwitchRunner() {
    if (_gpuSwitchModal?.__ws) {
      try { _gpuSwitchModal.__ws.close(); } catch {}
      _gpuSwitchModal.__ws = null;
    }
    if (_gpuSwitchModal) {
      _gpuSwitchModal.remove();
      _gpuSwitchModal = null;
    }
  }

  function prxScriptWsUrl(prxUrl, sessionId, ticket) {
    const u = String(prxUrl || "").replace(/\/$/, "");
    const wsProto = u.startsWith("https") ? "wss" : "ws";
    const host = u.replace(/^https?:\/\//, "");
    const base = `${wsProto}://${host}/ws/script/${encodeURIComponent(sessionId)}`;
    return ticket ? `${base}?ticket=${encodeURIComponent(ticket)}` : base;
  }

  async function fetchPrxTerminalTicket(nodeCfg) {
    return issuePrxTerminalTicket(nodeCfg, { silent: false });
  }

  function appendGpuSwitchLog(modal, text, cls = "") {
    const log = modal.querySelector("[data-gpu-sw-log]");
    if (!log) return;
    const line = document.createElement("div");
    if (cls) line.className = cls;
    line.textContent = text;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }

  function showGpuSwitchInteraction(modal, interaction, ws) {
    const box = modal.querySelector("[data-gpu-sw-prompt]");
    if (!box) return;
    box.hidden = false;
    const opts = Array.isArray(interaction.options) ? interaction.options : ["yes", "no"];
    box.innerHTML = `
      <div class="pve-hw-swrun-prompt-title">${escH(interaction.title || "Confirm")}</div>
      <div class="pve-hw-swrun-prompt-msg">${escH(interaction.message || "")}</div>
      <div class="pve-hw-swrun-prompt-actions">
        ${opts.map((o) => `<button type="button" class="pve-hw-gpu-sw-btn pve-hw-gpu-sw-btn--ghost" data-gpu-sw-answer="${escH(String(o))}">${escH(String(o))}</button>`).join("")}
      </div>`;
    box.querySelectorAll("[data-gpu-sw-answer]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const value = btn.getAttribute("data-gpu-sw-answer") || "";
        try {
          ws.send(JSON.stringify({ type: "interaction_response", id: interaction.id, value }));
        } catch {}
        box.hidden = true;
        box.innerHTML = "";
      });
    });
  }

  async function runGpuSwitchScript(nodeCfg, gpu, targetMode) {
    closeGpuSwitchRunner();
    const slot = String(gpu.slot || "");
    const title = `GPU Switch Mode → ${String(targetMode || "").toUpperCase()}`;
    const desc = `Switching GPU ${slot} to ${targetMode === "vm" ? "VM (VFIO passthrough)" : "LXC (native driver)"} mode...`;

    const backdrop = document.createElement("div");
    backdrop.className = "pve-hw-swrun-backdrop";
    backdrop.innerHTML = `
      <div class="pve-hw-swrun-modal" role="dialog" aria-modal="true">
        <div class="pve-hw-swrun-hdr">
          <div>
            <div class="pve-hw-swrun-title">${escH(title)}</div>
            <div class="pve-hw-swrun-sub">${escH(desc)}</div>
          </div>
          <button type="button" class="pve-hw-gpu-close" data-gpu-sw-close aria-label="Close">×</button>
        </div>
        <div class="pve-hw-swrun-status" data-gpu-sw-status>Connecting…</div>
        <div class="pve-hw-swrun-log" data-gpu-sw-log></div>
        <div class="pve-hw-swrun-prompt" data-gpu-sw-prompt hidden></div>
        <div class="pve-hw-swrun-ftr">
          <button type="button" class="pve-hw-gpu-sw-btn pve-hw-gpu-sw-btn--ghost" data-gpu-sw-close>Close</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    _gpuSwitchModal = backdrop;
    backdrop.querySelectorAll("[data-gpu-sw-close]").forEach((btn) => {
      btn.addEventListener("click", () => {
        closeGpuSwitchRunner();
        fetchPrxHardware(nodeCfg, { force: true, silent: true }).catch(() => null).then(() => paintNodeFromCache(nodeCfg));
      });
    });

    const statusEl = backdrop.querySelector("[data-gpu-sw-status]");
    try {
      const ticket = await fetchPrxTerminalTicket(nodeCfg);
      const sessionId = Math.random().toString(36).slice(2, 8);
      const wsUrl = prxScriptWsUrl(getPrxUrl(nodeCfg), sessionId, ticket);
      const ws = new WebSocket(wsUrl);
      backdrop.__ws = ws;
      statusEl.textContent = "Connected — starting switch…";

      ws.onopen = () => {
        ws.send(JSON.stringify({
          script_path: "/usr/local/share/proxmenux/scripts/gpu_tpu/switch_gpu_mode_direct.sh",
          params: {
            EXECUTION_MODE: "web",
            GPU_SWITCH_PARAMS: `${slot}|${targetMode}`,
          },
        }));
        appendGpuSwitchLog(backdrop, `Running switch_gpu_mode_direct → ${targetMode}`, "is-meta");
      };
      ws.onmessage = (ev) => {
        const raw = String(ev.data || "");
        if (raw === '{"type": "pong"}' || raw === '{"type":"pong"}') return;
        try {
          const msg = JSON.parse(raw);
          if (msg?.type === "web_interaction" && msg.interaction) {
            showGpuSwitchInteraction(backdrop, msg.interaction, ws);
            return;
          }
          if (msg?.type === "error") {
            appendGpuSwitchLog(backdrop, msg.message || "Error", "is-err");
            statusEl.textContent = "Failed";
            return;
          }
        } catch {}
        appendGpuSwitchLog(backdrop, raw.replace(/\x1b\[[0-9;]*m/g, ""));
      };
      ws.onerror = () => {
        statusEl.textContent = "Connection error";
        appendGpuSwitchLog(backdrop, "WebSocket error", "is-err");
      };
      ws.onclose = () => {
        statusEl.textContent = "Finished";
        appendGpuSwitchLog(backdrop, "Connection closed", "is-meta");
        const ui = gpuSwitchUi(nodeCfg.groupName);
        ui.editingSlot = null;
        delete ui.pending[slot];
        fetchPrxHardware(nodeCfg, { force: true, silent: true }).catch(() => null).then(() => {
          if (_gpuSwitchModal === backdrop) return; // keep modal open; refresh after close
        });
      };
    } catch (err) {
      statusEl.textContent = "Failed to start";
      appendGpuSwitchLog(backdrop, err.message || String(err), "is-err");
    }
  }

  function bindHardwareSubTabs(host, nodeCfg) {
    host.querySelectorAll("[data-hw-sub]").forEach((btn) => {
      if (btn.__pveHwSubBound) return;
      btn.__pveHwSubBound = true;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const next = btn.getAttribute("data-hw-sub") || "thermal";
        if (_hardwareSubTabs[nodeCfg.groupName] === next) return;
        _hardwareSubTabs[nodeCfg.groupName] = next;
        paintNodeFromCache(nodeCfg);
      });
    });

    host.querySelectorAll("[data-gpu-slot]").forEach((btn) => {
      if (btn.__pveGpuBound) return;
      btn.__pveGpuBound = true;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const slot = btn.getAttribute("data-gpu-slot");
        if (slot) openGpuDetails(nodeCfg, slot);
      });
    });

    const ui = gpuSwitchUi(nodeCfg.groupName);
    const hw = _prxHwCache[nodeCfg.groupName]?.data;
    const findGpu = (slot) => (hw?.gpus || []).find((g) => String(g.slot) === String(slot));

    host.querySelectorAll("[data-gpu-sw-edit]").forEach((btn) => {
      if (btn.__pveGpuSwBound) return;
      btn.__pveGpuSwBound = true;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const slot = btn.getAttribute("data-gpu-sw-edit");
        ui.editingSlot = slot;
        if (slot && ui.pending[slot] == null) {
          // start edit with current mode selected (hub amber); first hub click flips
          delete ui.pending[slot];
        }
        paintNodeFromCache(nodeCfg);
      });
    });

    host.querySelectorAll("[data-gpu-sw-cancel]").forEach((btn) => {
      if (btn.__pveGpuSwBound) return;
      btn.__pveGpuSwBound = true;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const slot = btn.getAttribute("data-gpu-sw-cancel");
        ui.editingSlot = null;
        if (slot) delete ui.pending[slot];
        paintNodeFromCache(nodeCfg);
      });
    });

    host.querySelectorAll("[data-gpu-sw-hub]").forEach((hub) => {
      if (hub.__pveGpuSwBound) return;
      hub.__pveGpuSwBound = true;
      hub.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const slot = hub.getAttribute("data-gpu-sw-hub");
        const gpu = findGpu(slot);
        if (!gpu || ui.editingSlot !== slot) return;
        const actual = gpuActualMode(gpu);
        if (actual === "sriov" || actual === "unknown") return;
        const current = ui.pending[slot] || actual;
        const next = current === "lxc" ? "vm" : "lxc";
        if (next === actual) delete ui.pending[slot];
        else ui.pending[slot] = next;
        paintNodeFromCache(nodeCfg);
      });
    });

    host.querySelectorAll("[data-gpu-sw-save]").forEach((btn) => {
      if (btn.__pveGpuSwBound) return;
      btn.__pveGpuSwBound = true;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const slot = btn.getAttribute("data-gpu-sw-save");
        const gpu = findGpu(slot);
        if (!gpu) return;
        const actual = gpuActualMode(gpu);
        const target = ui.pending[slot] || actual;
        ui.editingSlot = null;
        if (!ui.pending[slot] || target === actual) {
          delete ui.pending[slot];
          paintNodeFromCache(nodeCfg);
          return;
        }
        runGpuSwitchScript(nodeCfg, gpu, target);
      });
    });

    host.querySelectorAll("[data-pci-slot]").forEach((btn) => {
      if (btn.__pvePciBound) return;
      btn.__pvePciBound = true;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const slot = btn.getAttribute("data-pci-slot");
        if (slot) openPciDetails(nodeCfg, slot);
      });
    });
  }

  function bindStorageSubTabs(host, nodeCfg) {
    host.querySelectorAll("[data-st-sub]").forEach((btn) => {
      if (btn.__pveStSubBound) return;
      btn.__pveStSubBound = true;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const next = btn.getAttribute("data-st-sub") || "pve";
        if (_storageSubTabs[nodeCfg.groupName] === next) return;
        _storageSubTabs[nodeCfg.groupName] = next;
        paintNodeFromCache(nodeCfg);
      });
    });

    host.querySelectorAll("[data-disk-open]").forEach((btn) => {
      if (btn.__pveDiskBound) return;
      btn.__pveDiskBound = true;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const path = btn.getAttribute("data-disk-open");
        if (path) openDiskDetails(nodeCfg, path);
      });
    });
  }

  function bindGuestRows(host, nodeCfg) {
    host.querySelectorAll(".pve-g-row[data-vmid]").forEach(row => {
      const open = () => {
        const vmid = row.getAttribute("data-vmid");
        const type = row.getAttribute("data-gtype") || "lxc";
        openGuestController(nodeCfg, type, vmid);
      };
      row.addEventListener("click", open);
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
      });
    });

    const bulkBtn = host.querySelector("[data-bulk-recheck]");
    if (bulkBtn && !bulkBtn.__pveBound) {
      bulkBtn.__pveBound = true;
      const labelEl = bulkBtn.querySelector("[data-bulk-recheck-label]") || bulkBtn;
      const idleLabel = "Recheck updates";
      bulkBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (bulkBtn.disabled) return;
        bulkBtn.disabled = true;
        bulkBtn.classList.add("pve-g-bulk-recheck--busy");
        try {
          await runBulkGuestUpdateRecheck(nodeCfg, {
            onProgress: ({ label, total }) => {
              labelEl.textContent = total ? `Checking ${label}` : (label || idleLabel);
            },
          });
          labelEl.textContent = "Done";
          setTimeout(() => { labelEl.textContent = idleLabel; }, 1600);
        } catch (err) {
          console.warn("[PveWidget] bulk recheck failed:", err);
          labelEl.textContent = "Failed";
          setTimeout(() => { labelEl.textContent = idleLabel; }, 2200);
        } finally {
          bulkBtn.disabled = false;
          bulkBtn.classList.remove("pve-g-bulk-recheck--busy");
        }
      });
    }
  }

  function closeGuestController() {
    if (_guestModal) {
      _guestModal.remove();
      _guestModal = null;
    }
    document.removeEventListener("keydown", _guestEscHandler, true);
  }

  function _guestEscHandler(e) {
    if (e.key !== "Escape") return;
    if (_termModal && document.body.contains(_termModal)) return; // terminal owns Escape
    closeGuestController();
  }


  function loadXterm() {
    return new Promise((resolve, reject) => {
      if (window.Terminal) return resolve(window.Terminal);
      const cssId = "pve-xterm-css";
      if (!document.getElementById(cssId)) {
        const link = document.createElement("link");
        link.id = cssId;
        link.rel = "stylesheet";
        link.href = "https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css";
        document.head.appendChild(link);
      }
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js";
      script.onload = () => resolve(window.Terminal);
      script.onerror = () => reject(new Error("Failed to load xterm.js"));
      document.head.appendChild(script);
    });
  }

  function applyGuestUpdateResult(ctx, uc) {
    if (!ctx?.nodeCfg || ctx.vmid == null) return;
    const next = uc?.count > 0
      ? uc
      : { available: false, count: 0, security_count: 0, last_check: uc?.last_check || Date.now(), packages: [] };
    const modal = _guestModal?.querySelector?.(".pve-gc-modal");
    if (modal?.__pveGcCtx) {
      const g = { ...modal.__pveGcCtx.guest, update_check: next };
      modal.__pveGcCtx.guest = g;
      renderGuestController(
        modal,
        modal.__pveGcCtx.nodeCfg,
        g,
        modal.__pveGcCtx.config,
        modal.__pveGcCtx.backups,
        modal.__pveGcCtx.firewall,
        modal.__pveGcCtx.activePane || "updates",
        modal.__pveGcUi
      );
    }
    paintGuestUpdateBadges(ctx.nodeCfg);
  }

  function runGuestUpdateRefresh(ctx, { quiet = false } = {}) {
    if (!ctx?.nodeCfg || ctx.vmid == null) return Promise.resolve(null);
    if (ctx.refreshInFlight) return ctx.refreshInFlight;
    if (ctx.setStatus) ctx.setStatus("checking updates…", true);
    ctx.refreshInFlight = refreshGuestUpdateStatus(ctx.nodeCfg, ctx.type || "lxc", ctx.vmid)
      .then((uc) => {
        applyGuestUpdateResult(ctx, uc);
        if (ctx.term && !quiet) {
          const msg = uc?.count > 0
            ? `[homepage] ${uc.count} update(s) still pending`
            : "[homepage] no pending package updates";
          try { ctx.term.writeln(`\r\n\x1b[90m${msg}\x1b[0m`); } catch {}
        }
        if (ctx.setStatus && _termModal) ctx.setStatus("online", true);
        return uc;
      })
      .catch((err) => {
        if (ctx.setStatus && _termModal) ctx.setStatus("online", true);
        if (ctx.term && !quiet) {
          try { ctx.term.writeln(`\r\n\x1b[33m[homepage] update check failed: ${err.message || err}\x1b[0m`); } catch {}
        }
        return null;
      })
      .finally(() => { ctx.refreshInFlight = null; });
    return ctx.refreshInFlight;
  }

  /** Watch terminal stream; after apt upgrade settles, refresh badges automatically. */
  function noteTerminalAptActivity(raw) {
    const ctx = _termGuestCtx;
    if (!ctx) return;
    const clean = String(raw || "").replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
    if (!clean) return;
    const interesting =
      /\bapt(?:-get)?\s+(?:dist-|full-)?upgrade\b/i.test(clean) ||
      /\d+\s+upgraded,/i.test(clean) ||
      /\bProcessing triggers\b/i.test(clean) ||
      /\bSetting up\b/i.test(clean) ||
      /\bUnpacking\b/i.test(clean);
    if (!interesting) return;
    ctx.sawPackageChange = true;
    clearTimeout(ctx.autoRecheckTimer);
    ctx.autoRecheckTimer = setTimeout(() => {
      if (_termGuestCtx !== ctx) return;
      runGuestUpdateRefresh(ctx);
    }, 4000);
  }

  function closeGuestTerminal(opts = {}) {
    const skipRefresh = !!opts.skipRefresh;
    const ctx = _termGuestCtx;
    _termGuestCtx = null;
    if (ctx?.autoRecheckTimer) clearTimeout(ctx.autoRecheckTimer);
    if (_termModal) {
      try { _termModal.__pveTermCleanup?.(); } catch {}
      _termModal.remove();
      _termModal = null;
    }
    // Always live-recheck this guest when the terminal closes (covers upgrades).
    if (!skipRefresh && ctx?.nodeCfg && ctx.vmid != null) {
      runGuestUpdateRefresh(ctx, { quiet: true });
    }
  }

  // Per-node browser keys — each ProxMenux MONITOR has its own API token.
  const PRX_AUTH_LS_PREFIX = "hp-prx-auth:node:";
  const PRX_AUTH_LS_SHARED_LEGACY = "hp-prx-auth:v2"; // old single-token key (do not reuse)

  function prxNodeAuthId(nodeCfg) {
    return String(nodeCfg?.groupName || nodeCfg?.pveNode || nodeCfg?.label || "").trim();
  }

  function prxAuthStorageKey(nodeCfg) {
    const id = prxNodeAuthId(nodeCfg);
    return id ? `${PRX_AUTH_LS_PREFIX}${id}` : PRX_AUTH_LS_SHARED_LEGACY;
  }

  function prxUrlKey(prxUrl) {
    return String(prxUrl || "").replace(/\/$/, "");
  }

  /** Legacy URL-keyed entries for this node only (pre per-node / pre local-first). */
  function prxLegacyAuthKeys(nodeCfg) {
    const keys = [];
    const add = (u) => {
      const v = prxUrlKey(u);
      if (v) keys.push(`hp-prx-auth:${v}`);
    };
    add(nodeCfg?.prxUrl);
    add(nodeCfg?.prxFallbackUrl);
    add(nodeCfg?.activePrxUrl);
    return [...new Set(keys)];
  }

  /** JWT exp (unix seconds), or 0 if unreadable. */
  function jwtExpUnix(token) {
    try {
      const part = String(token || "").split(".")[1];
      if (!part) return 0;
      const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
      const json = JSON.parse(atob(b64));
      return Number(json?.exp) || 0;
    } catch {
      return 0;
    }
  }

  /** True when JWT is missing exp or still valid (60s skew). */
  function isPrxTokenUsable(token) {
    const t = String(token || "").trim();
    if (!t || t.split(".").length < 2) return false;
    const exp = jwtExpUnix(t);
    if (!exp) return true; // non-expiring / opaque — allow
    return exp * 1000 > Date.now() - 60_000;
  }

  /** Prefer later-expiring usable token; never return an expired JWT. */
  function pickFresherPrxToken(a, b) {
    const ta = isPrxTokenUsable(a) ? String(a).trim() : "";
    const tb = isPrxTokenUsable(b) ? String(b).trim() : "";
    if (!ta) return tb;
    if (!tb) return ta;
    return jwtExpUnix(ta) >= jwtExpUnix(tb) ? ta : tb;
  }

  function readPrxTokenFromLs(nodeCfg) {
    const candidates = [];
    const primaryKey = prxAuthStorageKey(nodeCfg);
    try {
      const primary = localStorage.getItem(primaryKey) || "";
      if (primary) candidates.push(primary);
    } catch {}
    try {
      for (const key of prxLegacyAuthKeys(nodeCfg)) {
        const v = localStorage.getItem(key) || "";
        if (v) candidates.push(v);
      }
    } catch {}
    let best = "";
    candidates.forEach((t) => { best = pickFresherPrxToken(best, t); });
    // Promote this node's legacy/URL-keyed token onto the per-node stable key.
    if (best) {
      try {
        const cur = localStorage.getItem(primaryKey) || "";
        if (cur !== best) localStorage.setItem(primaryKey, best);
      } catch {}
    }
    return best;
  }

  /**
   * Resolve MONITOR bearer token for one node.
   * Priority: this node's localStorage → this node's in-memory/baked prxToken.
   * Tokens are NEVER shared across nodes — each MONITOR issues its own API key.
   */
  function getStoredPrxToken(nodeCfg) {
    const fromLs = readPrxTokenFromLs(nodeCfg);
    const fromCfg = nodeCfg?.prxToken ? String(nodeCfg.prxToken) : "";
    return pickFresherPrxToken(fromLs, fromCfg);
  }

  /** Persist token for this browser + this node only. */
  function rememberPrxToken(nodeCfg, token) {
    const t = String(token || "").trim().replace(/^["']|["']$/g, "");
    if (!t || !nodeCfg) return;
    if (!isPrxTokenUsable(t)) {
      console.warn("[PveWidget] Refusing to store expired ProxMenux token");
      return;
    }
    nodeCfg.prxToken = t;
    const primaryKey = prxAuthStorageKey(nodeCfg);
    try {
      localStorage.setItem(primaryKey, t);
      // Keep this node's legacy URL keys in sync (not other nodes').
      prxLegacyAuthKeys(nodeCfg).forEach((key) => {
        try { localStorage.setItem(key, t); } catch {}
      });
    } catch {}
  }

  function clearStoredPrxToken(nodeCfg) {
    if (nodeCfg) nodeCfg.prxToken = "";
    try {
      if (nodeCfg) {
        localStorage.removeItem(prxAuthStorageKey(nodeCfg));
        prxLegacyAuthKeys(nodeCfg).forEach((key) => {
          try { localStorage.removeItem(key); } catch {}
        });
      } else {
        PVE_NODES.forEach((n) => {
          n.prxToken = "";
          try { localStorage.removeItem(prxAuthStorageKey(n)); } catch {}
          prxLegacyAuthKeys(n).forEach((key) => {
            try { localStorage.removeItem(key); } catch {}
          });
        });
        try { localStorage.removeItem(PRX_AUTH_LS_SHARED_LEGACY); } catch {}
      }
    } catch {}
  }

  function prxWsBase(prxUrl) {
    const u = String(prxUrl || "").replace(/\/$/, "");
    const wsProto = u.startsWith("https") ? "wss" : "ws";
    const host = u.replace(/^https?:\/\//, "");
    return `${wsProto}://${host}/ws/terminal`;
  }


  /** JWT iat (unix seconds), or 0 if unreadable. */
  function jwtIatUnix(token) {
    try {
      const part = String(token || "").split(".")[1];
      if (!part) return 0;
      const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
      const json = JSON.parse(atob(b64));
      return Number(json?.iat) || 0;
    } catch {
      return 0;
    }
  }

  /** Session login JWTs are ~24h; API Access Tokens are ~365d. */
  function isShortLivedPrxSessionToken(token) {
    const exp = jwtExpUnix(token);
    const iat = jwtIatUnix(token);
    if (!exp || !iat) return false;
    return (exp - iat) <= 48 * 3600;
  }

  function promptPrxTokenGuide(nodeCfg, opts = {}) {
    const rejected = !!opts.rejected;
    const monitorUrl = String(getPrxUrl(nodeCfg) || "").replace(/\/$/, "");
    const nodeLabel = escH(nodeCfg?.label || nodeCfg?.pveNode || nodeCfg?.groupName || "this node");
    return new Promise((resolve) => {
      const wrap = document.createElement("div");
      wrap.className = "pve-prx-guide-backdrop";
      wrap.innerHTML = `
        <div class="pve-prx-guide" role="dialog" aria-modal="true" aria-labelledby="pve-prx-guide-title">
          <div class="pve-prx-guide-hdr">
            <div>
              <div class="pve-prx-guide-kicker">ProxMenux Monitor · ${nodeLabel}</div>
              <h3 id="pve-prx-guide-title">${rejected ? `API token needed for ${nodeLabel}` : `Add API token for ${nodeLabel}`}</h3>
            </div>
            <button type="button" class="pve-prx-guide-x" data-prx-cancel aria-label="Close">×</button>
          </div>
          <p class="pve-prx-guide-lead">
            Each Proxmox node has its own MONITOR. Paste the <strong>365-day API Access Token</strong>
            generated on <strong>${nodeLabel}</strong> only — it is stored per node and will not overwrite other servers.
          </p>
          <ol class="pve-prx-guide-steps">
            <li>
              <span class="pve-prx-guide-num">1</span>
              <div>
                <strong>Open MONITOR</strong>
                <div class="pve-prx-guide-sub">
                  ${monitorUrl
                    ? `<a href="${escH(monitorUrl)}" target="_blank" rel="noopener">${escH(monitorUrl.replace(/^https?:\/\//, ""))} ↗</a>`
                    : "Use the MONITOR button on this node"}
                  and sign in.
                </div>
              </div>
            </li>
            <li>
              <span class="pve-prx-guide-num">2</span>
              <div>
                <strong>Settings → API Access Tokens</strong>
                <div class="pve-prx-guide-sub">
                  Enter your MONITOR password (and 2FA if enabled), name it e.g.
                  <em>Homepage</em>, then click <strong>Generate Token</strong>.
                </div>
              </div>
            </li>
            <li>
              <span class="pve-prx-guide-num">3</span>
              <div>
                <strong>Copy the token immediately</strong>
                <div class="pve-prx-guide-sub">
                  It is shown once. It should start with <code>eyJ…</code> and last about <strong>365 days</strong>.
                  Do <em>not</em> use <code>localStorage.getItem('proxmenux-auth-token')</code> — that is a 24-hour login session.
                </div>
              </div>
            </li>
            <li>
              <span class="pve-prx-guide-num">4</span>
              <div>
                <strong>Paste it below</strong>
                <textarea class="pve-prx-guide-input" data-prx-input rows="3" spellcheck="false" placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9… (API Access Token)"></textarea>
                <div class="pve-prx-guide-sub" data-prx-warn hidden style="color:#fb923c;margin-top:8px;"></div>
              </div>
            </li>
          </ol>
          <div class="pve-prx-guide-ftr">
            <button type="button" class="pve-prx-guide-btn pve-prx-guide-btn--ghost" data-prx-cancel>Cancel</button>
            <button type="button" class="pve-prx-guide-btn pve-prx-guide-btn--ok" data-prx-ok>Save &amp; connect</button>
          </div>
        </div>`;
      document.body.appendChild(wrap);

      const input = wrap.querySelector("[data-prx-input]");
      const warn = wrap.querySelector("[data-prx-warn]");
      const updateWarn = () => {
        if (!warn) return;
        const v = (input?.value || "").trim().replace(/^["']|["']$/g, "");
        if (v && isShortLivedPrxSessionToken(v)) {
          warn.hidden = false;
          warn.textContent = "This looks like a ~24h session JWT. Generate an API Access Token in Settings instead (365 days).";
        } else {
          warn.hidden = true;
          warn.textContent = "";
        }
      };
      input?.addEventListener("input", updateWarn);

      const onKey = (e) => {
        if (e.key === "Escape") { e.stopPropagation(); finish(null); }
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          submit();
        }
      };
      const finish = (val) => {
        document.removeEventListener("keydown", onKey, true);
        wrap.remove();
        resolve(val);
      };
      const submit = () => {
        const v = (input?.value || "").trim().replace(/^["']|["']$/g, "");
        if (v && isShortLivedPrxSessionToken(v)) {
          updateWarn();
          const ok = window.confirm(
            "This token looks like a short-lived MONITOR session (~24h).\n\n" +
            "Recommended: Settings → API Access Tokens → Generate Token (365 days).\n\n" +
            "Save this session token anyway?"
          );
          if (!ok) return;
        }
        finish(v || null);
      };

      document.addEventListener("keydown", onKey, true);
      wrap.querySelectorAll("[data-prx-cancel]").forEach(btn => btn.addEventListener("click", () => finish(null)));
      wrap.addEventListener("click", (e) => { if (e.target === wrap) finish(null); });
      wrap.querySelector("[data-prx-ok]")?.addEventListener("click", submit);
      setTimeout(() => input?.focus(), 50);
    });
  }

  async function connectProxmenuxShell(nodeCfg, vmid, term, hooks) {
    const { setStatus, showError, cleanupFns, onWs } = hooks;
    if (!prxTargets(nodeCfg).length) return false;

    let ticket = null;
    try {
      ticket = await issuePrxTerminalTicket(nodeCfg, { silent: false });
    } catch (err) {
      if (/token|unavailable|ticket/i.test(String(err?.message || err))) {
        showError(err.message || String(err));
        return true;
      }
      return false;
    }

    let wsUrl = prxWsBase(getPrxUrl(nodeCfg));
    if (ticket) wsUrl += `?ticket=${encodeURIComponent(ticket)}`;

    const id = Number(vmid);
    if (!Number.isInteger(id) || id <= 0) {
      showError("Invalid VMID");
      return true; // handled
    }

    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      showError(`ProxMenux WS failed (${err.message || err})`);
      return true;
    }
    onWs(ws);
    cleanupFns.push(() => { try { ws.close(); } catch {} });

    let sawOutput = false;
    let enteredGuest = false;
    let hostName = null;
    let buffer = "";

    const stripAnsi = (str) => String(str).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");

    ws.onopen = () => {
      setStatus("online", true);
      const ping = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.send(JSON.stringify({ type: "ping" })); } catch {}
        }
      }, 25000);
      cleanupFns.push(() => clearInterval(ping));

      // Match ProxMenux: enter the LXC via host shell
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(`pct enter ${id}\r`);
      }, 300);
    };

    ws.onmessage = (ev) => {
      const raw = typeof ev.data === "string" ? ev.data : "";
      if (!raw) return;
      if (raw === '{"type": "pong"}' || raw === '{"type":"pong"}') return;
      sawOutput = true;

      if (!enteredGuest) {
        buffer += raw;
        const clean = stripAnsi(buffer);
        const pctMatch = clean.match(/pct enter (\d+)\r?\n/);
        if (pctMatch) {
          const hostPrompt = clean.match(/@([\p{L}\p{N}._-]+).*pct enter/u);
          hostName = hostPrompt ? hostPrompt[1] : null;
          const after = clean.substring(clean.indexOf(pctMatch[0]) + pctMatch[0].length);
          const promptMatch = after.match(/[@\[]([\p{L}\p{N}._-]+)[^\r\n]*[#$]\s*$/u);
          if (promptMatch) {
            const guestHost = promptMatch[1];
            if (!hostName || guestHost !== hostName) {
              enteredGuest = true;
              const afterAnsi = buffer.substring(buffer.indexOf("pct enter") + pctMatch[0].length);
              const last = afterAnsi.match(/[^\r\n]*[#$]\s*$/);
              term.clear();
              term.write(last ? last[0] : afterAnsi);
              return;
            }
          }
        }
        // still bootstrapping — keep buffering, don't spam host output
        return;
      }
      term.write(raw);
      noteTerminalAptActivity(raw);
    };

    ws.onerror = () => {
      if (!sawOutput) showError("ProxMenux terminal socket error");
      setStatus("offline", false);
    };
    ws.onclose = () => {
      setStatus("offline", false);
      if (sawOutput) term.writeln("\r\n\x1b[90mConnection closed\x1b[0m");
      else showError("ProxMenux terminal closed before ready (auth?)");
    };

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });

    setTimeout(() => {
      if (!sawOutput) {
        showError("ProxMenux terminal auth failed — paste a fresh MONITOR token");
        setStatus("offline", false);
        try { ws.close(); } catch {}
      } else if (!enteredGuest) {
        // show buffered host output so user sees what happened
        term.write(buffer);
        enteredGuest = true;
      }
    }, 5000);

    return true;
  }

  async function connectProxmenuxHostShell(nodeCfg, term, hooks) {
    const { setStatus, showError, cleanupFns, onWs } = hooks;
    if (!prxTargets(nodeCfg).length) return false;

    let ticket = null;
    try {
      ticket = await issuePrxTerminalTicket(nodeCfg, { silent: false });
    } catch (err) {
      if (/token|unavailable|ticket/i.test(String(err?.message || err))) {
        showError(err.message || String(err));
        return true;
      }
      return false;
    }

    let wsUrl = prxWsBase(getPrxUrl(nodeCfg));
    if (ticket) wsUrl += `?ticket=${encodeURIComponent(ticket)}`;

    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      showError(`ProxMenux WS failed (${err.message || err})`);
      return true;
    }
    onWs(ws);
    cleanupFns.push(() => { try { ws.close(); } catch {} });

    let sawOutput = false;
    ws.onopen = () => {
      setStatus("online", true);
      const ping = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.send(JSON.stringify({ type: "ping" })); } catch {}
        }
      }, 25000);
      cleanupFns.push(() => clearInterval(ping));
      try { ws.send(JSON.stringify({ type: "resize", cols: term.cols || 80, rows: term.rows || 24 })); } catch {}
    };
    ws.onmessage = (ev) => {
      const raw = typeof ev.data === "string" ? ev.data : "";
      if (!raw) return;
      if (raw === '{"type": "pong"}' || raw === '{"type":"pong"}') return;
      sawOutput = true;
      term.write(raw);
    };
    ws.onerror = () => {
      if (!sawOutput) showError("ProxMenux terminal socket error");
      setStatus("offline", false);
    };
    ws.onclose = () => {
      setStatus("offline", false);
      if (sawOutput) term.writeln("\r\n\x1b[90mConnection closed\x1b[0m");
      else showError("ProxMenux terminal closed before ready (auth?)");
    };
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });
    setTimeout(() => {
      if (!sawOutput) {
        showError("ProxMenux terminal auth failed — paste a fresh MONITOR token");
        setStatus("offline", false);
        try { ws.close(); } catch {}
      }
    }, 5000);
    return true;
  }

  async function connectPveNodeShell(nodeCfg, term, hooks) {
    const { setStatus, showError, cleanupFns, onWs } = hooks;
    const node = nodeCfg.pveNode;
    if (!node) return false;
    let port, ticket, user;
    try {
      const res = await fetch(`${getPveUrl(nodeCfg)}/api2/json/nodes/${encodeURIComponent(node)}/termproxy`, {
        method: "POST",
        headers: pveHeaders(nodeCfg),
      });
      if (!res.ok) {
        let errDetail = "";
        try {
          const j = await res.json();
          errDetail = j?.message || "";
        } catch {}
        throw new Error(`Error ${res.status}${errDetail ? ": " + errDetail : ""}`);
      }
      const payload = await res.json();
      const data = payload.data || payload;
      port = data.port;
      ticket = data.ticket;
      user = data.user || nodeCfg.pveUser;
      if (!port || !ticket) throw new Error("termproxy missing port/ticket");
    } catch (err) {
      showError(`Host termproxy failed (${err.message || err})`);
      setStatus("offline", false);
      return true;
    }

    const fullUser = String(user || nodeCfg.pveUser || "");
    const authUser = /!/.test(fullUser) ? fullUser.replace(/!.*$/, "") : fullUser;
    const pveBase = getPveUrl(nodeCfg);
    const wsProto = pveBase.startsWith("https") ? "wss" : "ws";
    const host = pveBase.replace(/^https?:\/\//, "").replace(/\/$/, "");
    const wsUrl = `${wsProto}://${host}/api2/json/nodes/${encodeURIComponent(node)}/vncwebsocket?port=${encodeURIComponent(port)}&vncticket=${encodeURIComponent(ticket)}`;

    let ws;
    try { ws = new WebSocket(wsUrl, "binary"); }
    catch (err) {
      showError(`Connection failed (${err.message || err})`);
      setStatus("offline", false);
      return true;
    }
    ws.binaryType = "arraybuffer";
    ws.__pveFramed = true;
    onWs(ws);
    cleanupFns.push(() => { try { ws.close(); } catch {} });

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let sawOutput = false;

    ws.onopen = () => {
      ws.send(`${authUser}:${ticket}\n`);
      try { ws.send(`1:${term.cols || 80}:${term.rows || 24}:`); } catch {}
      setStatus("online", true);
      const ping = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send("2");
      }, 30000);
      cleanupFns.push(() => clearInterval(ping));
    };
    ws.onmessage = (ev) => {
      sawOutput = true;
      setStatus("online", true);
      if (typeof ev.data === "string") {
        if (ev.data.length >= 2 && ev.data[0] === "0" && ev.data[1] === ":") {
          const payload = ev.data.slice(2);
          const i = payload.indexOf(":");
          if (i >= 0) term.write(payload.slice(i + 1));
          else term.write(payload);
        } else if (ev.data !== "2" && !ev.data.startsWith("1:")) {
          term.write(ev.data);
        }
        return;
      }
      try {
        const bytes = new Uint8Array(ev.data);
        const text = decoder.decode(bytes);
        if (text.length >= 2 && text[0] === "0" && text[1] === ":") {
          const payload = text.slice(2);
          const i = payload.indexOf(":");
          if (i >= 0) term.write(payload.slice(i + 1));
          else term.write(payload);
        } else {
          term.write(text);
        }
      } catch {
        term.write(decoder.decode(ev.data));
      }
    };
    ws.onerror = () => {
      if (!sawOutput) showError("PVE host terminal socket error");
      setStatus("offline", false);
    };
    ws.onclose = () => {
      setStatus("offline", false);
      if (sawOutput) term.writeln("\r\n\x1b[90mConnection closed\x1b[0m");
    };
    term.onData((data) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const payload = data;
      const bytes = encoder.encode(payload);
      ws.send(`0:${bytes.length}:${payload}`);
    });
    return true;
  }

  async function openHostTerminal(nodeCfg) {
    closeGuestTerminal({ skipRefresh: true });
    _termGuestCtx = { nodeCfg, type: "host", vmid: null, sawPackageChange: false };

    const shellParams = new URLSearchParams({
      console: "shell",
      xtermjs: "1",
      node: nodeCfg.pveNode,
      resize: "1",
      cmd: "",
    });
    const consoleHref = `${getPveUrl(nodeCfg)}/?${shellParams.toString()}`;

    const backdrop = document.createElement("div");
    backdrop.className = "pve-term-backdrop";
    backdrop.innerHTML = `
      <div class="pve-term-modal" role="dialog" aria-modal="true">
        <div class="pve-term-grip" title="Drag to resize" data-term-grip>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="9" r="1"/><circle cx="19" cy="9" r="1"/><circle cx="5" cy="9" r="1"/><circle cx="12" cy="15" r="1"/><circle cx="19" cy="15" r="1"/><circle cx="5" cy="15" r="1"/></svg>
        </div>
        <div class="pve-term-hdr">
          <div class="pve-term-title">Terminal: ${escH(nodeCfg.label || nodeCfg.pveNode)} <span>(host)</span></div>
          <div class="pve-term-hdr-actions">
            <button type="button" class="pve-term-btn pve-term-btn--search" data-term-search title="Search commands">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
              Search
            </button>
            <button type="button" class="pve-term-btn pve-term-btn--clear" data-term-clear title="Clear">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
              Clear
            </button>
          </div>
        </div>
        <div class="pve-term-error" data-term-error hidden></div>
        <div class="pve-term-body" data-term-mount></div>
        <div class="pve-term-ftr">
          <div class="pve-term-status" data-term-status>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/></svg>
            <span class="pve-term-dot" data-term-dot></span>
            <span data-term-status-text>connecting</span>
          </div>
          <div class="pve-term-ftr-actions">
            <a class="pve-term-btn pve-term-btn--ext" href="${escH(consoleHref)}" target="_blank" rel="noopener" data-term-ext hidden>Open in Proxmox</a>
            <button type="button" class="pve-term-btn pve-term-btn--close" data-term-close>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
              Close
            </button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    _termModal = backdrop;

    const modalEl = backdrop.querySelector(".pve-term-modal");
    const statusText = backdrop.querySelector("[data-term-status-text]");
    const statusWrap = backdrop.querySelector("[data-term-status]");
    const errorEl = backdrop.querySelector("[data-term-error]");
    const mount = backdrop.querySelector("[data-term-mount]");
    const extLink = backdrop.querySelector("[data-term-ext]");
    const setStatus = (txt, online = false) => {
      if (statusText) statusText.textContent = String(txt || "").toLowerCase();
      statusWrap?.classList.toggle("pve-term-status--online", !!online);
      statusWrap?.classList.toggle("pve-term-status--offline", !online && txt !== "connecting");
    };
    const showError = (msg) => {
      if (!errorEl) return;
      errorEl.hidden = false;
      errorEl.textContent = msg;
      if (extLink) extLink.hidden = false;
    };

    const cleanupFns = [];
    backdrop.__pveTermCleanup = () => cleanupFns.forEach(fn => { try { fn(); } catch {} });
    backdrop.querySelector("[data-term-close]")?.addEventListener("click", closeGuestTerminal);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closeGuestTerminal(); });

    const grip = backdrop.querySelector("[data-term-grip]");
    if (grip && modalEl) {
      let startY = 0, startH = 0;
      const onMove = (e) => {
        const y = e.touches ? e.touches[0].clientY : e.clientY;
        modalEl.style.height = `${Math.max(320, Math.min(window.innerHeight - 40, startH + (startY - y)))}px`;
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.removeEventListener("touchmove", onMove);
        document.removeEventListener("touchend", onUp);
      };
      const onDown = (e) => {
        e.preventDefault();
        startY = e.touches ? e.touches[0].clientY : e.clientY;
        startH = modalEl.getBoundingClientRect().height;
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
        document.addEventListener("touchmove", onMove, { passive: false });
        document.addEventListener("touchend", onUp);
      };
      grip.addEventListener("mousedown", onDown);
      grip.addEventListener("touchstart", onDown, { passive: false });
    }

    const esc = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); closeGuestTerminal(); }
    };
    document.addEventListener("keydown", esc, true);
    cleanupFns.push(() => document.removeEventListener("keydown", esc, true));

    let term = null;
    let activeWs = null;
    try {
      const Terminal = await loadXterm();
      const fontSize = window.innerWidth < 768 ? 12 : 15;
      term = new Terminal({
        cursorBlink: true,
        fontSize,
        fontFamily: '"MesloLGS NF", "FiraCode Nerd Font", "JetBrainsMono Nerd Font", "Hack Nerd Font", ui-monospace, Menlo, Consolas, monospace',
        fontWeight: "500",
        fontWeightBold: "700",
        scrollback: 2000,
        convertEol: true,
        theme: {
          background: "#000000",
          foreground: "#ffffff",
          cursor: "#ffffff",
          cursorAccent: "#000000",
          selectionBackground: "#4d4d4d",
          black: "#2e3436", red: "#cc0000", green: "#4e9a06", yellow: "#c4a000",
          blue: "#3465a4", magenta: "#75507b", cyan: "#06989a", white: "#d3d7cf",
          brightBlack: "#555753", brightRed: "#ef2929", brightGreen: "#8ae234", brightYellow: "#fce94f",
          brightBlue: "#729fcf", brightMagenta: "#ad7fa8", brightCyan: "#34e2e2", brightWhite: "#eeeeec",
        },
      });
      term.open(mount);
      term.focus();
      if (_termGuestCtx) {
        _termGuestCtx.term = term;
        _termGuestCtx.setStatus = setStatus;
        _termGuestCtx.type = "host";
      }
      cleanupFns.push(() => { try { term.dispose(); } catch {} });
      backdrop.querySelector("[data-term-clear]")?.addEventListener("click", () => term.clear());
      backdrop.querySelector("[data-term-search]")?.addEventListener("click", () => {
        const q = prompt("Inject command:", "hostnamectl");
        if (q == null) return;
        if (activeWs && activeWs.readyState === WebSocket.OPEN) {
          if (activeWs.__pveFramed) {
            const payload = q.endsWith("\n") ? q : `${q}\n`;
            const bytes = new TextEncoder().encode(payload);
            activeWs.send(`0:${bytes.length}:${payload}`);
          } else {
            activeWs.send(q.endsWith("\r") || q.endsWith("\n") ? q : `${q}\r`);
          }
        } else {
          term.writeln(`\x1b[33m(not connected) ${q}\x1b[0m`);
        }
      });
    } catch (err) {
      showError("Failed to load terminal UI");
      setStatus("offline", false);
      return;
    }

    const fit = () => {
      try {
        const rect = mount.getBoundingClientRect();
        const cols = Math.max(40, Math.floor(rect.width / 9.0));
        const rows = Math.max(10, Math.floor(rect.height / 18));
        term.resize(cols, rows);
        if (activeWs?.readyState === WebSocket.OPEN) {
          if (activeWs.__pveFramed) activeWs.send(`1:${cols}:${rows}:`);
          else {
            try { activeWs.send(JSON.stringify({ type: "resize", cols, rows })); } catch {}
          }
        }
      } catch {}
    };
    const ro = new ResizeObserver(fit);
    ro.observe(mount);
    cleanupFns.push(() => ro.disconnect());
    setTimeout(fit, 50);

    // Prefer ProxMenux host shell (already on the Proxmox node)
    if (getPrxUrl(nodeCfg)) {
      const used = await connectProxmenuxHostShell(nodeCfg, term, {
        setStatus,
        showError,
        cleanupFns,
        onWs: (ws) => { activeWs = ws; activeWs.__pveFramed = false; },
      });
      if (used) return;
    }

    // Fallback: PVE node termproxy
    await connectPveNodeShell(nodeCfg, term, {
      setStatus,
      showError,
      cleanupFns,
      onWs: (ws) => { activeWs = ws; },
    });
  }

  async function openGuestTerminal(nodeCfg, type, vmid, name) {
    closeGuestTerminal({ skipRefresh: true });
    _termGuestCtx = { nodeCfg, type, vmid, sawPackageChange: false };
    const kind = type === "qemu" ? "qemu" : "lxc";
    const consoleKind = kind === "qemu" ? "kvm" : "lxc";
    const consoleParams = new URLSearchParams({
      console: consoleKind,
      xtermjs: "1",
      vmid: String(vmid),
      vmname: name || String(vmid),
      node: nodeCfg.pveNode,
      resize: "1",
      cmd: "",
    });
    const consoleHref = `${getPveUrl(nodeCfg)}/?${consoleParams.toString()}`;

    const backdrop = document.createElement("div");
    backdrop.className = "pve-term-backdrop";
    backdrop.innerHTML = `
      <div class="pve-term-modal" role="dialog" aria-modal="true">
        <div class="pve-term-grip" title="Drag to resize" data-term-grip>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="9" r="1"/><circle cx="19" cy="9" r="1"/><circle cx="5" cy="9" r="1"/><circle cx="12" cy="15" r="1"/><circle cx="19" cy="15" r="1"/><circle cx="5" cy="15" r="1"/></svg>
        </div>
        <div class="pve-term-hdr">
          <div class="pve-term-title">Terminal: ${escH(name)} <span>(ID: ${escH(vmid)})</span></div>
          <div class="pve-term-hdr-actions">
            <button type="button" class="pve-term-btn pve-term-btn--search" data-term-search title="Search commands">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
              Search
            </button>
            <button type="button" class="pve-term-btn pve-term-btn--clear" data-term-clear title="Clear">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
              Clear
            </button>
          </div>
        </div>
        <div class="pve-term-error" data-term-error hidden></div>
        <div class="pve-term-body" data-term-mount></div>
        <div class="pve-term-ftr">
          <div class="pve-term-status" data-term-status>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/></svg>
            <span class="pve-term-dot" data-term-dot></span>
            <span data-term-status-text>connecting</span>
          </div>
          <div class="pve-term-ftr-actions">
            <a class="pve-term-btn pve-term-btn--ext" href="${escH(consoleHref)}" target="_blank" rel="noopener" data-term-ext hidden>Open in Proxmox</a>
            <button type="button" class="pve-term-btn pve-term-btn--close" data-term-close>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
              Close
            </button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    _termModal = backdrop;

    const modalEl = backdrop.querySelector(".pve-term-modal");
    const statusText = backdrop.querySelector("[data-term-status-text]");
    const statusWrap = backdrop.querySelector("[data-term-status]");
    const errorEl = backdrop.querySelector("[data-term-error]");
    const mount = backdrop.querySelector("[data-term-mount]");
    const extLink = backdrop.querySelector("[data-term-ext]");
    const setStatus = (txt, online = false) => {
      if (statusText) statusText.textContent = String(txt || "").toLowerCase();
      statusWrap?.classList.toggle("pve-term-status--online", !!online);
      statusWrap?.classList.toggle("pve-term-status--offline", !online && txt !== "connecting");
    };
    const showError = (msg) => {
      if (!errorEl) return;
      errorEl.hidden = false;
      errorEl.textContent = msg;
      if (extLink) extLink.hidden = false;
    };

    const cleanupFns = [];
    backdrop.__pveTermCleanup = () => cleanupFns.forEach(fn => { try { fn(); } catch {} });
    backdrop.querySelector("[data-term-close]")?.addEventListener("click", closeGuestTerminal);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closeGuestTerminal(); });

    const grip = backdrop.querySelector("[data-term-grip]");
    if (grip && modalEl) {
      let startY = 0, startH = 0;
      const onMove = (e) => {
        const y = e.touches ? e.touches[0].clientY : e.clientY;
        modalEl.style.height = `${Math.max(320, Math.min(window.innerHeight - 40, startH + (startY - y)))}px`;
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.removeEventListener("touchmove", onMove);
        document.removeEventListener("touchend", onUp);
      };
      const onDown = (e) => {
        e.preventDefault();
        startY = e.touches ? e.touches[0].clientY : e.clientY;
        startH = modalEl.getBoundingClientRect().height;
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
        document.addEventListener("touchmove", onMove, { passive: false });
        document.addEventListener("touchend", onUp);
      };
      grip.addEventListener("mousedown", onDown);
      grip.addEventListener("touchstart", onDown, { passive: false });
    }

    const esc = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); closeGuestTerminal(); }
    };
    document.addEventListener("keydown", esc, true);
    cleanupFns.push(() => document.removeEventListener("keydown", esc, true));

    let term = null;
    let activeWs = null;
    try {
      const Terminal = await loadXterm();
      const fontSize = window.innerWidth < 768 ? 12 : 15;
      term = new Terminal({
        cursorBlink: true,
        fontSize,
        fontFamily: '"MesloLGS NF", "FiraCode Nerd Font", "JetBrainsMono Nerd Font", "Hack Nerd Font", ui-monospace, Menlo, Consolas, monospace',
        fontWeight: "500",
        fontWeightBold: "700",
        scrollback: 2000,
        convertEol: true,
        theme: {
          background: "#000000",
          foreground: "#ffffff",
          cursor: "#ffffff",
          cursorAccent: "#000000",
          selectionBackground: "#4d4d4d",
          black: "#2e3436", red: "#cc0000", green: "#4e9a06", yellow: "#c4a000",
          blue: "#3465a4", magenta: "#75507b", cyan: "#06989a", white: "#d3d7cf",
          brightBlack: "#555753", brightRed: "#ef2929", brightGreen: "#8ae234", brightYellow: "#fce94f",
          brightBlue: "#729fcf", brightMagenta: "#ad7fa8", brightCyan: "#34e2e2", brightWhite: "#eeeeec",
        },
      });
      term.open(mount);
      term.focus();
      if (_termGuestCtx) {
        _termGuestCtx.term = term;
        _termGuestCtx.setStatus = setStatus;
        _termGuestCtx.type = type;
      }
      cleanupFns.push(() => { try { term.dispose(); } catch {} });
      cleanupFns.push(() => {
        if (_termGuestCtx?.autoRecheckTimer) clearTimeout(_termGuestCtx.autoRecheckTimer);
      });
      backdrop.querySelector("[data-term-clear]")?.addEventListener("click", () => term.clear());
      backdrop.querySelector("[data-term-search]")?.addEventListener("click", () => {
        const q = prompt("Inject command:", "ls -la");
        if (q == null) return;
        if (activeWs && activeWs.readyState === WebSocket.OPEN) {
          // ProxMenux path: raw. PVE path: framed below via term.onData only — send raw if ProxMenux
          if (activeWs.__pveFramed) {
            const payload = q.endsWith("\n") ? q : `${q}\n`;
            const bytes = new TextEncoder().encode(payload);
            activeWs.send(`0:${bytes.length}:${payload}`);
          } else {
            activeWs.send(q.endsWith("\r") || q.endsWith("\n") ? q : `${q}\r`);
          }
        } else {
          term.writeln(`\x1b[33m(not connected) ${q}\x1b[0m`);
        }
      });
    } catch (err) {
      showError("Failed to load terminal UI");
      setStatus("offline", false);
      return;
    }

    const fit = () => {
      try {
        const rect = mount.getBoundingClientRect();
        const cols = Math.max(40, Math.floor(rect.width / 9.0));
        const rows = Math.max(10, Math.floor(rect.height / 18));
        term.resize(cols, rows);
        if (activeWs?.readyState === WebSocket.OPEN) {
          if (activeWs.__pveFramed) activeWs.send(`1:${cols}:${rows}:`);
          else {
            try { activeWs.send(JSON.stringify({ type: "resize", cols, rows })); } catch {}
          }
        }
      } catch {}
    };
    const ro = new ResizeObserver(fit);
    ro.observe(mount);
    cleanupFns.push(() => ro.disconnect());
    setTimeout(fit, 50);

    // 1) Prefer ProxMenux host shell (same as MONITOR terminal)
    if (kind === "lxc" && getPrxUrl(nodeCfg)) {
      const used = await connectProxmenuxShell(nodeCfg, vmid, term, {
        setStatus,
        showError,
        cleanupFns,
        onWs: (ws) => { activeWs = ws; activeWs.__pveFramed = false; },
      });
      if (used) return;
    }

    // 2) Fallback: PVE termproxy + websocket (requires VM.Console; API-token WS is fragile)
    const base = guestApiBase(nodeCfg, kind, vmid);
    let port, ticket, user;
    try {
      const res = await fetch(`${getPveUrl(nodeCfg)}/api2/json${base}/termproxy`, {
        method: "POST",
        headers: pveHeaders(nodeCfg),
      });
      let errDetail = "";
      if (!res.ok) {
        try {
          const j = await res.json();
          errDetail = j?.message || (j?.errors && JSON.stringify(j.errors)) || "";
        } catch {}
        throw new Error(`Error ${res.status}${errDetail ? ": " + errDetail : ""}`);
      }
      const payload = await res.json();
      const data = payload.data || payload;
      port = data.port;
      ticket = data.ticket;
      user = data.user || nodeCfg.pveUser;
      if (!port || !ticket) throw new Error("termproxy missing port/ticket");
    } catch (err) {
      showError(`Connection failed (${err.message || err})`);
      setStatus("offline", false);
      term.writeln("\x1b[31mPVE termproxy failed.\x1b[0m");
      if (getPrxUrl(nodeCfg)) {
        term.writeln("Tip: use ProxMenux MONITOR token for LXC shells (prompted on open).");
      }
      return;
    }

    const fullUser = String(user || nodeCfg.pveUser || "");
    const authUser = /!/.test(fullUser) ? fullUser.replace(/!.*$/, "") : fullUser;
    const pveBase = getPveUrl(nodeCfg);
    const wsProto = pveBase.startsWith("https") ? "wss" : "ws";
    const host = pveBase.replace(/^https?:\/\//, "").replace(/\/$/, "");
    const wsUrl = `${wsProto}://${host}/api2/json${base}/vncwebsocket?port=${encodeURIComponent(port)}&vncticket=${encodeURIComponent(ticket)}`;

    let ws;
    try { ws = new WebSocket(wsUrl, "binary"); }
    catch (err) {
      showError(`Connection failed (${err.message || err})`);
      setStatus("offline", false);
      return;
    }
    ws.binaryType = "arraybuffer";
    ws.__pveFramed = true;
    activeWs = ws;
    cleanupFns.push(() => { try { ws.close(); } catch {} });

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let sawOutput = false;

    ws.onopen = () => {
      ws.send(`${authUser}:${ticket}\n`);
      try { ws.send(`1:${term.cols || 80}:${term.rows || 24}:`); } catch {}
      setStatus("online", true);
      const ping = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send("2");
      }, 30000);
      cleanupFns.push(() => clearInterval(ping));
    };
    ws.onmessage = (ev) => {
      sawOutput = true;
      if (errorEl) errorEl.hidden = true;
      setStatus("online", true);
      if (typeof ev.data === "string") {
        if (ev.data.startsWith("RFB ")) {
          showError("Connection failed (VNC mode — use ProxMenux MONITOR token for LXC)");
          setStatus("offline", false);
          try { ws.close(); } catch {}
          return;
        }
        term.write(ev.data);
        noteTerminalAptActivity(ev.data);
        return;
      }
      const buf = new Uint8Array(ev.data);
      const head = decoder.decode(buf.slice(0, Math.min(12, buf.length)));
      if (head.startsWith("RFB ")) {
        showError("Connection failed (VNC mode — use ProxMenux MONITOR token for LXC)");
        setStatus("offline", false);
        try { ws.close(); } catch {}
        return;
      }
      term.write(buf);
      noteTerminalAptActivity(decoder.decode(buf));
    };
    ws.onclose = () => {
      setStatus("offline", false);
      if (sawOutput) term.writeln("\r\n\x1b[90mConnection closed\x1b[0m");
    };
    term.onData((data) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const bytes = encoder.encode(data);
      ws.send(`0:${bytes.length}:${data}`);
    });

    setTimeout(() => {
      if (sawOutput) return;
      showError("PVE console auth failed — for LXC use ProxMenux MONITOR token when prompted");
      setStatus("offline", false);
      try { ws.close(); } catch {}
      term.writeln("\r\n\x1b[31mPVE API-token consoles are unreliable.\x1b[0m");
      term.writeln("Re-open Terminal and paste \x1b[33mproxmenux-auth-token\x1b[0m from MONITOR.");
    }, 4000);
  }


  async function openGuestController(nodeCfg, type, vmid) {
    closeGuestController();

    const cache = _nodeCache[nodeCfg.groupName] || {};
    const list = type === "qemu" ? (cache.pveData?.vms || []) : (cache.pveData?.lxcs || []);
    let guest = list.find(g => String(g.vmid) === String(vmid)) || { vmid, name: `guest-${vmid}`, status: "unknown", _type: type };

    // Refresh ProxMenux guest update map (silent — badge only appears when data exists)
    await fetchPrxVms(nodeCfg, { silent: true }).catch(() => null);
    const updateCheck = normalizeUpdateCheck(getGuestUpdateCheck(nodeCfg, vmid));
    if (updateCheck) guest = { ...guest, update_check: updateCheck };

    const backdrop = document.createElement("div");
    backdrop.className = "pve-gc-backdrop";
    const modal = document.createElement("div");
    modal.className = "pve-gc-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.innerHTML = `
      <div class="pve-gc-loading">Loading guest controller…</div>
      <button type="button" class="pve-gc-close" aria-label="Close">×</button>`;
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    _guestModal = backdrop;
    document.addEventListener("keydown", _guestEscHandler, true);

    // Close only when press + release both land on the dimmed backdrop itself.
    // Notes/Info expand the modal mid-gesture; handle them on pointerdown and
    // swallow the follow-up click so a shifted mouseup on the backdrop can't close.
    let backdropArmed = false;

    const isInsideModal = (el) => el instanceof Element && modal.contains(el);

    backdrop.addEventListener("pointerdown", (e) => {
      const t = e.target;
      if (!(t instanceof Element)) return;

      const notesBtn = t.closest("[data-gc-notes]");
      if (notesBtn && isInsideModal(notesBtn)) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        backdropArmed = false;
        toggleGuestNotes(modal);
        return;
      }

      const infoBtn = t.closest("[data-gc-info]");
      if (infoBtn && isInsideModal(infoBtn)) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        backdropArmed = false;
        toggleGuestInfo(modal);
        return;
      }

      backdropArmed = e.target === backdrop;
    }, true);

    backdrop.addEventListener("pointerup", (e) => {
      if (e.target !== backdrop) backdropArmed = false;
    }, true);

    backdrop.addEventListener("click", (e) => {
      const t = e.target;
      if (!(t instanceof Element)) return;

      // Swallow leftover click from Notes/Info pointerdown handling
      if (t.closest("[data-gc-notes], [data-gc-info]")) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        backdropArmed = false;
        return;
      }

      if (t.closest(".pve-gc-close") && isInsideModal(t.closest(".pve-gc-close"))) {
        e.preventDefault();
        e.stopPropagation();
        closeGuestController();
        return;
      }

      // Clicks inside the sheet never dismiss
      if (isInsideModal(t)) {
        backdropArmed = false;
        return;
      }

      if (
        e.target === backdrop &&
        backdropArmed &&
        Date.now() >= (modal.__pveGcIgnoreBackdropUntil || 0)
      ) {
        closeGuestController();
      }
      backdropArmed = false;
    }, true);

    // Keep in-modal clicks from reaching any document-level dismiss handlers
    modal.addEventListener("click", (e) => {
      e.stopPropagation();
    });

    let config = {};
    let status = {};
    let backups = [];
    let firewall = { options: {}, rules: [] };
    try {
      const [cfg, st, baks, fw] = await Promise.all([
        fetchGuestConfig(nodeCfg, type, vmid).catch(() => ({})),
        fetchGuestStatus(nodeCfg, type, vmid).catch(() => ({})),
        fetchGuestBackups(nodeCfg, vmid, type).catch(() => []),
        fetchGuestFirewall(nodeCfg, type, vmid).catch(() => ({ options: {}, rules: [] })),
      ]);
      config = cfg || {};
      status = st || {};
      backups = baks || [];
      firewall = fw || { options: {}, rules: [] };
      guest = {
        ...guest,
        ...status,
        name: status.name || guest.name,
        _type: type === "qemu" ? "qemu" : "lxc",
        update_check: updateCheck || guest.update_check || null,
      };
    } catch (err) {
      console.warn("[PveWidget] guest controller load failed:", err);
    }

    renderGuestController(modal, nodeCfg, guest, config, backups, firewall);
  }

  function renderGuestController(modal, nodeCfg, guest, config, backups, firewall, activePane = "status", uiState = null) {
    const isLxc = guest._type === "lxc" || guest._type !== "qemu";
    const type = isLxc ? "lxc" : "qemu";
    const running = guest.status === "running";
    const cpus = Number(guest.cpus || config.cores || config.cpulimit || 1) || 1;
    const cpuPct = Math.round((Number(guest.cpu) || 0) * 1000) / 10;
    const memUsed = Number(guest.mem) || 0;
    const memMax = Number(guest.maxmem || (Number(config.memory) || 0) * 1024 * 1024) || 0;
    const memPct = memMax > 0 ? (memUsed / memMax) * 100 : 0;
    const diskUsed = Number(guest.disk) || 0;
    const diskMax = Number(guest.maxdisk) || 0;
    const diskPct = diskMax > 0 ? (diskUsed / diskMax) * 100 : 0;
    const swapMb = config.swap != null ? Number(config.swap) : null;
    const ips = parseGuestIps(config);
    const notes = config.description || "";
    const osLabel = ostypeLabel(config.ostype);
    const up = guest.uptime != null ? fmtUptimeFull(guest.uptime) : "—";
    const fwEnabled = firewall?.options?.enable == 1 || firewall?.options?.enable === true;
    const fwRules = firewall?.rules || [];
    const ui = uiState || modal.__pveGcUi || { showNotes: false, showInfo: false };
    modal.__pveGcUi = ui;
    const updateCheckRaw = guest.update_check || getGuestUpdateCheck(nodeCfg, guest.vmid) || null;
    const updateCheck = normalizeUpdateCheck(updateCheckRaw);
    const updatesBadge = updateCheck
      ? guestUpdatesBadgeHtml(updateCheck, { chevron: true, clickable: true })
      : "";
    modal.__pveGcCtx = {
      notes,
      config,
      type,
      nodeCfg,
      guest,
      backups,
      firewall,
      activePane,
      updateCheck,
    };

    const statusPane = `
      <div class="pve-gc-usage">
        <div class="pve-gc-usage-grid">
          <div>
            <div class="pve-g-metric-label">CPU Usage (${cpus} core${cpus === 1 ? "" : "s"})</div>
            <div class="pve-g-metric-val">${cpuPct.toFixed(1)}%</div>
            ${miniBar(cpuPct, pctColor(cpuPct))}
          </div>
          <div>
            <div class="pve-g-metric-label">Memory</div>
            <div class="pve-g-metric-val">${escH(fmtBytes(memUsed))} / ${escH(fmtBytes(memMax))}</div>
            ${miniBar(memPct, "#38bdf8")}
          </div>
          <div>
            <div class="pve-g-metric-label">Disk</div>
            <div class="pve-g-metric-val">${diskMax ? `${escH(fmtBytes(diskUsed))} / ${escH(fmtBytes(diskMax))}` : "—"}</div>
            ${diskMax ? miniBar(diskPct, "#38bdf8") : miniBar(0, "#38bdf8")}
          </div>
        </div>
        <div class="pve-gc-usage-io">
          <div>
            <div class="pve-g-metric-label">Disk I/O (since boot)</div>
            <div class="pve-g-metric-io">
              <span class="pve-g-io pve-g-io--r">↓ ${escH(fmtBytes(guest.diskread || 0))}</span>
              <span class="pve-g-io pve-g-io--w">↑ ${escH(fmtBytes(guest.diskwrite || 0))}</span>
            </div>
          </div>
          <div>
            <div class="pve-g-metric-label">Network I/O (since boot)</div>
            <div class="pve-g-metric-io">
              <span class="pve-g-io pve-g-io--rx">↓ ${escH(fmtBytes(guest.netin || 0))}</span>
              <span class="pve-g-io pve-g-io--tx">↑ ${escH(fmtBytes(guest.netout || 0))}</span>
            </div>
          </div>
          ${ostypeLogoHtml(config.ostype)}
        </div>
      </div>

      <div class="pve-gc-section">
        <div class="pve-gc-section-hdr">
          <span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/></svg>
            Resources
          </span>
          <div class="pve-gc-section-actions">
            <button type="button" class="pve-gc-mini-btn ${ui.showNotes ? "pve-gc-mini-btn--active" : ""}" data-gc-notes>
              ${notesBtnHtml(ui.showNotes)}
            </button>
            <button type="button" class="pve-gc-mini-btn ${ui.showInfo ? "pve-gc-mini-btn--active" : ""}" data-gc-info>
              ${infoBtnHtml(ui.showInfo)}
            </button>
          </div>
        </div>
        <div class="pve-gc-res-grid">
          <div><span>CPU Cores</span><b>${cpus}</b></div>
          <div><span>Memory</span><b>${memMax ? Math.round(memMax / 1024 / 1024) + " MB" : (config.memory != null ? config.memory + " MB" : "—")}</b></div>
          <div><span>Swap</span><b>${swapMb != null ? `${swapMb} MB` : "—"}</b></div>
        </div>
        <div class="pve-gc-ips">
          <div class="pve-gc-ips-label">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
            IP Addresses
          </div>
          <div class="pve-gc-ip-list">
            ${ips.length
              ? ips.map(ip => `<span class="pve-gc-ip">${escH(ip)}</span>`).join("")
              : `<span class="pve-gc-ip pve-gc-ip--muted">No static IPs in config</span>`}
          </div>
        </div>
        ${ui.showNotes ? buildNotesPanel(notes) : ""}
        ${ui.showInfo ? buildInfoPanel(config, type) : ""}
      </div>`;

    const backupsPane = `
      <div class="pve-gc-section">
        <div class="pve-gc-section-hdr"><span>Backups</span><span class="pve-g-pill">${backups.length}</span></div>
        <div class="pve-gc-backup-list">
          ${backups.length ? backups.slice(0, 20).map(b => {
            const when = b.ctime ? new Date(b.ctime * 1000).toLocaleString() : "—";
            const size = b.size != null ? fmtBytes(b.size) : "—";
            const vol = String(b.volid || "").split("/").pop() || b.volid || "backup";
            return `<div class="pve-gc-backup-row">
              <div>
                <div class="pve-gc-backup-name" title="${escH(b.volid || "")}">${escH(vol)}</div>
                <div class="pve-gc-backup-meta">${escH(when)} · ${escH(b.storage || "")}</div>
              </div>
              <div class="pve-gc-backup-size">${escH(size)}</div>
            </div>`;
          }).join("") : `<div class="pve-g-empty">No backups found for this guest</div>`}
        </div>
      </div>`;

    const firewallPane = `
      <div class="pve-gc-section">
        <div class="pve-gc-section-hdr">
          <span>Firewall</span>
          <span class="pve-g-pill ${fwEnabled ? "pve-g-pill--run" : "pve-g-pill--stop"}">${fwEnabled ? "ENABLED" : "DISABLED"}</span>
        </div>
        <div class="pve-gc-fw-list">
          ${fwRules.length ? fwRules.map((r, i) => `
            <div class="pve-gc-fw-row">
              <span class="pve-g-pill">${escH(r.action || r.type || "RULE")}</span>
              <span>${escH(r.macro || r.proto || "any")}</span>
              <span class="pve-gc-fw-detail">${escH(r.source || "anywhere")} → ${escH(r.dest || "anywhere")}${r.dport ? " :" + escH(r.dport) : ""}</span>
              <span class="pve-gc-fw-enable">${r.enable === 0 ? "off" : "on"}</span>
            </div>`).join("") : `<div class="pve-g-empty">No guest firewall rules</div>`}
        </div>
      </div>`;

    const updatesPane = buildGuestUpdatesPane({ ...guest, _type: type }, updateCheckRaw || updateCheck);

    const pane = activePane === "backups"
      ? backupsPane
      : activePane === "firewall"
        ? firewallPane
        : activePane === "updates"
          ? updatesPane
          : statusPane;

    modal.innerHTML = `
      <button type="button" class="pve-gc-close" aria-label="Close">×</button>
      <div class="pve-gc-hdr">
        <div class="pve-gc-title">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2 2 7l10 5 10-5-10-5Z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/></svg>
          <div>
            <div class="pve-gc-name">${escH(guest.name || `guest-${guest.vmid}`)} <span>ID: ${escH(guest.vmid)}</span></div>
          </div>
        </div>
        <div class="pve-gc-hdr-meta">
          <span class="pve-g-pill ${isLxc ? "pve-g-pill--lxc" : "pve-g-pill--vm"}">${isLxc ? "LXC" : "VM"}</span>
          <span class="pve-g-pill ${running ? "pve-g-pill--run" : "pve-g-pill--stop"}">${running ? "RUNNING" : String(guest.status || "STOPPED").toUpperCase()}</span>
          <span class="pve-g-uptime">Uptime: ${escH(up)}</span>
          ${updatesBadge}
        </div>
      </div>

      <div class="pve-gc-tabs" role="tablist">
        <button type="button" class="pve-gc-tab ${activePane === "status" ? "pve-gc-tab--active" : ""}" data-gc-tab="status">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
          Status
        </button>
        <button type="button" class="pve-gc-tab ${activePane === "backups" ? "pve-gc-tab--active" : ""}" data-gc-tab="backups">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          Backups <span class="pve-gc-tab-badge">${backups.length}</span>
        </button>
        <button type="button" class="pve-gc-tab pve-gc-tab--updates ${activePane === "updates" ? "pve-gc-tab--active pve-gc-tab--active-updates" : ""}" data-gc-tab="updates">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>
          Updates${updateCheck && updateCheck.count > 0 ? ` <span class="pve-gc-tab-badge pve-gc-tab-badge--updates">${updateCheck.count}</span>` : ""}
        </button>
        <button type="button" class="pve-gc-tab ${activePane === "firewall" ? "pve-gc-tab--active" : ""}" data-gc-tab="firewall">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          Firewall
        </button>
      </div>

      <div class="pve-gc-body">${pane}</div>

      <div class="pve-gc-footer">
        <button type="button" class="pve-gc-terminal" data-gc-term>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
          Open Terminal
        </button>
        <div class="pve-gc-actions">
          <button type="button" class="pve-gc-act pve-gc-act--start" data-gc-act="start" ${running ? "disabled" : ""}>Start</button>
          <button type="button" class="pve-gc-act pve-gc-act--shutdown" data-gc-act="shutdown" ${running ? "" : "disabled"}>Shutdown</button>
          <button type="button" class="pve-gc-act pve-gc-act--reboot" data-gc-act="reboot" ${running ? "" : "disabled"}>Reboot</button>
          <button type="button" class="pve-gc-act pve-gc-act--stop" data-gc-act="stop" ${running ? "" : "disabled"}>Force Stop</button>
        </div>
        <div class="pve-gc-toast" hidden></div>
      </div>`;

    modal.querySelector(".pve-gc-close")?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeGuestController();
    });

    const goPane = (paneName) => {
      renderGuestController(modal, nodeCfg, guest, config, backups, firewall, paneName || "status", ui);
    };

    modal.querySelectorAll("[data-gc-tab]").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        goPane(btn.getAttribute("data-gc-tab") || "status");
      });
    });

    modal.querySelectorAll("[data-gc-goto]").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        goPane(btn.getAttribute("data-gc-goto") || "updates");
      });
    });

    // Notes / Info are handled by the backdrop capture listener (toggleGuestNotes/Info)
    // so they survive without a full modal re-render.

    modal.querySelector("[data-gc-term]")?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openGuestTerminal(nodeCfg, type, guest.vmid, guest.name || `guest-${guest.vmid}`);
    });

    const toast = modal.querySelector(".pve-gc-toast");
    function showToast(msg, ok = true) {
      if (!toast) return;
      toast.hidden = false;
      toast.textContent = msg;
      toast.className = `pve-gc-toast ${ok ? "pve-gc-toast--ok" : "pve-gc-toast--err"}`;
      setTimeout(() => { toast.hidden = true; }, 3500);
    }

    modal.querySelector("[data-gc-recheck]")?.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const btn = e.currentTarget;
      const prev = btn.innerHTML;
      btn.disabled = true;
      btn.classList.add("pve-gc-updates-recheck--busy");
      btn.innerHTML = `<svg class="pve-gc-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg> Checking…`;
      try {
        const nextUc = await refreshGuestUpdateStatus(nodeCfg, type, guest.vmid);
        const nextGuest = { ...guest, update_check: nextUc?.count > 0 ? nextUc : { ...nextUc, available: false, count: 0 } };
        renderGuestController(modal, nodeCfg, nextGuest, config, backups, firewall, "updates", ui);
        showToast(
          nextUc?.count > 0 ? `${nextUc.count} update${nextUc.count === 1 ? "" : "s"} still pending` : "No pending updates",
          true
        );
      } catch (err) {
        showToast(err.message || String(err), false);
        btn.disabled = false;
        btn.classList.remove("pve-gc-updates-recheck--busy");
        btn.innerHTML = prev;
      }
    });

    modal.querySelectorAll("[data-gc-act]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const act = btn.getAttribute("data-gc-act");
        if (!act) return;
        btn.disabled = true;
        try {
          await pvePost(nodeCfg, `${guestApiBase(nodeCfg, type, guest.vmid)}/status/${act}`);
          showToast(`${act} issued`, true);
          // refresh status shortly
          setTimeout(async () => {
            try {
              const st = await fetchGuestStatus(nodeCfg, type, guest.vmid);
              const next = {
                ...guest,
                ...st,
                _type: type === "qemu" ? "qemu" : "lxc",
                update_check: guest.update_check || updateCheck || null,
              };
              renderGuestController(modal, nodeCfg, next, config, backups, firewall, activePane, ui);
              renderNode(nodeCfg);
            } catch {}
          }, 1200);
        } catch (err) {
          showToast(err.message || String(err), false);
          btn.disabled = false;
        }
      });
    });
  }


  // ── Init ─────────────────────────────────────────────────────────
HpWidgetBoot.watch("proxmox-nodes", {
    ready: () => {
      // Require the tab bar itself — a skeleton/shell without tabs is not "ready"
      // and must not stop remount retries (and header scavengers must not delete tabs).
      const present = PVE_NODES.filter((nodeCfg) => !!findGroupContainer(nodeCfg.groupName));
      if (!present.length) return false;
      return present.every((nodeCfg) => {
        const g = findGroupContainer(nodeCfg.groupName);
        return !!g?.querySelector(".pve-node-host .pve-shell .pve-tabs");
      });
    },
    setup: () => {
      PVE_NODES.forEach((nodeCfg, i) => {
        const delay = i * 400;
        setTimeout(() => {
          renderNode(nodeCfg);
          setInterval(() => { if (!document.hidden) renderNode(nodeCfg); }, PVE_POLL_MS);
        }, 1200 + delay);
      });
    },
    mount: () => PVE_NODES.forEach((nodeCfg) => renderNode(nodeCfg)),
  });
})();
