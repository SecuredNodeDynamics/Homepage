/* =====================================================
   LIDARR MEDIA — Custom widget
   Upcoming releases, Recent Artists, Download Queue
   Media Tab → group: LIDARR MEDIA
===================================================== */
(function () {

  const LDR_CONFIG = {
    groupName: "ARR - LIDARR",
    pollMs: 5 * 120 * 1000,
    url: "http://YOUR_LOCAL_IP:PORT",
    fallbackUrl: "https://YOUR_TUNNEL_URL", // or null if not using a tunnel
    activeUrl: null,
    key: "YOUR_API_KEY_HERE",
    color: "#c084fc",
  };

  /* ── Utilities ─────────────────────────────────── */
  function normText(v) { return (v || "").replace(/\s+/g, " ").trim(); }
  function escH(s = "") {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

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
    const list = group.querySelector("ul.services-list, ul");
    if (list) list.style.display = "none";
    host = document.createElement("div");
    host.className = "ldr-host " + cls;
    group.appendChild(host);
    return host;
  }

  /* ── Date helpers ──────────────────────────────── */
  function toLocalDate(isoStr) {
    if (!isoStr) return null;
    const d = new Date(isoStr);
    return isNaN(d) ? null : d;
  }

  function fmtDate(d) {
    if (!d) return "—";
    const today = new Date();
    const diff = Math.round((d - today) / 86400000);
    if (diff === 0) return "Today";
    if (diff === 1) return "Tomorrow";
    if (diff === -1) return "Yesterday";
    if (diff > 1 && diff < 8) return `In ${diff} days`;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  function fmtDateAdded(isoStr) {
    const d = toLocalDate(isoStr);
    if (!d) return "—";
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  function fmtBytes(bytes) {
    if (!bytes) return "—";
    if (bytes > 1e9) return (bytes / 1e9).toFixed(1) + " GB";
    if (bytes > 1e6) return (bytes / 1e6).toFixed(1) + " MB";
    return (bytes / 1e3).toFixed(0) + " KB";
  }

  /* ── Fallback-aware fetch ──────────────────────── */
  async function ldrFetch(path) {
    const candidates = [];
    if (LDR_CONFIG.activeUrl) candidates.push(LDR_CONFIG.activeUrl);
    if (!candidates.includes(LDR_CONFIG.url)) candidates.push(LDR_CONFIG.url);
    if (LDR_CONFIG.fallbackUrl && !candidates.includes(LDR_CONFIG.fallbackUrl)) candidates.push(LDR_CONFIG.fallbackUrl);

    let lastErr = null;
    for (const base of candidates) {
      try {
        const res = await fetch(`${base}${path}`, {
          headers: { "X-Api-Key": LDR_CONFIG.key },
          signal: (() => { const c = new AbortController(); setTimeout(() => c.abort(), 8000); return c.signal; })(),
        });
        if (!res.ok) throw new Error(`Lidarr ${res.status}: ${path}`);
        LDR_CONFIG.activeUrl = base;
        return res.json();
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error("All Lidarr URLs failed");
  }

  /* ── API fetchers ──────────────────────────────── */
  const BASE = LDR_CONFIG.url;
  const HEADERS = { "X-Api-Key": LDR_CONFIG.key };

  async function fetchUpcoming() {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const end = new Date(now.getFullYear(), now.getMonth() + 3, 0).toISOString();
    const data = await ldrFetch(`/api/v1/calendar?start=${start}&end=${end}&unmonitored=true`);
    return (Array.isArray(data) ? data : [])
      .map(a => ({
        title: a.title,
        artist: a.artist?.artistName || "Unknown Artist",
        releaseDate: toLocalDate(a.releaseDate),
        albumType: a.albumType || "",
        cover: a.images?.find(i => i.coverType === "cover")?.remoteUrl || null,
        link: a.artist?.foreignArtistId
          ? `${LDR_CONFIG.url}/artist/${a.artist.foreignArtistId}` : LDR_CONFIG.url,
      }))
      .sort((a, b) => a.releaseDate - b.releaseDate)
      .slice(0, 20);
  }

  async function fetchRecentArtists() {
    const data = await ldrFetch("/api/v1/artist");
    const all = Array.isArray(data) ? data : [];
    const totalArtists = all.length;
    const totalAlbums = all.reduce((s, a) => s + (a.statistics?.albumCount || 0), 0);
    const totalTracks = all.reduce((s, a) => s + (a.statistics?.totalTrackCount || 0), 0);
    const recent = all
      .sort((a, b) => new Date(b.added) - new Date(a.added))
      .slice(0, 10)
      .map(a => ({
        name: a.artistName,
        added: a.added,
        albumCount: a.statistics?.albumCount || 0,
        thumb: a.images?.find(i => i.coverType === "poster")?.remoteUrl || null,
        link: a.foreignArtistId ? `${LDR_CONFIG.url}/artist/${a.foreignArtistId}` : LDR_CONFIG.url,
      }));
    return { recent, totalArtists, totalAlbums, totalTracks };
  }

  async function fetchQueue() {
    const data = await ldrFetch("/api/v1/queue?pageSize=20&includeArtist=true&includeAlbum=true");
    const records = Array.isArray(data) ? data : (data.records || []);
    return records.map(q => ({
      title: q.album?.title || q.title || "Unknown",
      artist: q.artist?.artistName || "Unknown Artist",
      status: q.status || "unknown",
      trackedDownloadStatus: q.trackedDownloadStatus || "",
      progress: q.size && q.sizeleft != null
        ? Math.round((1 - q.sizeleft / q.size) * 100) : 0,
      sizeleft: q.sizeleft || 0,
      link: q.artist?.foreignArtistId
        ? `${LDR_CONFIG.url}/artist/${q.artist.foreignArtistId}` : LDR_CONFIG.url,
    }));
  }

  /* ── Status badge ──────────────────────────────── */
  function statusBadge(status, trackedStatus) {
    const map = {
      downloading: ["#2dd4bf", "Downloading"],
      paused: ["#fbbf24", "Paused"],
      queued: ["#94a3b8", "Queued"],
      completed: ["#4ade80", "Completed"],
      failed: ["#f87171", "Failed"],
      warning: ["#fb923c", "Warning"],
    };
    const key = trackedStatus?.toLowerCase() === "warning" ? "warning"
      : status?.toLowerCase();
    const [color, label] = map[key] || ["#94a3b8", status || "Unknown"];
    return `<span class="ldr-badge" style="background:${color}20;color:${color};border-color:${color}40">${escH(label)}</span>`;
  }

  function buildOverviewPanel() {
    function fmtNum(n) {
      return n.toLocaleString("en-US");
    }
    return `
    <div class="ldr-overview">
      <div class="ldr-stat-card">
        <div class="ldr-stat-icon">🎤</div>
        <div class="ldr-stat-value">${fmtNum(_ldrData.totalArtists)}</div>
        <div class="ldr-stat-label">Artists</div>
      </div>
      <div class="ldr-stat-card">
        <div class="ldr-stat-icon">💿</div>
        <div class="ldr-stat-value">${fmtNum(_ldrData.totalAlbums)}</div>
        <div class="ldr-stat-label">Albums</div>
      </div>
      <div class="ldr-stat-card">
        <div class="ldr-stat-icon">🎵</div>
        <div class="ldr-stat-value">${fmtNum(_ldrData.totalTracks)}</div>
        <div class="ldr-stat-label">Tracks</div>
      </div>
    </div>`;
  }

  /* ── Panel builders ────────────────────────────── */
  function buildUpcomingPanel(albums) {
    if (!albums.length) return `<div class="ldr-empty">No upcoming releases</div>`;
    return albums.map(a => {
      const isFuture = a.releaseDate && a.releaseDate > new Date();
      return `
      <a class="ldr-row ldr-row--link" href="${escH(a.link)}" target="_blank" rel="noopener">
        <div class="ldr-row-thumb">
          ${a.cover
          ? `<img src="${escH(a.cover)}" alt="" class="ldr-thumb-img"/>`
          : `<div class="ldr-thumb-placeholder">♪</div>`}
        </div>
        <div class="ldr-row-body">
          <div class="ldr-row-title">${escH(a.title)}</div>
          <div class="ldr-row-sub">${escH(a.artist)}
            ${a.albumType ? `<span class="ldr-type-tag">${escH(a.albumType)}</span>` : ""}
          </div>
        </div>
        <div class="ldr-row-meta">
          <span class="ldr-date ${isFuture ? "ldr-date--future" : "ldr-date--past"}">${escH(fmtDate(a.releaseDate))}</span>
          <span class="ldr-arrow">↗</span>
        </div>
      </a>`;
    }).join("");
  }

  function buildArtistsPanel(artists) {
    if (!artists.length) return `<div class="ldr-empty">No artists found</div>`;
    return artists.map(a => `
      <a class="ldr-row ldr-row--link" href="${escH(a.link)}" target="_blank" rel="noopener">
        <div class="ldr-row-thumb">
          ${a.thumb
        ? `<img src="${escH(a.thumb)}" alt="" class="ldr-thumb-img ldr-thumb-img--round"/>`
        : `<div class="ldr-thumb-placeholder ldr-thumb-placeholder--round">♪</div>`}
        </div>
        <div class="ldr-row-body">
          <div class="ldr-row-title">${escH(a.name)}</div>
          <div class="ldr-row-sub">Added ${escH(fmtDateAdded(a.added))}</div>
        </div>
        <div class="ldr-row-meta">
          <span class="ldr-stat-pill">${a.albumCount} album${a.albumCount !== 1 ? "s" : ""}</span>
          <span class="ldr-arrow">↗</span>
        </div>
      </a>`).join("");
  }

  function buildQueuePanel(queue) {
    if (!queue.length) return `<div class="ldr-empty">Queue is empty</div>`;
    return queue.map(q => {
      const pct = Math.max(0, Math.min(100, q.progress));
      const barColor = pct === 100 ? "#4ade80" : LDR_CONFIG.color;
      return `
      <a class="ldr-row ldr-row--link" href="${escH(q.link)}" target="_blank" rel="noopener">
        <div class="ldr-row-body">
          <div class="ldr-row-title">${escH(q.title)}</div>
          <div class="ldr-row-sub">${escH(q.artist)}</div>
          <div class="ldr-queue-bar">
            <div class="ldr-progress-track">
              <div class="ldr-progress-fill" style="width:${pct}%;background:${barColor}"></div>
            </div>
            <span class="ldr-progress-label">${pct}%</span>
          </div>
        </div>
        <div class="ldr-row-meta ldr-row-meta--queue">
          ${statusBadge(q.status, q.trackedDownloadStatus)}
          <span class="ldr-size">${escH(fmtBytes(q.sizeleft))} left</span>
          <span class="ldr-arrow">↗</span>
        </div>
      </a>`;
    }).join("");
  }

  /* ── State ─────────────────────────────────────── */
  let _ldrTab = "overview";
  let _ldrData = { upcoming: [], artists: [], queue: [], totalArtists: 0, totalAlbums: 0, totalTracks: 0 };
  let _ldrHost = null;
  let _ldrRendering = false;
  let _ldrLastUpdated = null;

  /* ── Shell ─────────────────────────────────────── */
  function buildShell(contentHtml, loading) {
    const tabs = [
      { key: "overview", label: "Library" },
      { key: "upcoming", label: "Upcoming" },
      { key: "artists", label: "Recent Artists" },
      { key: "queue", label: "Queue" },
    ];
    const tabsHtml = tabs.map(t => `
      <button class="ldr-tab ${_ldrTab === t.key ? "ldr-tab--active" : ""}" data-tab="${t.key}">
        ${t.label}${t.key === "queue" && _ldrData.queue.length
        ? ` <span class="ldr-tab-badge">${_ldrData.queue.length}</span>` : ""}
      </button>`).join("");

    const updatedStr = _ldrLastUpdated ? _ldrLastUpdated.toLocaleTimeString() : "";

    return `
      <div class="ldr-shell">
        <div class="ldr-hdr">
          <div class="ldr-hdr-left">
            <img src="/icons/lidarr.png" alt="Lidarr" style="width:32px;height:32px;object-fit:contain;flex-shrink:0;">
            <span class="ldr-title">Lidarr</span>
          </div>
          <div class="ldr-hdr-right">
            <div class="ldr-tabs">${tabsHtml}</div>
            <a class="ldr-open-link" href="${escH(BASE)}" target="_blank" rel="noopener">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
              </svg>
              Open
            </a>
          </div>
        </div>
        <div class="ldr-body">
          ${loading
        ? `<div class="ldr-loading">
                <svg class="ldr-spin" width="18" height="18" viewBox="0 0 24 24" fill="none"
                     stroke="${LDR_CONFIG.color}" stroke-width="2">
                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83
                           M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
                </svg> Loading…</div>`
        : `<div class="ldr-scroll">${contentHtml}</div>`}
        </div>
        <div class="ldr-footer">Lidarr · ${updatedStr}</div>
      </div>`;
  }

  /* ── Render ────────────────────────────────────── */
  function renderContent() {
    if (_ldrTab === "overview") return buildOverviewPanel();
    if (_ldrTab === "artists") return buildArtistsPanel(_ldrData.artists);
    if (_ldrTab === "queue") return buildQueuePanel(_ldrData.queue);
    return buildUpcomingPanel(_ldrData.upcoming);
  }

  function paint(loading = false) {
    if (!_ldrHost) return;
    _ldrHost.innerHTML = buildShell(loading ? "" : renderContent(), loading);
    bindEvents();
  }

  function bindEvents() {
    if (!_ldrHost) return;
    _ldrHost.querySelectorAll(".ldr-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        _ldrTab = btn.dataset.tab;
        paint();
      });
    });
  }

  async function renderWidget() {
    if (_ldrRendering) return;
    _ldrRendering = true;
    paint(true);
    try {
      const [upcoming, artistData, queue] = await Promise.all([
        fetchUpcoming(),
        fetchRecentArtists(),
        fetchQueue(),
      ]);
      _ldrData = {
        upcoming,
        artists: artistData.recent,
        queue,
        totalArtists: artistData.totalArtists,
        totalAlbums: artistData.totalAlbums,
        totalTracks: artistData.totalTracks,
      };
      _ldrLastUpdated = new Date();
      paint(false);
    } catch (err) {
      console.error("[LidarrWidget]", err);
      if (_ldrHost) _ldrHost.innerHTML = buildShell(
        `<div class="ldr-empty" style="color:#f87171">Failed to load Lidarr data</div>`, false);
    } finally {
      _ldrRendering = false;
    }
  }

  /* ── Init ──────────────────────────────────────── */
  function init() {
    const start = () => setTimeout(() => {
      const group = findGroup(LDR_CONFIG.groupName);
      if (!group) return;
      _ldrHost = ensureHost(group, "ldr-widget-host");
      renderWidget();
      setInterval(() => {
        if (document.hidden) return;
        renderWidget();
      }, LDR_CONFIG.pollMs);
    }, 1400);

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
        if (!document.querySelector(".ldr-widget-host .ldr-shell")) {
          const group = findGroup(LDR_CONFIG.groupName);
          if (!group) return;
          _ldrHost = ensureHost(group, "ldr-widget-host");
          renderWidget();
        }
      }, 700);
    }).observe(document.body, { childList: true, subtree: true });
  }

  init();
})();