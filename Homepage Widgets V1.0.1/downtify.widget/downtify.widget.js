/* =====================================================
   DOWNTIFY MUSIC WIDGET
===================================================== */
(function () {
  const DOWNTIFY_CONFIG = {
    baseUrl: "http://YOUR_LOCAL_IP:PORT",
    fallbackUrl: "https://YOUR_TUNNEL_URL",
    pathPrefix: "",
    activeUrl: null,
    groupName: "DOWNTIFY-MUSIC",
    pollMs: 45 * 1000,
    listSize: 8,
    debug: false,
  };

  let _currentTab = "overview";
  let _tabCache = {};
  let _lastPayload = null;
  let _searchMode = "albums";
  let _searchQuery = "";
  let _searchResults = [];
  let _searchMessage = "";
  let _searchLoading = false;
  let _libraryView = "artists";
  let _pollTimer = null;
  let _refreshing = false;
  let _recentItems = [];
  let _overviewRecentItems = [];
  let _libraryArtists = [];
  let _libraryAlbums = [];
  let _slowRefreshPromise = null;
  let _renderingSlowUpdate = false;

  function log(...args) {
    if (DOWNTIFY_CONFIG.debug) console.log("[Homepage Downtify]", ...args);
  }

  function normText(v) { return (v || "").replace(/\s+/g, " ").trim(); }

  function escH(s = "") {
    return String(s ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function openUrl() {
    return DOWNTIFY_CONFIG.activeUrl || DOWNTIFY_CONFIG.baseUrl;
  }

  function webBase() {
    const base = openUrl().replace(/\/$/, "");
    const prefix = (DOWNTIFY_CONFIG.pathPrefix || "").replace(/\/$/, "");
    return prefix ? `${base}${prefix.startsWith("/") ? prefix : `/${prefix}`}` : base;
  }

  function urlCandidates() {
    const out = [];
    if (DOWNTIFY_CONFIG.activeUrl) out.push(DOWNTIFY_CONFIG.activeUrl);
    if (DOWNTIFY_CONFIG.baseUrl && !out.includes(DOWNTIFY_CONFIG.baseUrl)) out.push(DOWNTIFY_CONFIG.baseUrl);
    if (DOWNTIFY_CONFIG.fallbackUrl && !out.includes(DOWNTIFY_CONFIG.fallbackUrl)) out.push(DOWNTIFY_CONFIG.fallbackUrl);
    return out.filter(Boolean).map(v => v.replace(/\/$/, ""));
  }

  function abortSignal(ms) {
    const c = new AbortController();
    setTimeout(() => c.abort(), ms);
    return c.signal;
  }

  function clientId() {
    const key = "downtify_homepage_client_id";
    try {
      let id = localStorage.getItem(key);
      if (!id) {
        id = `homepage-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        localStorage.setItem(key, id);
      }
      return id;
    } catch {
      return "homepage-widget";
    }
  }

  async function apiFetch(path, opts = {}) {
    let lastErr = null;
    for (const base of urlCandidates()) {
      try {
        const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
        const res = await fetch(url, {
          ...opts,
          headers: { Accept: "application/json", ...(opts.headers || {}) },
          signal: opts.signal || abortSignal(10000),
        });
        const contentType = res.headers.get("content-type") || "";
        if (!res.ok) {
          let detail = "";
          try {
            if (contentType.includes("application/json")) {
              const data = await res.json();
              detail = data?.detail || data?.message || "";
            } else {
              detail = await res.text();
            }
          } catch { }
          throw new Error(detail || `Downtify ${res.status}`);
        }
        DOWNTIFY_CONFIG.activeUrl = base;
        if (res.status === 204) return null;
        if (contentType.includes("application/json")) return res.json();
        return res.text();
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error("All URLs failed for Downtify");
  }

  function apiPost(path, body = null) {
    return apiFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body == null ? null : JSON.stringify(body),
    });
  }

  function fmtBytes(bytes) {
    if (bytes == null || bytes <= 0) return "-";
    if (bytes >= 1e12) return (bytes / 1e12).toFixed(2) + " TB";
    if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + " GB";
    if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + " MB";
    if (bytes >= 1e3) return (bytes / 1e3).toFixed(0) + " KB";
    return `${bytes} B`;
  }

  function firstNumber(...values) {
    for (const value of values) {
      const num = Number(value);
      if (Number.isFinite(num) && num > 0) return num;
    }
    return 0;
  }

  function fmtDate(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  function songTitle(item) {
    return item?.title || item?.name || item?.song?.title || item?.song?.name || "Unknown track";
  }

  function songArtists(item) {
    const fromSong = item?.song?.artists || item?.song?.artist;
    const artists = item?.artists || item?.artist || fromSong;
    if (Array.isArray(artists)) return artists.filter(Boolean).join(", ");
    return String(artists || "");
  }

  function songAlbum(item) {
    return item?.album || item?.album_name || item?.song?.album || item?.song?.album_name || "";
  }

  function songStatus(item) {
    return String(item?.status || "unknown");
  }

  function songUrl(item) {
    const song = item?.song || item || {};
    return song.url || song.source_url || item?.url || item?.source_url || "";
  }

  function songFile(item) {
    const song = item?.song || item || {};
    return item?.filename || item?.file || song.filename || song.file || "";
  }

  function songType(item) {
    const song = item?.song || item || {};
    const type = String(song.media_type || song.type || item?.media_type || item?.type || "track").toLowerCase();
    if (type.includes("album")) return "album";
    if (type.includes("artist")) return "artist";
    if (type.includes("playlist")) return "playlist";
    return "track";
  }

  function firstImageValue(...values) {
    for (const value of values) {
      if (!value) continue;
      if (typeof value === "string") return value;
      if (Array.isArray(value)) {
        const nested = firstImageValue(...value);
        if (nested) return nested;
      }
      if (typeof value === "object") {
        const nested = firstImageValue(
          value.url,
          value.src,
          value.href,
          value.cover_url,
          value.coverUrl,
          value.image_url,
          value.imageUrl
        );
        if (nested) return nested;
      }
    }
    return "";
  }

  function imageUrl(raw) {
    if (!raw) return "";
    if (/^https?:\/\//i.test(raw)) return raw;
    if (raw.startsWith("/")) return `${openUrl().replace(/\/$/, "")}${raw}`;
    return raw;
  }

  function songCover(item) {
    const song = item?.song || item || {};
    const raw = firstImageValue(
      song.cover_url,
      song.coverUrl,
      song.album_cover_url,
      song.albumCoverUrl,
      song.artwork_url,
      song.artworkUrl,
      song.thumbnail,
      song.thumbnail_url,
      song.thumbnailUrl,
      song.image,
      song.images,
      song.image_url,
      song.imageUrl,
      song.cover,
      song.art,
      song.album?.cover_url,
      song.album?.image_url,
      song.album?.images,
      song.artist?.image_url,
      song.artist?.images,
      item?.cover_url,
      item?.coverUrl,
      item?.album_cover_url,
      item?.albumCoverUrl,
      item?.artwork_url,
      item?.artworkUrl,
      item?.image_url,
      item?.imageUrl,
      item?.images,
      item?.thumbnail,
      item?.thumbnail_url,
      item?.thumbnailUrl
    );
    if (raw) return imageUrl(raw);
    const file = song.file || item?.file || song.filename || item?.filename || "";
    return file ? `${openUrl().replace(/\/$/, "")}/api/library/cover?file=${encodeURIComponent(file)}&size=160` : "";
  }

  function statusClass(status) {
    if (status === "done" || status === "ok") return "downtify-pill--ok";
    if (status === "downloading") return "downtify-pill--active";
    if (status === "queued" || status === "skipped") return "downtify-pill--muted";
    if (status === "error" || status === "attention" || status === "missing") return "downtify-pill--warn";
    return "downtify-pill--muted";
  }

  function countBy(items, keyFn) {
    const seen = new Set();
    for (const item of items || []) {
      const key = keyFn(item);
      if (key) seen.add(String(key).toLowerCase());
    }
    return seen.size;
  }

  function libraryKey(title, artists, album = "") {
    return [title, artists, album].map(v => normText(String(v || "")).toLowerCase()).join("|");
  }

  function libraryIndex(library) {
    const tracks = new Set();
    const artists = new Set();
    const albums = new Set();
    for (const item of library || []) {
      const title = songTitle(item);
      const artist = songArtists(item);
      const album = songAlbum(item);
      if (title && artist) tracks.add(libraryKey(title, artist, album));
      if (artist) {
        artist.split(",").map(normText).filter(Boolean).forEach(v => artists.add(v.toLowerCase()));
      }
      if (album) albums.add(libraryKey(album, artist));
    }
    return { tracks, artists, albums };
  }

  function isOwned(item, index) {
    const type = songType(item);
    const title = songTitle(item);
    const artist = songArtists(item);
    const album = songAlbum(item);
    if (type === "album") return index.albums.has(libraryKey(title || album, artist)) || index.albums.has(libraryKey(album, artist));
    if (type === "artist") return index.artists.has(normText(title || artist).toLowerCase());
    return index.tracks.has(libraryKey(title, artist, album));
  }

  function mergePayload(partial = {}) {
    const previous = _lastPayload || {};
    _lastPayload = {
      health: partial.health !== undefined ? partial.health : previous.health || null,
      queue: Array.isArray(partial.queue) ? partial.queue : previous.queue || [],
      history: Array.isArray(partial.history) ? partial.history : previous.history || [],
      library: Array.isArray(partial.library) ? partial.library : previous.library || [],
      monitor: Array.isArray(partial.monitor) ? partial.monitor : previous.monitor || [],
      summary: partial.summary !== undefined ? partial.summary : previous.summary || null,
      capabilities: partial.capabilities !== undefined ? partial.capabilities : previous.capabilities || null,
      coreOnline: partial.coreOnline !== undefined ? partial.coreOnline : previous.coreOnline || false,
      coreErrors: partial.coreErrors !== undefined ? partial.coreErrors : previous.coreErrors || 0,
      optionalErrors: partial.optionalErrors !== undefined ? partial.optionalErrors : previous.optionalErrors || 0,
      errors: partial.coreErrors !== undefined ? partial.coreErrors : previous.errors || 0,
    };
    return _lastPayload;
  }

  function refreshCurrentTabFromBackground() {
    if (_currentTab === "search") return;
    const shell = document.querySelector(".downtify-widget-host .downtify-shell");
    if (!shell || _refreshing) return;
    _tabCache = {};
    _renderingSlowUpdate = true;
    switchTab(shell, _currentTab, true)
      .catch(err => console.error("[Homepage Downtify]", err))
      .finally(() => {
        _renderingSlowUpdate = false;
      });
  }

  function startSlowDataRefresh(force = false) {
    const needsSlowData = force || !_lastPayload?.summary || !_lastPayload?.health || !_lastPayload?.monitor?.length;
    if (!needsSlowData || _slowRefreshPromise) return _slowRefreshPromise;

    _slowRefreshPromise = Promise.allSettled([
      apiFetch("/api/summary", { signal: abortSignal(10000) }),
      apiFetch("/api/health", { signal: abortSignal(20000) }),
      apiFetch("/api/monitor/playlists", { signal: abortSignal(20000) }),
    ]).then(([summaryRes, healthRes, monitorRes]) => {
      const partial = {};
      if (summaryRes.status === "fulfilled") partial.summary = summaryRes.value;
      if (healthRes.status === "fulfilled") partial.health = healthRes.value;
      if (monitorRes.status === "fulfilled" && Array.isArray(monitorRes.value)) partial.monitor = monitorRes.value;
      partial.optionalErrors = [summaryRes, healthRes, monitorRes].filter(r => r.status === "rejected").length;
      mergePayload(partial);
      refreshCurrentTabFromBackground();
    }).catch(err => {
      console.error("[Homepage Downtify]", err);
    }).finally(() => {
      _slowRefreshPromise = null;
    });

    return _slowRefreshPromise;
  }

  async function loadWidgetData(force = false) {
    if (_lastPayload && !force) return _lastPayload;
    const previous = _lastPayload;

    const [summaryRes, queueRes, historyRes, capsRes] = await Promise.allSettled([
      apiFetch("/api/summary", { signal: abortSignal(7000) }),
      apiFetch("/api/queue", { signal: abortSignal(6000) }),
      apiFetch("/api/history?limit=25&include_active=true&reconcile=false", { signal: abortSignal(8000) }),
      apiFetch("/api/capabilities", { signal: abortSignal(6000) }),
    ]);
    const nextSummary = summaryRes.status === "fulfilled" ? summaryRes.value : previous?.summary || null;
    const nextQueue = queueRes.status === "fulfilled" && Array.isArray(queueRes.value) ? queueRes.value : previous?.queue || [];
    const nextHistory = historyRes.status === "fulfilled" && Array.isArray(historyRes.value) ? historyRes.value : previous?.history || [];
    const nextCapabilities = capsRes.status === "fulfilled" ? capsRes.value : previous?.capabilities || null;
    const coreOnline = Boolean(
      summaryRes.status === "fulfilled" ||
      queueRes.status === "fulfilled" ||
      historyRes.status === "fulfilled" ||
      capsRes.status === "fulfilled" ||
      previous?.coreOnline
    );
    const coreErrors = [
      summaryRes.status === "rejected" && !previous?.summary,
      queueRes.status === "rejected" && !previous?.queue,
      historyRes.status === "rejected" && !previous?.history,
      capsRes.status === "rejected" && !previous?.capabilities,
    ].filter(Boolean).length;

    const payload = mergePayload({
      summary: nextSummary,
      queue: nextQueue,
      history: nextHistory,
      capabilities: nextCapabilities,
      coreOnline,
      coreErrors,
    });
    if (!_renderingSlowUpdate) startSlowDataRefresh(force);
    return payload;
  }

  async function ensureLibraryData(force = false) {
    const payload = await loadWidgetData();
    if (payload.library?.length && !force) return payload.library;
    try {
      const items = await apiFetch("/api/library/files", { signal: abortSignal(30000) });
      if (Array.isArray(items)) {
        mergePayload({ library: items });
        return items;
      }
    } catch (err) {
      console.error("[Homepage Downtify]", err);
    }
    return _lastPayload?.library || [];
  }

  function findGroupContainer() {
    const headings = Array.from(document.querySelectorAll("h2, h3, .group-title, .service-group-name"));
    const heading = headings.find(el => normText(el.textContent) === DOWNTIFY_CONFIG.groupName);
    if (!heading) { log("Group not found"); return null; }
    return heading.closest("section") || heading.closest("div[class*='group']")
      || heading.parentElement?.parentElement || heading.parentElement;
  }

  function ensureHost(group) {
    let row = group.querySelector(".hp-widget-row, .downtify-flex-row");
    if (!row) {
      const list = group.querySelector("ul.services-list, ul");
      if (list) list.style.display = "none";
      row = document.createElement("div");
      row.className = "hp-widget-row downtify-flex-row";
      group.appendChild(row);
    }
    let host = row.querySelector(".downtify-widget-host");
    if (host) return host;
    host = document.createElement("div");
    host.className = "downtify-widget-host";
    row.appendChild(host);
    return host;
  }

  function statCard(value, label, extra = "") {
    return `
      <div class="downtify-stat-card${extra ? ` ${extra}` : ""}">
        <div class="downtify-stat-num">${escH(value)}</div>
        <div class="downtify-stat-label">${escH(label)}</div>
      </div>`;
  }

  function overviewStat(value, label, iconPath, extra = "") {
    return `
      <div class="downtify-overview-stat${extra ? ` ${extra}` : ""}">
        <div class="downtify-overview-stat-icon">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">${iconPath}</svg>
        </div>
        <div>
          <div class="downtify-stat-num">${escH(value)}</div>
          <div class="downtify-stat-label">${escH(label)}</div>
        </div>
      </div>`;
  }

  function trackRow(item, index, options = {}) {
    const status = songStatus(item);
    const title = escH(songTitle(item));
    const artists = escH(songArtists(item));
    const album = escH(songAlbum(item));
    const cover = songCover(item);
    const meta = [artists, album, fmtDate(item?.completed_at || item?.updated_at || item?.created_at)].filter(Boolean).join(" · ");
    const progress = typeof item?.progress === "number" ? Math.max(0, Math.min(100, item.progress)) : null;

    const popupAttrs = options.popupIndex != null
      ? ` role="button" tabindex="0" data-downtify-overview-index="${options.popupIndex}"`
      : "";
    return `
      <div class="downtify-song-row${options.active ? " downtify-song-row--active" : ""}${options.popupIndex != null ? " downtify-song-row--interactive" : ""}"${popupAttrs} style="animation-delay:${index * 25}ms">
        <div class="downtify-song-art">
          ${cover
        ? `<img src="${escH(cover)}" alt="${title}" loading="lazy" decoding="async" onerror="this.closest('.downtify-song-art')?.classList.add('downtify-song-art--missing'); this.remove();">`
        : `<div class="downtify-song-placeholder"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>`}
          ${options.active ? `<div class="downtify-playing-dot"></div>` : ""}
        </div>
        <div class="downtify-song-body">
          <div class="downtify-song-title">${title}</div>
          ${meta ? `<div class="downtify-song-meta">${escH(meta)}</div>` : ""}
          ${progress != null ? `<div class="downtify-progress"><span style="width:${progress}%"></span></div>` : ""}
        </div>
        <div class="downtify-song-right">
          <span class="downtify-pill ${statusClass(status)}">${escH(status)}</span>
        </div>
      </div>`;
  }

  function trackCard(item, index) {
    const status = songStatus(item);
    const title = escH(songTitle(item));
    const artists = escH(songArtists(item));
    const album = escH(songAlbum(item));
    const cover = songCover(item);
    const meta = [artists, album, fmtDate(item?.completed_at || item?.updated_at || item?.created_at)].filter(Boolean).join(" · ");
    return `
      <button class="downtify-track-card" type="button" data-downtify-recent-index="${index}" style="animation-delay:${index * 25}ms">
        <div class="downtify-track-card__art">
          ${cover
        ? `<img src="${escH(cover)}" alt="${title}" loading="lazy" decoding="async" onerror="this.closest('.downtify-track-card__art')?.classList.add('downtify-track-card__art--missing'); this.remove();">`
        : `<div class="downtify-song-placeholder"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>`}
          <div class="downtify-track-card__shade"></div>
          <span class="downtify-track-card__pill ${statusClass(status)}">${escH(status)}</span>
        </div>
        <div class="downtify-track-card__meta">
          <div class="downtify-track-card__title">${title}</div>
          <div class="downtify-track-card__sub">${escH(meta)}</div>
        </div>
      </button>`;
  }

  function sliderShell(items) {
    _recentItems = items;
    return `
      <div class="downtify-slider-shell">
        <div class="downtify-slider-head">
          <div>
            <div class="downtify-section-label">Recent Downloads</div>
            <div class="downtify-panel-title">${items.length.toLocaleString()} latest completed tracks</div>
          </div>
          <div class="downtify-slider-actions">
            <button class="downtify-slider-btn downtify-slider-btn--left" type="button" aria-label="Scroll recent downloads left">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m15 18-6-6 6-6"/></svg>
            </button>
            <button class="downtify-slider-btn downtify-slider-btn--right" type="button" aria-label="Scroll recent downloads right">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg>
            </button>
          </div>
        </div>
        <div class="downtify-track-slider">${items.map((item, i) => trackCard(item, i)).join("")}</div>
      </div>`;
  }

  function closeTrackPopup() {
    document.querySelector(".downtify-popup-backdrop")?.remove();
    document.querySelector(".downtify-track-popup")?.remove();
  }

  function openTrackPopup(item) {
    if (!item) return;
    closeTrackPopup();
    const title = escH(songTitle(item));
    const artists = escH(songArtists(item));
    const album = escH(songAlbum(item));
    const cover = songCover(item);
    const status = songStatus(item);
    const completed = fmtDate(item?.completed_at || item?.updated_at || item?.created_at);
    const backdrop = document.createElement("div");
    backdrop.className = "downtify-popup-backdrop";
    backdrop.addEventListener("click", closeTrackPopup);

    const popup = document.createElement("section");
    popup.className = "downtify-track-popup";
    popup.setAttribute("role", "dialog");
    popup.setAttribute("aria-modal", "true");
    popup.setAttribute("aria-label", songTitle(item));
    popup.innerHTML = `
      <div class="downtify-track-popup__bg"${cover ? ` style="background-image:url('${escH(cover)}')"` : ""}></div>
      <div class="downtify-track-popup__body">
        <button class="downtify-track-popup__close" type="button" aria-label="Close">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
        <div class="downtify-track-popup__art">
          ${cover
        ? `<img src="${escH(cover)}" alt="${title}" loading="eager" decoding="async">`
        : `<div class="downtify-song-placeholder"><svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>`}
        </div>
        <div class="downtify-track-popup__content">
          <span class="downtify-pill ${statusClass(status)}">${escH(status)}</span>
          <h3>${title}</h3>
          <div class="downtify-track-popup__meta-grid">
            <div class="downtify-track-popup__meta-item">
              <span>Artist</span>
              <strong>${artists || "Unknown artist"}</strong>
            </div>
            <div class="downtify-track-popup__meta-item">
              <span>Album</span>
              <strong>${album || "Unknown album"}</strong>
            </div>
            ${completed ? `<div class="downtify-track-popup__meta-item">
              <span>Added</span>
              <strong>${escH(completed)}</strong>
            </div>` : ""}
          </div>
        </div>
      </div>`;
    popup.querySelector(".downtify-track-popup__close")?.addEventListener("click", closeTrackPopup);
    document.body.appendChild(backdrop);
    document.body.appendChild(popup);
    requestAnimationFrame(() => {
      backdrop.classList.add("is-open");
      popup.classList.add("is-open");
    });
  }

  function monitorRow(item, index) {
    const name = escH(item?.name || "Monitored playlist");
    const kind = escH(item?.kind || "playlist");
    const interval = item?.interval_minutes ? `${item.interval_minutes}m` : "";
    const last = fmtDate(item?.last_checked_at || item?.updated_at);
    const sub = [kind, interval, last ? `checked ${last}` : ""].filter(Boolean).join(" · ");
    const img = imageUrl(firstImageValue(item?.image_url, item?.imageUrl, item?.images, item?.thumbnail_url, item?.thumbnailUrl, item?.cover_url, item?.coverUrl));
    const status = item?.enabled === false ? "paused" : "watching";
    return `
      <div class="downtify-monitor-row" style="animation-delay:${index * 25}ms">
        <div class="downtify-song-art">
          ${img ? `<img src="${escH(img)}" alt="${name}" loading="lazy" decoding="async" onerror="this.closest('.downtify-song-art')?.classList.add('downtify-song-art--missing'); this.remove();">` : `<div class="downtify-song-placeholder"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m8 9 5 3-5 3V9z"/></svg></div>`}
        </div>
        <div class="downtify-song-body">
          <div class="downtify-song-title">${name}</div>
          <div class="downtify-song-meta">${escH(sub)}</div>
        </div>
        <span class="downtify-pill ${status === "watching" ? "downtify-pill--ok" : "downtify-pill--muted"}">${status}</span>
      </div>`;
  }

  function groupedMedia(items, keyFn, kind) {
    const groups = new Map();
    for (const item of items || []) {
      const name = normText(keyFn(item));
      if (!name) continue;
      const key = name.toLowerCase();
      const current = groups.get(key) || { name, kind, count: 0, cover: "", albums: new Map() };
      current.count += 1;
      if (!current.artist) current.artist = songArtists(item);
      const albumName = songAlbum(item);
      if (albumName) {
        const albumKey = albumName.toLowerCase();
        const album = current.albums.get(albumKey) || { name: albumName, cover: "", count: 0 };
        album.count += 1;
        if (!album.cover) album.cover = songCover(item);
        current.albums.set(albumKey, album);
      }
      if (!current.cover) current.cover = songCover(item);
      groups.set(key, current);
    }
    return Array.from(groups.values())
      .map(item => {
        const albums = Array.from(item.albums.values()).sort((a, b) => a.name.localeCompare(b.name));
        return { ...item, albumCount: albums.length, albums };
      })
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  function monitoredArtistSet(items) {
    return new Set((items || [])
      .filter(item => String(item?.kind || "").toLowerCase() === "artist" && item.enabled !== false)
      .map(item => normText(item?.name).toLowerCase())
      .filter(Boolean));
  }

  function mediaShelf(label, items) {
    if (!items.length) return "";
    return `
      <div class="downtify-section-label downtify-section-spaced">${escH(label)}</div>
      <div class="downtify-media-shelf">
        ${items.map((item, index) => `
          <div class="downtify-media-card" style="animation-delay:${index * 25}ms">
            <div class="downtify-media-art${item.kind === "artist" ? " downtify-media-art--artist" : ""}">
              ${item.cover
        ? `<img src="${escH(item.cover)}" alt="${escH(item.name)}" loading="lazy" decoding="async" onerror="this.closest('.downtify-media-art')?.classList.add('downtify-media-art--missing'); this.remove();">`
        : `<div class="downtify-song-placeholder"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>`}
            </div>
            <div class="downtify-media-name">${escH(item.name)}</div>
            <div class="downtify-media-meta">${item.count.toLocaleString()} ${item.kind === "artist" ? "track" : "song"}${item.count === 1 ? "" : "s"}</div>
          </div>`).join("")}
      </div>`;
  }

  function libraryMediaCard(item, index) {
    const countLabel = item.kind === "artist"
      ? `${item.count.toLocaleString()} track${item.count === 1 ? "" : "s"}`
      : `${item.count.toLocaleString()} song${item.count === 1 ? "" : "s"}`;
    return `
      <div class="downtify-library-card" role="button" tabindex="0" data-library-card-kind="${item.kind}" data-library-card-index="${index}" style="animation-delay:${index * 18}ms">
        ${item.kind === "artist" && item.monitored ? `<span class="downtify-library-monitor-eye" title="Monitored artist" aria-label="Monitored artist">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>
        </span>` : ""}
        <div class="downtify-library-card__art${item.kind === "artist" ? " downtify-library-card__art--artist" : ""}">
          ${item.cover
        ? `<img src="${escH(item.cover)}" alt="${escH(item.name)}" loading="lazy" decoding="async" onerror="this.closest('.downtify-library-card__art')?.classList.add('downtify-media-art--missing'); this.remove();">`
        : `<div class="downtify-song-placeholder"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>`}
        </div>
        <div class="downtify-library-card__name">${escH(item.name)}</div>
        <div class="downtify-library-card__meta">${countLabel}</div>
      </div>`;
  }

  function openLibraryMediaPopup(item) {
    if (!item) return;
    closeTrackPopup();
    const title = escH(item.name);
    const cover = item.cover;
    const isArtist = item.kind === "artist";
    const albumCards = isArtist
      ? (item.albums || []).map(album => `
        <div class="downtify-artist-album-card">
          <div class="downtify-artist-album-card__art">
            ${album.cover
          ? `<img src="${escH(album.cover)}" alt="${escH(album.name)}" loading="lazy" decoding="async" onerror="this.closest('.downtify-artist-album-card__art')?.classList.add('downtify-media-art--missing'); this.remove();">`
          : `<div class="downtify-song-placeholder"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>`}
          </div>
          <div class="downtify-artist-album-card__name">${escH(album.name)}</div>
          <div class="downtify-artist-album-card__meta">${album.count.toLocaleString()} track${album.count === 1 ? "" : "s"}</div>
        </div>`).join("")
      : "";
    const backdrop = document.createElement("div");
    backdrop.className = "downtify-popup-backdrop";
    backdrop.addEventListener("click", closeTrackPopup);

    const popup = document.createElement("section");
    popup.className = "downtify-track-popup";
    popup.setAttribute("role", "dialog");
    popup.setAttribute("aria-modal", "true");
    popup.setAttribute("aria-label", item.name);
    popup.innerHTML = `
      <div class="downtify-track-popup__bg"${cover ? ` style="background-image:url('${escH(cover)}')"` : ""}></div>
      <div class="downtify-track-popup__body">
        <button class="downtify-track-popup__close" type="button" aria-label="Close">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
        <div class="${isArtist ? "downtify-track-popup__artist-side" : "downtify-track-popup__art"}">
          <div class="downtify-track-popup__art${isArtist ? " downtify-track-popup__art--artist" : ""}">
            ${cover
        ? `<img src="${escH(cover)}" alt="${title}" loading="eager" decoding="async">`
        : `<div class="downtify-song-placeholder"><svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>`}
          </div>
          ${isArtist ? `<div class="downtify-artist-monitor-bubble ${item.monitored ? "is-monitored" : ""}">
            ${item.monitored ? "Monitored" : "Not monitored"}
          </div>` : ""}
        </div>
        <div class="downtify-track-popup__content">
          <span class="downtify-pill downtify-pill--ok">${isArtist ? "artist" : "album"}</span>
          <h3>${title}</h3>
          ${isArtist ? `
            <div class="downtify-popup-section-title">${item.albumCount.toLocaleString()} downloaded album${item.albumCount === 1 ? "" : "s"}</div>
            <div class="downtify-artist-album-grid">${albumCards}</div>
          ` : `
            <div class="downtify-track-popup__meta-grid downtify-track-popup__meta-grid--equal">
              <div class="downtify-track-popup__meta-item">
                <span>Tracks</span>
                <strong>${item.count.toLocaleString()}</strong>
              </div>
              <div class="downtify-track-popup__meta-item">
                <span>Artist</span>
                <strong>${escH(item.artist || item.primaryArtist || "Various artists")}</strong>
              </div>
            </div>
          `}
        </div>
      </div>`;
    popup.querySelector(".downtify-track-popup__close")?.addEventListener("click", closeTrackPopup);
    document.body.appendChild(backdrop);
    document.body.appendChild(popup);
    requestAnimationFrame(() => {
      backdrop.classList.add("is-open");
      popup.classList.add("is-open");
    });
  }

  function libraryTrackRow(item, index) {
    const title = escH(songTitle(item));
    const artists = escH(songArtists(item));
    const album = escH(songAlbum(item));
    const cover = songCover(item);
    return `
      <div class="downtify-library-track" style="animation-delay:${index * 14}ms">
        <div class="downtify-library-track__art">
          ${cover
        ? `<img src="${escH(cover)}" alt="${title}" loading="lazy" decoding="async" onerror="this.closest('.downtify-library-track__art')?.classList.add('downtify-media-art--missing'); this.remove();">`
        : `<div class="downtify-song-placeholder"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>`}
        </div>
        <div class="downtify-library-track__main">
          <div class="downtify-library-track__title">${title}</div>
          <div class="downtify-library-track__meta">${artists || "Unknown artist"}</div>
        </div>
        <div class="downtify-library-track__album">${album || "Unknown album"}</div>
      </div>`;
  }

  function searchResultRow(item, index, owned = false) {
    const type = songType(item);
    const title = escH(songTitle(item));
    const artists = escH(songArtists(item));
    const album = escH(songAlbum(item));
    const cover = songCover(item);
    const url = songUrl(item);
    const trackCount = Number(item?.track_count || item?.tracks_count || item?.song_count || item?.trackCount || 0);
    const bits = [
      type,
      artists,
      album,
      item?.year || item?.release_date || "",
    ].filter(Boolean).join(" · ");
    const action = "Download";
    return `
      <div class="downtify-search-row${owned ? " downtify-search-row--owned" : ""}" style="animation-delay:${index * 25}ms">
        <div class="downtify-search-card-art">
          ${cover
        ? `<img src="${escH(cover)}" alt="${title}" loading="lazy" decoding="async" onerror="this.closest('.downtify-search-card-art')?.classList.add('downtify-media-art--missing'); this.remove();">`
        : `<div class="downtify-song-placeholder"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>`}
        </div>
        <div class="downtify-search-card-body">
          <div class="downtify-search-card-topline">
            <div class="downtify-search-card-type">${escH(type)}</div>
            ${type === "album" && trackCount ? `<div class="downtify-search-card-count">${trackCount.toLocaleString()} tracks</div>` : ""}
          </div>
          <div class="downtify-search-card-title">${title}</div>
          <div class="downtify-search-card-meta">${escH(bits)}</div>
        </div>
        <div class="downtify-search-actions">
          ${owned ? `<span class="downtify-pill downtify-pill--ok">owned</span>` : ""}
          <button class="downtify-action-btn" type="button" data-downtify-action="download" data-result-index="${index}" ${!url || owned ? "disabled" : ""}>${action}</button>
        </div>
      </div>`;
  }

  async function performSearch(shell, query, mode = _searchMode) {
    _searchQuery = normText(query);
    _searchMode = mode;
    _searchMessage = "";
    _searchResults = [];
    if (_searchQuery.length < 2) {
      _searchMessage = "Type at least 2 characters";
      renderSearchState(shell);
      return;
    }
    _searchLoading = true;
    renderSearchState(shell);
    try {
      const endpoint = `/api/songs/search?query=${encodeURIComponent(_searchQuery)}`;
      const data = await apiFetch(endpoint);
      const results = Array.isArray(data) ? data : (data?.results || []);
      _searchResults = results.filter(item => {
        const type = songType(item);
        if (mode === "albums") return type === "album";
        return type === "track";
      }).slice(0, DOWNTIFY_CONFIG.listSize);
      _searchMessage = _searchResults.length ? "" : "No matches found";
    } catch (err) {
      _searchMessage = err.message || "Search failed";
    } finally {
      _searchLoading = false;
      renderSearchState(shell);
    }
  }

  async function requestSearchResult(shell, index, action) {
    if (action !== "download") return;
    const item = _searchResults[index];
    if (!item) return;
    const url = songUrl(item);
    if (!url) return;
    const button = shell.querySelector(`[data-result-index="${index}"]`);
    if (button) {
      button.disabled = true;
      button.textContent = "Requesting...";
    }
    try {
      const params = new URLSearchParams({ url, client_id: clientId() });
      await apiPost(`/api/download/url?${params.toString()}`, {
        ...item,
        url,
        source: "homepage-widget",
        media_type: songType(item),
        title: songTitle(item),
        artists: songArtists(item),
        album: songAlbum(item),
      });
      _searchMessage = `Queued ${songTitle(item)}`;
      _tabCache = {};
    } catch (err) {
      _searchMessage = err.message || "Request failed";
    }
    renderSearchState(shell);
  }

  async function renderOverview() {
    const data = await loadWidgetData();
    const summary = data.summary || {};
    const health = data.health || {};
    const queue = data.queue || [];
    const recent = data.history || [];
    const libraryStats = summary.counts?.library || {};
    const queueSummary = summary.counts?.queue || {};
    const downloadsStorage = summary.storage?.downloads || health.downloads || {};
    const tools = summary.tools || health.tools || {};
    const libraryTotal = firstNumber(libraryStats.tracks, downloadsStorage.audio_count, downloadsStorage.file_count);
    const artists = firstNumber(libraryStats.artists);
    const albums = firstNumber(libraryStats.albums);
    const size = downloadsStorage.size_bytes || 0;
    const freeBytes = firstNumber(
      downloadsStorage.free_bytes,
      downloadsStorage.available_bytes,
      downloadsStorage.free,
      downloadsStorage.available,
      downloadsStorage.disk?.free_bytes,
      downloadsStorage.disk?.available_bytes
    );
    const reportedTotalBytes = firstNumber(
      downloadsStorage.total_bytes,
      downloadsStorage.capacity_bytes,
      downloadsStorage.total,
      downloadsStorage.capacity,
      downloadsStorage.disk?.total_bytes,
      downloadsStorage.disk?.capacity_bytes
    );
    const totalBytes = reportedTotalBytes || (freeBytes ? size + freeBytes : 0);
    const storagePercent = totalBytes ? Math.min(100, Math.max(0, Math.round((size / totalBytes) * 100))) : 0;
    const storageMeterWidth = totalBytes ? Math.max(4, storagePercent) : 100;
    const storageTitle = totalBytes ? `${fmtBytes(size)} of ${fmtBytes(totalBytes)} used` : `${fmtBytes(size)} used`;
    const storageSub = totalBytes && freeBytes ? `${fmtBytes(freeBytes)} available` : "Storage";
    const active = queue.filter(item => songStatus(item) === "downloading");
    const shownRecent = recent.filter(item => ["done", "skipped", "error"].includes(songStatus(item))).slice(0, 25);
    _overviewRecentItems = shownRecent;
    const hasHealth = !!(data.summary || data.health);
    const ffmpegReady = tools.ffmpeg?.available ?? data.capabilities?.ffmpeg;
    const ytDlpReady = tools.yt_dlp?.available;
    const readyTools = [ffmpegReady, ytDlpReady].filter(Boolean).length;
    const knownTools = [ffmpegReady, ytDlpReady].filter(value => value !== undefined && value !== null).length;
    const toolsValue = knownTools ? `${readyTools}/2` : "-";
    const toolPill = available => {
      if (available === undefined || available === null) return `<span class="downtify-pill downtify-pill--muted">checking</span>`;
      return `<span class="downtify-pill ${available ? "downtify-pill--ok" : "downtify-pill--warn"}">${available ? "ready" : "missing"}</span>`;
    };

    return `
      <div class="downtify-overview">
        <div class="downtify-overview-hero">
          <div class="downtify-overview-orb">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
          </div>
          <div class="downtify-overview-copy">
            <div class="downtify-section-label">Library</div>
            <div class="downtify-overview-total">${libraryTotal.toLocaleString()}</div>
            <div class="downtify-muted">${artists.toLocaleString()} artists · ${albums.toLocaleString()} albums</div>
          </div>
        </div>
        <div class="downtify-overview-stats">
          ${overviewStat(firstNumber(queueSummary.total, queue.length).toLocaleString(), "Queue", `<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>`)}
          ${overviewStat(toolsValue, "Tools Ready", `<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.3-3.3a5 5 0 0 1-6.7 6.7L7 20l-3-3 7.3-7.3a5 5 0 0 1 6.7-6.7l-3.3 3.3z"/>`)}
        </div>
      </div>
      <div class="downtify-overview-grid">
        <div class="downtify-mini-panel downtify-storage-panel">
          <div class="downtify-panel-head">
            <div>
              <div class="downtify-section-label">Storage</div>
              <div class="downtify-panel-title">${storageTitle}</div>
              <div class="downtify-muted">${storageSub}</div>
            </div>
            <span class="downtify-pill ${totalBytes ? "downtify-pill--active" : "downtify-pill--muted"}">${totalBytes ? `${storagePercent}% used` : "used"}</span>
          </div>
          <div class="downtify-queue-meter"><span style="width:${storageMeterWidth}%"></span></div>
        </div>
        <div class="downtify-mini-panel downtify-system-panel">
          <div class="downtify-panel-head">
            <div>
              <div class="downtify-section-label">System</div>
              <div class="downtify-panel-title">${knownTools ? (readyTools === 2 ? "Ready to download" : hasHealth ? "Needs attention" : "Checking tools") : "Checking tools"}</div>
            </div>
          </div>
          <div class="downtify-tool-grid">
            <div class="downtify-tool-chip"><span>ffmpeg</span>${toolPill(ffmpegReady)}</div>
            <div class="downtify-tool-chip"><span>yt-dlp</span>${toolPill(ytDlpReady)}</div>
          </div>
        </div>
      </div>
      ${shownRecent.length ? `
        <div class="downtify-panel-head downtify-section-spaced">
          <div>
            <div class="downtify-section-label">Recent Downloads</div>
            <div class="downtify-panel-title">Latest completed tracks</div>
          </div>
        </div>
        <div class="downtify-overview-recent">${shownRecent.map((item, i) => trackRow(item, i, { popupIndex: i })).join("")}</div>` : ""}
      ${data.coreErrors ? `<div class="downtify-footer-note">${data.coreErrors} core endpoint${data.coreErrors === 1 ? "" : "s"} unavailable</div>` : ""}`;
  }

  async function renderRecent() {
    const data = await loadWidgetData();
    const items = data.history.filter(item => ["done", "skipped", "error"].includes(songStatus(item))).slice(0, Math.max(12, DOWNTIFY_CONFIG.listSize));
    if (!items.length) return `<div class="downtify-empty"><div>No download history yet</div></div>`;
    return sliderShell(items);
  }

  async function renderLibrary() {
    const data = await loadWidgetData();
    const items = await ensureLibraryData();
    if (!items.length) return `<div class="downtify-empty"><div>No library files found</div></div>`;
    const monitored = monitoredArtistSet(data.monitor);
    const artists = groupedMedia(items, item => songArtists(item).split(",")[0], "artist")
      .map(item => ({ ...item, monitored: monitored.has(item.name.toLowerCase()) }));
    const albums = groupedMedia(items, item => songAlbum(item), "album");
    _libraryArtists = artists;
    _libraryAlbums = albums;
    const views = [
      { key: "artists", label: "Artists", count: artists.length },
      { key: "albums", label: "Albums", count: albums.length },
      { key: "tracks", label: "Tracks", count: items.length },
    ];
    return `
      <div class="downtify-library-shell">
        <div class="downtify-library-head">
          <div>
            <div class="downtify-section-label">Library</div>
            <div class="downtify-panel-title">${items.length.toLocaleString()} tracks in collection</div>
          </div>
          <div class="downtify-library-tabs" role="tablist">
            ${views.map(view => `<button class="downtify-library-tab${_libraryView === view.key ? " downtify-library-tab--active" : ""}" type="button" data-library-view="${view.key}" role="tab" aria-selected="${_libraryView === view.key}">
              <span>${view.label}</span>
              <strong>${view.count.toLocaleString()}</strong>
            </button>`).join("")}
          </div>
        </div>
        <div class="downtify-library-scrollbox">
          <div class="downtify-library-panel${_libraryView === "artists" ? " is-active" : ""}" data-library-panel="artists">
            <div class="downtify-library-grid downtify-library-grid--artists">${artists.map((item, i) => libraryMediaCard(item, i)).join("")}</div>
          </div>
          <div class="downtify-library-panel${_libraryView === "albums" ? " is-active" : ""}" data-library-panel="albums">
            <div class="downtify-library-grid">${albums.map((item, i) => libraryMediaCard(item, i)).join("")}</div>
          </div>
          <div class="downtify-library-panel${_libraryView === "tracks" ? " is-active" : ""}" data-library-panel="tracks">
            <div class="downtify-library-track-list">${items.map((item, i) => libraryTrackRow(item, i)).join("")}</div>
          </div>
        </div>
      </div>`;
  }

  async function renderSearch() {
    const data = await loadWidgetData();
    const library = await ensureLibraryData();
    const index = libraryIndex(library || []);
    return `
      <div class="downtify-search-shell">
        <form class="downtify-search-form">
          <div class="downtify-search-input-wrap">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
            <input class="downtify-search-input" type="search" value="${escH(_searchQuery)}" placeholder="Search albums or tracks" autocomplete="off">
          </div>
          <button class="downtify-search-submit" type="submit">Search</button>
        </form>
        <div class="downtify-search-modes">
          ${["albums", "tracks"].map(mode => `<button class="downtify-mode-btn${_searchMode === mode ? " downtify-mode-btn--active" : ""}" type="button" data-search-mode="${mode}">${mode}</button>`).join("")}
        </div>
        <div class="downtify-search-status">${_searchLoading ? "Searching..." : escH(_searchMessage)}</div>
        <div class="downtify-search-results">
          ${_searchResults.length
        ? _searchResults.map((item, i) => searchResultRow(item, i, isOwned(item, index))).join("")
        : (!_searchLoading && !_searchMessage ? `<div class="downtify-empty"><div>Search for music to request downloads</div></div>` : "")}
        </div>
      </div>`;
  }

  const TABS = [
    { key: "overview", label: "Overview", render: renderOverview },
    { key: "recent", label: "Recent", render: renderRecent },
    { key: "library", label: "Library", render: renderLibrary },
    { key: "search", label: "Search", render: renderSearch },
  ];

  function updateFooterStatus(shell, state = "connected", text = "") {
    const footer = shell?.querySelector?.(".downtify-footer");
    if (!footer) return;
    const pill = footer.querySelector(".downtify-connection-pill");
    const updated = footer.querySelector(".downtify-updated-text");
    const payload = _lastPayload;
    const coreErrors = Number(payload?.coreErrors || 0);
    const coreOnline = payload?.coreOnline !== false;
    const resolvedState = state === "connected" && !coreOnline
      ? "offline"
      : state === "connected" && coreErrors > 0
        ? "partial"
        : state;
    const label = text || (resolvedState === "offline" ? "Offline" : resolvedState === "partial" ? "Partial connection" : "Connected");
    if (pill) {
      pill.className = `downtify-connection-pill downtify-connection-pill--${resolvedState}`;
      pill.textContent = label;
    }
    if (updated) {
      updated.textContent = `Updated ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true })}`;
    }
  }

  function buildShell() {
    const tabs = TABS.map((t, i) => `
      <button class="downtify-tab${i === 0 ? " downtify-tab--active" : ""}" data-tab="${t.key}" type="button" role="tab"
        aria-selected="${i === 0}">${t.label}</button>`).join("");

    return `
      <div class="downtify-shell">
        <div class="downtify-header">
          <div class="downtify-header-left">
            <img src="https://raw.githubusercontent.com/SecuredNodeDynamics/Downtify/d0144f10b8c46f9a1341f0a2515beadde9627641/frontend/assets/logo.svg"
              alt="Downtify" class="downtify-icon" />
            <span class="downtify-title">Downtify</span>
          </div>
          <div class="downtify-header-right">
            <div class="downtify-tabs" role="tablist">${tabs}</div>
            <a class="downtify-open-btn" href="${escH(webBase())}" target="_blank" rel="noopener noreferrer">
              Open
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
              </svg>
            </a>
          </div>
        </div>
        <div class="downtify-panel">
          <div class="downtify-skeleton-wrap">${Array.from({ length: 5 }, () => `<div class="downtify-skeleton-row"></div>`).join("")}</div>
        </div>
        <div class="downtify-footer">
          <span class="downtify-connection-pill downtify-connection-pill--connecting">Connecting</span>
          <span class="downtify-updated-text">Updated just now</span>
        </div>
      </div>`;
  }

  function revealRows(panel) {
    requestAnimationFrame(() => {
      panel.querySelectorAll(".downtify-song-row, .downtify-monitor-row, .downtify-media-card, .downtify-search-row, .downtify-track-card, .downtify-library-card, .downtify-library-track").forEach(el => {
        el.style.opacity = "1";
        el.style.transform = "translateY(0)";
      });
    });
  }

  function updateRecentSlider(panel) {
    const track = panel.querySelector(".downtify-track-slider");
    const left = panel.querySelector(".downtify-slider-btn--left");
    const right = panel.querySelector(".downtify-slider-btn--right");
    if (!track || !left || !right) return;
    const max = Math.max(0, track.scrollWidth - track.clientWidth);
    left.disabled = track.scrollLeft <= 2;
    right.disabled = track.scrollLeft >= max - 2 || max <= 0;
  }

  function bindRecentSlider(panel) {
    if (!panel || panel.dataset.recentSliderBound === "1") {
      if (panel) updateRecentSlider(panel);
      return;
    }
    panel.dataset.recentSliderBound = "1";
    panel.addEventListener("click", event => {
      const btn = event.target.closest(".downtify-slider-btn");
      if (!btn) {
        const card = event.target.closest("[data-downtify-recent-index]");
        if (card) openTrackPopup(_recentItems[Number(card.dataset.downtifyRecentIndex)]);
        return;
      }
      const track = panel.querySelector(".downtify-track-slider");
      if (!track) return;
      const dir = btn.classList.contains("downtify-slider-btn--left") ? -1 : 1;
      track.scrollBy({ left: dir * Math.max(260, track.clientWidth * 0.82), behavior: "smooth" });
      setTimeout(() => updateRecentSlider(panel), 260);
    });
    panel.addEventListener("scroll", event => {
      if (event.target?.classList?.contains("downtify-track-slider")) updateRecentSlider(panel);
    }, { passive: true, capture: true });
    requestAnimationFrame(() => updateRecentSlider(panel));
  }

  function bindOverviewPanel(panel) {
    if (!panel || panel.dataset.overviewBound === "1") return;
    panel.dataset.overviewBound = "1";
    const openFromTarget = target => {
      const row = target.closest?.("[data-downtify-overview-index]");
      if (!row) return false;
      openTrackPopup(_overviewRecentItems[Number(row.dataset.downtifyOverviewIndex)]);
      return true;
    };
    panel.addEventListener("click", event => {
      openFromTarget(event.target);
    });
    panel.addEventListener("keydown", event => {
      if (event.key !== "Enter" && event.key !== " ") return;
      if (openFromTarget(event.target)) event.preventDefault();
    });
  }

  function bindLibraryPanel(panel) {
    if (!panel || panel.dataset.libraryBound === "1") return;
    panel.dataset.libraryBound = "1";
    panel.addEventListener("click", event => {
      const tab = event.target.closest("[data-library-view]");
      if (!tab) {
        const card = event.target.closest("[data-library-card-kind][data-library-card-index]");
        if (!card) return;
        const source = card.dataset.libraryCardKind === "artist" ? _libraryArtists : _libraryAlbums;
        openLibraryMediaPopup(source[Number(card.dataset.libraryCardIndex)]);
        return;
      }
      _libraryView = tab.dataset.libraryView || "artists";
      panel.querySelectorAll("[data-library-view]").forEach(btn => {
        const active = btn.dataset.libraryView === _libraryView;
        btn.classList.toggle("downtify-library-tab--active", active);
        btn.setAttribute("aria-selected", String(active));
      });
      panel.querySelectorAll("[data-library-panel]").forEach(view => {
        view.classList.toggle("is-active", view.dataset.libraryPanel === _libraryView);
      });
      revealRows(panel);
    });
    panel.addEventListener("keydown", event => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const card = event.target.closest("[data-library-card-kind][data-library-card-index]");
      if (!card) return;
      event.preventDefault();
      const source = card.dataset.libraryCardKind === "artist" ? _libraryArtists : _libraryAlbums;
      openLibraryMediaPopup(source[Number(card.dataset.libraryCardIndex)]);
    });
  }

  function bindSearchPanel(shell) {
    const panel = shell.querySelector(".downtify-panel");
    if (!panel || panel.dataset.searchBound === "1") return;
    panel.dataset.searchBound = "1";
    panel.addEventListener("submit", event => {
      const form = event.target.closest(".downtify-search-form");
      if (!form) return;
      event.preventDefault();
      performSearch(shell, form.querySelector(".downtify-search-input")?.value || "", _searchMode);
    });
    panel.addEventListener("click", event => {
      const modeBtn = event.target.closest("[data-search-mode]");
      if (modeBtn) {
        _searchMode = modeBtn.dataset.searchMode;
        performSearch(shell, panel.querySelector(".downtify-search-input")?.value || _searchQuery, _searchMode);
        return;
      }
      const actionBtn = event.target.closest("[data-downtify-action]");
      if (actionBtn) requestSearchResult(shell, Number(actionBtn.dataset.resultIndex), actionBtn.dataset.downtifyAction);
    });
  }

  async function renderSearchState(shell) {
    if (_currentTab !== "search") return;
    const panel = shell.querySelector(".downtify-panel");
    if (!panel) return;
    panel.innerHTML = await renderSearch();
    bindSearchPanel(shell);
    revealRows(panel);
  }

  async function switchTab(shell, key, force = false) {
    if (!TABS.some(t => t.key === key)) key = "overview";
    if (_currentTab === key && !force) return;
    _currentTab = key;

    shell.querySelectorAll(".downtify-tab").forEach(t => {
      const active = t.dataset.tab === key;
      t.classList.toggle("downtify-tab--active", active);
      t.setAttribute("aria-selected", String(active));
    });

    const panel = shell.querySelector(".downtify-panel");
    const footer = shell.querySelector(".downtify-footer");
    if (!panel) return;

    if (_tabCache[key] && !force) {
      panel.innerHTML = _tabCache[key];
      if (key === "overview") bindOverviewPanel(panel);
      if (key === "library") bindLibraryPanel(panel);
      if (key === "search") bindSearchPanel(shell);
      if (key === "recent") bindRecentSlider(panel);
      revealRows(panel);
      updateFooterStatus(shell);
      return;
    }

    const showSkeleton = !force || !panel.children.length;
    if (showSkeleton) {
      panel.innerHTML = `<div class="downtify-skeleton-wrap">${Array.from({ length: 5 }, () => `<div class="downtify-skeleton-row"></div>`).join("")}</div>`;
    }
    const tab = TABS.find(t => t.key === key);
    if (!tab) return;

    try {
      const html = await tab.render();
      if (key !== "search" && key !== "library") _tabCache[key] = html;
      panel.innerHTML = html;
      if (key === "search") bindSearchPanel(shell);
      if (key === "overview") bindOverviewPanel(panel);
      if (key === "library") bindLibraryPanel(panel);
      if (key === "recent") bindRecentSlider(panel);
      revealRows(panel);
      updateFooterStatus(shell);
    } catch (err) {
      console.error("[Homepage Downtify]", err);
      panel.innerHTML = `
        <div class="downtify-error">
          <div class="downtify-error-title">Failed to load Downtify</div>
          <div class="downtify-error-msg">${escH(err.message)}</div>
        </div>`;
      updateFooterStatus(shell, "offline", "Offline");
    }
  }

  async function renderDowntifyWidget(force = false) {
    const group = findGroupContainer();
    if (!group) return;

    const host = ensureHost(group);
    let shell = host.querySelector(".downtify-shell");

    if (!shell) {
      host.innerHTML = buildShell();
      shell = host.querySelector(".downtify-shell");
      shell.querySelectorAll(".downtify-tab").forEach(tab => {
        tab.addEventListener("click", () => switchTab(shell, tab.dataset.tab));
      });
    }

    const panel = shell.querySelector(".downtify-panel");
    const needsInitialRender = !panel || !!panel.querySelector(".downtify-skeleton-wrap");
    await switchTab(shell, _currentTab, needsInitialRender);
  }

  function startPolling() {
    if (_pollTimer) return;
    _pollTimer = setInterval(async () => {
      if (document.hidden || _refreshing || _currentTab === "search") return;
      _refreshing = true;
      const shell = document.querySelector(".downtify-widget-host .downtify-shell");
      try {
        await loadWidgetData(true);
        _tabCache = {};
        if (shell) await switchTab(shell, _currentTab, true);
      } finally {
        _refreshing = false;
      }
    }, DOWNTIFY_CONFIG.pollMs);
  }

  HpWidgetBoot.watch("downtify", {
    ready: () => !!document.querySelector(".downtify-widget-host .downtify-shell"),
    setup: () => startPolling(),
    mount: () => renderDowntifyWidget(true),
  });
})();
