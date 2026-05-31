/* =====================================================
   QBITTORRENT MANAGER WIDGET
===================================================== */
(function () {

  const QBIT_CONFIG = {
    groupName: "QBIT-MANAGER",
    pollMs: 60 * 1000,
    servers: [
      {
        label: "qBittorrent",
        url: "http://YOUR_LOCAL_IP:PORT",
        fallbackUrl: "https://YOUR_TUNNEL_URL",
        activeUrl: null,
        username: "YOUR_USERNAME",
        password: "YOUR_PASSWORD",
        color: "#4ade80"
      },
    ],
  };

  /* ── State ── */
  let _activeIdx = 0;
  let _torrents = {};
  let _transferInfo = {};
  let _maindata = {};          // ← added
  let _serverStatus = {};
  let _selectedHashes = new Set();
  let _filterState = "all";
  let _searchQuery = "";
  let _sortKey = "";
  let _rendering = false;
  let _obsDelay = null;
  let _pollTimer = null;
  let _cookies = {};
  let _deleteWithFiles = false;

  /* ── Utilities ── */
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

  function fmtSpeed(bytesPerSec) {
    if (!bytesPerSec || bytesPerSec < 0) return "0 B/s";
    return fmtBytes(bytesPerSec) + "/s";
  }

  function fmtEta(seconds) {
    if (!seconds || seconds < 0 || seconds === 8640000) return "∞";
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  }

  function fmtRatio(ratio) {
    if (ratio == null || isNaN(ratio)) return "—";
    return ratio.toFixed(2);
  }

  /* ── DOM helpers ── */
  function findGroupContainer() {
    const hd = Array.from(
      document.querySelectorAll("h2,h3,.group-title,.service-group-name")
    ).find(el => normText(el.textContent) === QBIT_CONFIG.groupName);
    if (!hd) return null;
    return (
      hd.closest("section") ||
      hd.closest("div[class*='group']") ||
      hd.parentElement?.parentElement ||
      hd.parentElement
    );
  }

  function ensureHost(group) {
    let row = group.querySelector(".qbit-flex-row");
    if (!row) {
      const list = group.querySelector("ul.services-list, ul");
      if (list) list.style.display = "none";
      row = document.createElement("div");
      row.className = "qbit-flex-row";
      group.appendChild(row);
    }
    let host = row.querySelector(".qbit-host");
    if (host) return host;
    host = document.createElement("div");
    host.className = "qbit-host";
    row.appendChild(host);
    return host;
  }

  function getHost() {
    const g = findGroupContainer();
    return g ? g.querySelector(".qbit-host") : null;
  }

  /* ── qBittorrent API ── */
  async function qbitFetch(serverIdx, path, options = {}) {
    const server = QBIT_CONFIG.servers[serverIdx];
    const cookieHeader = _cookies[serverIdx]
      ? { "Cookie": `SID=${_cookies[serverIdx]}` }
      : {};

    const candidates = [];
    if (server.activeUrl) candidates.push(server.activeUrl);
    if (!candidates.includes(server.url)) candidates.push(server.url);
    if (server.fallbackUrl && !candidates.includes(server.fallbackUrl)) candidates.push(server.fallbackUrl);

    let lastErr = null;
    for (const base of candidates) {
      try {
        const res = await fetch(`${base}${path}`, {
          ...options,
          headers: {
            ...cookieHeader,
            ...(options.headers || {})
          },
          credentials: "include",
          signal: (() => { const c = new AbortController(); setTimeout(() => c.abort(), 8000); return c.signal; })()
        });

        const setCookie = res.headers.get("set-cookie");
        if (setCookie) {
          const match = setCookie.match(/SID=([^;]+)/);
          if (match) _cookies[serverIdx] = match[1];
        }

        server.activeUrl = base;
        return res;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error(`All URLs failed for ${server.label}`);
  }

  async function qbitLogin(serverIdx) {
    const server = QBIT_CONFIG.servers[serverIdx];
    const body = new URLSearchParams({
      username: server.username,
      password: server.password
    });

    try {
      const res = await fetch(`${server.activeUrl || server.url}/api/v2/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Origin": server.url,
          "Referer": server.url + "/"
        },
        body: body.toString(),
        credentials: "include",
        signal: (() => { const c = new AbortController(); setTimeout(() => c.abort(), 8000); return c.signal; })()
      });

      const text = await res.text();
      if (text.trim() === "Ok.") {
        const setCookie = res.headers.get("set-cookie");
        if (setCookie) {
          const match = setCookie.match(/SID=([^;]+)/);
          if (match) _cookies[serverIdx] = match[1];
        }
        return true;
      }
      console.warn(`[qbit] Login rejected for ${server.label}:`, text.trim());
      return false;
    } catch (err) {
      console.warn(`[qbit] Login error for ${server.label}:`, err.message);
      return false;
    }
  }

  async function qbitApiGet(serverIdx, path) {
    let res = await qbitFetch(serverIdx, `/api/v2${path}`);

    if (res.status === 403 || res.status === 401) {
      const ok = await qbitLogin(serverIdx);
      if (!ok) throw new Error("Login failed");
      res = await qbitFetch(serverIdx, `/api/v2${path}`);
    }

    if (!res.ok) throw new Error(`qBit API ${res.status}: ${path}`);
    return res.json();
  }

  async function qbitApiPost(serverIdx, path, formData = {}) {
    const body = new URLSearchParams(formData);

    let res = await qbitFetch(serverIdx, `/api/v2${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString()
    });

    if (res.status === 403 || res.status === 401) {
      const ok = await qbitLogin(serverIdx);
      if (!ok) throw new Error("Login failed");
      res = await qbitFetch(serverIdx, `/api/v2${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString()
      });
    }

    if (!res.ok) throw new Error(`qBit POST ${res.status}: ${path}`);
    return res;
  }

  /* ── Fetch data ── */
  async function fetchServerData(serverIdx) {
    const [torrents, transferInfo, maindata] = await Promise.all([
      qbitApiGet(serverIdx, "/torrents/info?sort=added_on&reverse=true"),
      qbitApiGet(serverIdx, "/transfer/info"),
      qbitApiGet(serverIdx, "/sync/maindata")
    ]);
    return { torrents, transferInfo, maindata };
  }

  /* ── State derivation ── */
  function stateClass(state) {
    const s = (state || "").toLowerCase();
    if (s === "stalledup") return "qbit-state--seeding";
    if (s === "stalleddl") return "qbit-state--stalled";
    if (s.includes("download")) return "qbit-state--downloading";
    if (s.includes("upload") || s === "uploading") return "qbit-state--uploading";
    if (s === "seeding" || s === "forcedseeding") return "qbit-state--seeding";
    if (s.includes("pause") || s.includes("stop")) return "qbit-state--paused";
    if (s.includes("stall") || s.includes("error") || s === "missingfiles") return "qbit-state--stalled";  // ← merged error into stalled
    if (s.includes("check") || s.includes("hash")) return "qbit-state--checking";
    if (s.includes("alloc") || s.includes("moving")) return "qbit-state--moving";
    if (s === "completed") return "qbit-state--completed";
    if (s.includes("queue")) return "qbit-state--queued";
    return "qbit-state--queued";
  }

  function stateLabel(state) {
    const s = (state || "").toLowerCase();
    const map = {
      downloading: "DL", forcedDL: "DL",
      uploading: "SEED",
      seeding: "SEED", forcedseeding: "SEED",
      pausedUP: "PAUSED", pausedDL: "PAUSED",
      stoppedUP: "STOPPED", stoppedDL: "STOPPED",
      stalledUP: "SEED",
      stalledDL: "STALLED",
      checkingUP: "CHECK", checkingDL: "CHECK", checkingResumeData: "CHECK",
      error: "STALLED", missingfiles: "STALLED",
      allocating: "ALLOC", moving: "MOVING",
      completed: "DONE", queuedUP: "QUEUED", queuedDL: "QUEUED",
      unknown: "?"
    };
    return map[state] || (s.includes("download") ? "DL" : s.includes("seed") || s.includes("upload") ? "SEED" : s.includes("stall") || s.includes("error") || s.includes("missing") ? "STALLED" : state?.toUpperCase()?.slice(0, 6) || "?");
  }

  function isActive(state) {
    const s = (state || "").toLowerCase();
    return s.includes("download") || s.includes("upload") ||
      s === "seeding" || s === "forcedseeding" || s === "stalledup" ||
      s === "metadl" || s === "forceddl" || s === "checkingdl" || s === "checkingup";
  }

  function isPaused(state) {
    const s = (state || "").toLowerCase();
    return s.includes("pause") || s.includes("stop");
  }

  /* ── Filter + sort ── */
  function getFilteredSorted(torrents) {
    let list = [...(torrents || [])];

    if (_filterState === "downloading") {
      list = list.filter(t => {
        const s = (t.state || "").toLowerCase();
        return s.includes("download") || s === "metadl" || s === "forceddl";
      });
    } else if (_filterState === "seeding") {
      list = list.filter(t => {
        const s = (t.state || "").toLowerCase();
        return s.includes("seed") || s.includes("upload") || s === "stalledup";
      });
    } else if (_filterState === "paused") {
      list = list.filter(t => isPaused(t.state));
    } else if (_filterState === "stalled") {
      list = list.filter(t => {
        const s = (t.state || "").toLowerCase();
        return s.includes("stalled") || s === "stalleddown";
      });
    } else if (_filterState === "error") {
      list = list.filter(t => {
        const s = (t.state || "").toLowerCase();
        return s.includes("error") || s === "missingfiles";
      });
    } else if (_filterState === "active") {
      list = list.filter(t => isActive(t.state));
    }

    if (_searchQuery) {
      const q = _searchQuery.toLowerCase();
      list = list.filter(t => (t.name || "").toLowerCase().includes(q) || (t.category || "").toLowerCase().includes(q));
    }

    const sorters = {
      name: (a, b) => (a.name || "").localeCompare(b.name || ""),
      size: (a, b) => (b.size || 0) - (a.size || 0),
      progress: (a, b) => (b.progress || 0) - (a.progress || 0),
      speed: (a, b) => ((b.dlspeed || 0) + (b.upspeed || 0)) - ((a.dlspeed || 0) + (a.upspeed || 0)),
      ratio: (a, b) => (b.ratio || 0) - (a.ratio || 0),
      added: (a, b) => (b.added_on || 0) - (a.added_on || 0),
    };
    list.sort(sorters[_sortKey] || sorters.name);

    return list;
  }

  /* ── Counts for filter tabs ── */
  function getCounts(torrents) {
    return {
      all: (torrents || []).length,
      active: (torrents || []).filter(t => isActive(t.state)).length,
      downloading: (torrents || []).filter(t => {
        const s = (t.state || "").toLowerCase();
        return s.includes("download") || s === "metadl" || s === "forceddl";
      }).length,
      seeding: (torrents || []).filter(t => {
        const s = (t.state || "").toLowerCase();
        return s.includes("seed") || s.includes("upload") || s === "stalledup";
      }).length,
      paused: (torrents || []).filter(t => isPaused(t.state)).length,
      stalled: (torrents || []).filter(t => {
        const s = (t.state || "").toLowerCase();
        return s === "stalleddl" || s.includes("error") || s === "missingfiles";
      }).length,
      error: (torrents || []).filter(t => {
        const s = (t.state || "").toLowerCase();
        return s.includes("error") || s === "missingfiles";
      }).length,
    };
  }

  /* ── HTML builders ── */
  function buildServerTabs() {
    const activeUrl = QBIT_CONFIG.servers[_activeIdx].url;
    return `<div style="display:flex;align-items:center;gap:6px;">
    <div class="qbit-server-tabs">
      ${QBIT_CONFIG.servers.map((s, i) => {
      const status = _serverStatus[i];
      const dotCls = status === "ok" ? "qbit-server-dot--ok" : status === "err" ? "qbit-server-dot--err" : "qbit-server-dot--loading";
      const count = (_torrents[i] || []).length;
      return `<button class="qbit-server-tab${i === _activeIdx ? " qbit-server-tab--active" : ""}" data-idx="${i}">
          <span class="qbit-server-dot ${dotCls}"></span>
          ${escH(s.label)}${status === "ok" ? ` (${count})` : ""}
        </button>`;
    }).join("")}
    </div>
    <a href="${escH(activeUrl)}" target="_blank" rel="noopener noreferrer"
       class="qbit-open-link" title="Open ${escH(QBIT_CONFIG.servers[_activeIdx].label)}">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
        <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
      </svg>
      Open
    </a>
  </div>`;
  }

  function buildSpeedsBar() {
    const info = _transferInfo[_activeIdx] || {};
    const maindata = _maindata[_activeIdx] || {};
    const freeSpace = maindata.server_state?.free_space_on_disk ?? info.free_space_on_disk ?? null;

    return `
      <div class="qbit-speeds-bar">
        <div class="qbit-speed-card">
          <div class="qbit-speed-val qbit-speed-val--dl">${escH(fmtSpeed(info.dl_info_speed))}</div>
          <div class="qbit-speed-label">↓ Download</div>
        </div>
        <div class="qbit-speed-card">
          <div class="qbit-speed-val qbit-speed-val--ul">${escH(fmtSpeed(info.up_info_speed))}</div>
          <div class="qbit-speed-label">↑ Upload</div>
        </div>
        <div class="qbit-speed-card">
          <div class="qbit-speed-val qbit-speed-val--ratio">${escH(fmtBytes(info.dl_info_data))} / ${escH(fmtBytes(info.up_info_data))}</div>
          <div class="qbit-speed-label">Session DL / UL</div>
        </div>
        <div class="qbit-speed-card">
          <div class="qbit-speed-val qbit-speed-val--free">${escH(fmtBytes(freeSpace))}</div>
          <div class="qbit-speed-label">Free Space</div>
        </div>
      </div>`;
  }

  function buildToolbar() {
    const sel = _selectedHashes.size;
    const torrents = _torrents[_activeIdx] || [];
    const selTorrents = torrents.filter(t => _selectedHashes.has(t.hash));
    const anyPaused = selTorrents.some(t => isPaused(t.state));
    const anyActive = selTorrents.some(t => !isPaused(t.state));

    return `
      <div class="qbit-toolbar">
        ${sel > 0 ? `
          <span class="qbit-selection-badge">${sel} selected</span>
          <span class="qbit-toolbar-sep"></span>
          ${anyPaused ? `<button class="qbit-toolbar-btn qbit-toolbar-btn--resume" data-action="resume-sel">▶ Resume</button>` : ""}
          ${anyActive ? `<button class="qbit-toolbar-btn qbit-toolbar-btn--pause" data-action="pause-sel">⏸ Pause</button>` : ""}
          <button class="qbit-toolbar-btn qbit-toolbar-btn--delete" data-action="delete-sel">🗑 Delete</button>
          <span class="qbit-toolbar-sep"></span>
          <button class="qbit-toolbar-btn" data-action="deselect-all">✕ Deselect</button>
        ` : `
          <button class="qbit-toolbar-btn qbit-toolbar-btn--resume" data-action="resume-all">▶ Resume All</button>
          <button class="qbit-toolbar-btn qbit-toolbar-btn--pause" data-action="pause-all">⏸ Pause All</button>
          <span class="qbit-toolbar-sep"></span>
          <button class="qbit-toolbar-btn" data-action="recheck-all">🔍 Recheck All</button>
        `}
      </div>`;
  }

  function buildFilterBar(counts) {
    const filters = [
      { key: "all", label: `All (${counts.all})` },
      { key: "active", label: `Active (${counts.active})` },
      { key: "downloading", label: `DL (${counts.downloading})` },
      { key: "seeding", label: `Seed (${counts.seeding})` },
      { key: "paused", label: `Paused (${counts.paused})` },
      { key: "stalled", label: `Stalled (${counts.stalled})` },
      { key: "error", label: `Error (${counts.error})` },
    ];
    return `
    <div class="qbit-filter-bar">
      <input class="qbit-search" type="text" placeholder="Search torrents…"
             value="${escH(_searchQuery)}" id="qbit-search" autocomplete="off" />
      <div class="qbit-filter-tabs">
        ${filters.map(f => `
          <button class="qbit-filter-tab${_filterState === f.key ? " qbit-filter-tab--active" : ""}"
                  data-filter="${f.key}">${escH(f.label)}</button>`
    ).join("")}
      </div>
      <select class="qbit-sort-select" id="qbit-sort">
        <option value="" disabled ${_sortKey === "name" ? "" : "selected"} hidden>Sort</option>
        <option value="name"     ${_sortKey === "name" ? "selected" : ""}>Name</option>
        <option value="added"    ${_sortKey === "added" ? "selected" : ""}>Newest</option>
        <option value="size"     ${_sortKey === "size" ? "selected" : ""}>Size</option>
        <option value="progress" ${_sortKey === "progress" ? "selected" : ""}>Progress</option>
        <option value="speed"    ${_sortKey === "speed" ? "selected" : ""}>Speed</option>
        <option value="ratio"    ${_sortKey === "ratio" ? "selected" : ""}>Ratio</option>
      </select>
    </div>`;
  }

  function buildTorrentRow(t) {
    const sel = _selectedHashes.has(t.hash);
    const pct = Math.round((t.progress || 0) * 100);
    const sClass = stateClass(t.state);
    const sLabel = stateLabel(t.state);
    const paused = isPaused(t.state);
    const active = isActive(t.state);
    const fillCls = sClass.replace("qbit-state--", "qbit-progress-fill--");

    const metaChips = [
      active && t.dlspeed > 0 ? `<span class="qbit-meta-chip qbit-meta-chip--dl">↓ ${escH(fmtSpeed(t.dlspeed))}</span>` : "",
      active && t.upspeed > 0 ? `<span class="qbit-meta-chip qbit-meta-chip--ul">↑ ${escH(fmtSpeed(t.upspeed))}</span>` : "",
      active && t.eta ? `<span class="qbit-meta-chip">⏱ ${escH(fmtEta(t.eta))}</span>` : "",
      t.num_seeds != null ? `<span class="qbit-meta-chip">🌱 ${t.num_seeds}</span>` : "",
      t.ratio != null ? `<span class="qbit-meta-chip qbit-meta-chip--ratio">⇄ ${escH(fmtRatio(t.ratio))}</span>` : "",
      t.category ? `<span class="qbit-meta-chip qbit-meta-chip--cat">${escH(t.category)}</span>` : "",
      `<span class="qbit-meta-chip">${escH(fmtBytes(t.size))}</span>`,
    ].filter(Boolean).join("");

    const rowBtns = `
      <div class="qbit-torrent-actions">
        ${paused
        ? `<button class="qbit-row-btn qbit-row-btn--resume" data-hash="${escH(t.hash)}" data-btn="resume">▶ Resume</button>`
        : `<button class="qbit-row-btn qbit-row-btn--pause"  data-hash="${escH(t.hash)}" data-btn="pause">⏸ Pause</button>`
      }
        <button class="qbit-row-btn qbit-row-btn--recheck" data-hash="${escH(t.hash)}" data-btn="recheck">🔍 Recheck</button>
        <button class="qbit-row-btn qbit-row-btn--delete" data-hash="${escH(t.hash)}" data-btn="delete">🗑 Delete</button>
      </div>`;

    return `
      <div class="qbit-torrent-row${sel ? " qbit-torrent-row--selected" : ""}" data-hash="${escH(t.hash)}">
        <div class="qbit-torrent-top">
          <input type="checkbox" class="qbit-torrent-check" data-hash="${escH(t.hash)}" ${sel ? "checked" : ""} />
          <span class="qbit-torrent-name" title="${escH(t.name)}">${escH(t.name)}</span>
          <div class="qbit-torrent-right">
            <span class="qbit-state-badge ${sClass}">${sLabel}</span>
          </div>
        </div>
        <div class="qbit-torrent-progress">
          <div class="qbit-progress-track">
            <div class="qbit-progress-fill ${fillCls}" style="width:${pct}%"></div>
          </div>
          <span class="qbit-progress-pct">${pct}%</span>
        </div>
        <div class="qbit-torrent-meta">${metaChips}</div>
        ${rowBtns}
      </div>`;
  }

  function buildTorrentList(torrents) {
    if (_serverStatus[_activeIdx] === "err") {
      return `<div class="qbit-error">
        <div class="qbit-error-title">Connection Failed</div>
        <div class="qbit-error-msg">Could not reach ${escH(QBIT_CONFIG.servers[_activeIdx].label)}. Check credentials and connectivity.</div>
      </div>`;
    }

    if (_serverStatus[_activeIdx] === "loading") {
      return Array(4).fill(0).map((_, i) =>
        `<div class="qbit-skeleton" style="animation-delay:${i * 0.08}s"></div>`
      ).join("");
    }

    const filtered = getFilteredSorted(torrents);

    if (!filtered.length) {
      return `<div class="qbit-empty">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" opacity=".4">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        <div>${_searchQuery ? "No torrents match your search" : "No torrents in this filter"}</div>
      </div>`;
    }

    return `<div class="qbit-torrent-list">${filtered.map(buildTorrentRow).join("")}</div>`;
  }

  /* ── Full shell ── */
  function buildShell() {
    const torrents = _torrents[_activeIdx] || [];
    const counts = getCounts(torrents);

    return `
      <div class="qbit-shell">
        <div class="qbit-header">
          <div class="qbit-header-left">
            <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/webp/qbittorrent.webp"
                 alt="qBittorrent" class="qbit-icon">
            <span class="qbit-title">qBittorrent</span>
          </div>
          <div class="qbit-header-right">
            ${buildServerTabs()}
          </div>
        </div>

        ${buildSpeedsBar()}
        ${buildToolbar()}
        ${buildFilterBar(counts)}

        <div id="qbit-list">
          ${buildTorrentList(torrents)}
        </div>

        <div class="qbit-footer">
          ${escH(QBIT_CONFIG.servers[_activeIdx].label)} ·
          ${torrents.length} torrents ·
          Updated ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true })}
        </div>
      </div>`;
  }

  /* ── Delete confirmation overlay ── */
  function showDeleteConfirm(hashes) {
    return new Promise(resolve => {
      const overlay = document.createElement("div");
      overlay.className = "qbit-confirm-overlay";
      overlay.innerHTML = `
        <div class="qbit-confirm-box">
          <div class="qbit-confirm-title">Delete ${hashes.length} torrent${hashes.length !== 1 ? "s" : ""}?</div>
          <div class="qbit-confirm-msg">
            This will remove the torrent${hashes.length !== 1 ? "s" : ""} from qBittorrent.
          </div>
          <div class="qbit-confirm-check-row">
            <input type="checkbox" id="qbit-del-files" ${_deleteWithFiles ? "checked" : ""}>
            <label for="qbit-del-files">Also delete downloaded files</label>
          </div>
          <div class="qbit-confirm-buttons">
            <button class="qbit-confirm-btn qbit-confirm-btn--cancel">Cancel</button>
            <button class="qbit-confirm-btn qbit-confirm-btn--ok">Delete</button>
          </div>
        </div>`;

      overlay.querySelector(".qbit-confirm-btn--cancel").addEventListener("click", () => {
        overlay.remove(); resolve(null);
      });
      overlay.querySelector(".qbit-confirm-btn--ok").addEventListener("click", () => {
        _deleteWithFiles = overlay.querySelector("#qbit-del-files").checked;
        overlay.remove(); resolve(true);
      });
      overlay.addEventListener("click", e => { if (e.target === overlay) { overlay.remove(); resolve(null); } });
      document.body.appendChild(overlay);
    });
  }

  /* ── Actions ── */
  async function doAction(action, hashes, serverIdx) {
    const si = serverIdx ?? _activeIdx;
    const hashStr = Array.isArray(hashes) ? hashes.join("|") : hashes;

    const actionMap = {
      resume: "/torrents/resume",
      pause: "/torrents/pause",
      stop: "/torrents/stop",
      recheck: "/torrents/recheck",
    };

    if (action === "delete" || action === "deleteTorrent") {
      const confirmed = await showDeleteConfirm(Array.isArray(hashes) ? hashes : [hashes]);
      if (!confirmed) return;
      await qbitApiPost(si, "/torrents/delete", {
        hashes: hashStr,
        deleteFiles: String(_deleteWithFiles)
      });
    } else if (action === "resume-all") {
      await qbitApiPost(si, "/torrents/resume", { hashes: "all" });
    } else if (action === "pause-all") {
      await qbitApiPost(si, "/torrents/pause", { hashes: "all" });
    } else if (action === "recheck-all") {
      await qbitApiPost(si, "/torrents/recheck", { hashes: "all" });
    } else if (actionMap[action]) {
      await qbitApiPost(si, actionMap[action], { hashes: hashStr });
    }

    setTimeout(() => refreshServer(si, true), 800);
  }

  /* ── Event binding ── */
  function bindEvents(host) {
    host.querySelectorAll(".qbit-server-tab").forEach(btn => {
      if (btn._qbBound) return;
      btn._qbBound = true;
      btn.addEventListener("click", () => {
        _activeIdx = parseInt(btn.dataset.idx);
        _selectedHashes.clear();
        _searchQuery = "";
        _filterState = "all";
        paint(host);
      });
    });

    host.querySelectorAll(".qbit-filter-tab").forEach(btn => {
      if (btn._qbBound) return;
      btn._qbBound = true;
      btn.addEventListener("click", () => {
        _filterState = btn.dataset.filter;
        updateList(host);
        host.querySelectorAll(".qbit-filter-tab").forEach(b =>
          b.classList.toggle("qbit-filter-tab--active", b.dataset.filter === _filterState));
      });
    });

    const search = host.querySelector("#qbit-search");
    if (search && !search._qbBound) {
      search._qbBound = true;
      search.addEventListener("input", e => {
        _searchQuery = e.target.value;
        updateList(host);
      });
    }

    const sort = host.querySelector("#qbit-sort");
    if (sort && !sort._qbBound) {
      sort._qbBound = true;
      sort.addEventListener("change", e => {
        _sortKey = e.target.value;
        updateList(host);
      });
    }

    host.querySelectorAll("[data-action]").forEach(btn => {
      if (btn._qbBound) return;
      btn._qbBound = true;
      btn.addEventListener("click", async () => {
        const action = btn.dataset.action;
        if (action === "deselect-all") {
          _selectedHashes.clear();
          paint(host);
          return;
        }
        if (action === "resume-sel") {
          await doAction("resume", [..._selectedHashes]);
          _selectedHashes.clear();
          return;
        }
        if (action === "pause-sel") {
          await doAction("pause", [..._selectedHashes]);
          _selectedHashes.clear();
          return;
        }
        if (action === "delete-sel") {
          await doAction("delete", [..._selectedHashes]);
          _selectedHashes.clear();
          return;
        }
        await doAction(action, "all");
      });
    });

    host.querySelectorAll(".qbit-torrent-check").forEach(cb => {
      if (cb._qbBound) return;
      cb._qbBound = true;
      cb.addEventListener("change", e => {
        e.stopPropagation();
        const hash = cb.dataset.hash;
        if (cb.checked) _selectedHashes.add(hash);
        else _selectedHashes.delete(hash);
        const row = cb.closest(".qbit-torrent-row");
        if (row) row.classList.toggle("qbit-torrent-row--selected", cb.checked);
        const toolbar = host.querySelector(".qbit-toolbar");
        if (toolbar) toolbar.outerHTML = buildToolbar();
        bindEvents(host);
      });
    });

    host.querySelectorAll("[data-btn]").forEach(btn => {
      if (btn._qbBound) return;
      btn._qbBound = true;
      btn.addEventListener("click", async e => {
        e.stopPropagation();
        const hash = btn.dataset.hash;
        const action = btn.dataset.btn;
        btn.disabled = true;
        try { await doAction(action, [hash]); }
        catch (err) { console.error("[qbit]", err); }
        finally { btn.disabled = false; }
      });
    });
  }

  /* ── Paint ── */
  function paint(host) {
    if (!host) return;
    host.innerHTML = buildShell();
    bindEvents(host);
  }

  function updateList(host) {
    if (!host) return;
    const list = host.querySelector("#qbit-list");
    if (!list) return;
    list.innerHTML = buildTorrentList(_torrents[_activeIdx] || []);
    bindEvents(host);
  }

  /* ── Refresh ── */
  async function refreshServer(serverIdx, forcePaint = false) {
    const prevStatus = _serverStatus[serverIdx];
    try {
      const data = await fetchServerData(serverIdx);
      _torrents[serverIdx] = data.torrents;
      _transferInfo[serverIdx] = data.transferInfo;
      _maindata[serverIdx] = data.maindata;      // ← added
      _serverStatus[serverIdx] = "ok";
    } catch (err) {
      console.warn(`[qbit] Server ${serverIdx} fetch failed:`, err.message);
      _serverStatus[serverIdx] = "err";
    }

    const host = getHost();
    if (!host) return;

    if (forcePaint || prevStatus !== _serverStatus[serverIdx]) {
      paint(host);
    } else if (serverIdx === _activeIdx) {
      updateList(host);
      const speedsEl = host.querySelector(".qbit-speeds-bar");
      if (speedsEl) {
        const tmp = document.createElement("div");
        tmp.innerHTML = buildSpeedsBar();
        speedsEl.replaceWith(tmp.firstElementChild);
      }
      const footer = host.querySelector(".qbit-footer");
      if (footer) {
        footer.textContent =
          `${QBIT_CONFIG.servers[_activeIdx].label} · ` +
          `${(_torrents[_activeIdx] || []).length} torrents · ` +
          `Updated ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true })}`;
      }
      bindEvents(host);
    }
  }

  async function refreshAll() {
    await Promise.allSettled(
      QBIT_CONFIG.servers.map((_, i) => refreshServer(i))
    );
  }

  /* ── Render entry point ── */
  async function render() {
    if (_rendering) return;
    _rendering = true;
    try {
      const group = findGroupContainer();
      if (!group) return;
      const host = ensureHost(group);

      if (!host.querySelector(".qbit-shell")) {
        QBIT_CONFIG.servers.forEach((_, i) => { _serverStatus[i] = "loading"; });
        paint(host);
      }

      await refreshAll();
    } catch (err) {
      console.error("[qbit] Render error:", err);
    } finally {
      setTimeout(() => { _rendering = false; }, 1500);
    }
  }

  /* ── Init ── */
  function scheduleNext() {
    if (_pollTimer) clearTimeout(_pollTimer);
    _pollTimer = setTimeout(async () => {
      await refreshAll();
      scheduleNext();
    }, QBIT_CONFIG.pollMs);
  }

  function init() {
    const start = () => {
      setTimeout(async () => {
        await render();
        scheduleNext();
      }, 1200);
    };

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        refreshAll().then(scheduleNext);
      }
    });

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }

    new MutationObserver(() => {
      if (_obsDelay || document.querySelector(".qbit-host .qbit-shell")) return;
      _obsDelay = setTimeout(() => { _obsDelay = null; render(); }, 700);
    }).observe(document.body, { childList: true, subtree: true });
  }

  init();
})();