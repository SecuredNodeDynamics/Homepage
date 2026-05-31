/* =====================================================
   SEERR INJECTED WIDGET
===================================================== */
(function () {
  const SR_CONFIG = {
    baseUrl: "http://YOUR_LOCAL_IP:PORT",
    fallbackUrl: "https://YOUR_TUNNEL_URL", // or null if not using a tunnel
    activeBaseUrl: null,                              // cached working URL
    publicUrl: "http://YOUR_LOCAL_IP:PORT",
    apiKey: "YOUR_API_KEY_HERE",
    groupName: "MEDIA-WIDGETS",
    pollMs: 120 * 1000,
    pageSize: 100,
    debug: false,
  };

  const TMDB_IMG = "https://image.tmdb.org/t/p/w200";
  const TMDB_IMG_BACK = "https://image.tmdb.org/t/p/w780";

  const _sectionOpen = { pending: true, approved: false, processing: false, available: false, declined: false };
  const _mediaCache = {};
  const _serviceCache = {};

  let _counts = undefined;
  let _requests = undefined;
  let _rendering = false;
  let _obsDelay = null;
  let _pollTimer = null;

  // ── Search state ─────────────────────────────────────────────────
  let _searchQuery = "";
  let _searchDebounce = null;
  let _searchDropdownEl = null;
  let _activeDetailPopup = null;

  function log(...a) { if (SR_CONFIG.debug) console.log("[SeerrWidget]", ...a); }
  function esc(s = "") {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // ── API ──────────────────────────────────────────────────────────
  function srHeaders() {
    return { "Content-Type": "application/json", "X-Api-Key": SR_CONFIG.apiKey };
  }

  async function apiFetch(path, method = "GET") {
    const candidates = [];
    if (SR_CONFIG.activeBaseUrl) candidates.push(SR_CONFIG.activeBaseUrl);
    if (!candidates.includes(SR_CONFIG.baseUrl)) candidates.push(SR_CONFIG.baseUrl);
    if (SR_CONFIG.fallbackUrl && !candidates.includes(SR_CONFIG.fallbackUrl)) candidates.push(SR_CONFIG.fallbackUrl);

    let lastErr = null;
    for (const base of candidates) {
      try {
        const res = await fetch(`${base}/api/v1${path}`, {
          method,
          headers: srHeaders(),
          mode: "cors",
          credentials: "omit",
          signal: (() => { const c = new AbortController(); setTimeout(() => c.abort(), 8000); return c.signal; })(),
        });
        if (!res.ok) throw new Error(`Seerr API ${res.status}: ${path}`);
        SR_CONFIG.activeBaseUrl = base;
        return res.json();
      } catch (err) {
        lastErr = err;
        log(`apiFetch failed with base ${base}:`, err.message);
      }
    }
    throw lastErr || new Error("All Seerr base URLs failed");
  }

  async function fetchCounts() {
    try { return await apiFetch("/request/count"); }
    catch (e) { console.warn("[SeerrWidget] count fetch failed:", e.message); return null; }
  }

  async function fetchRawRequests() {
    try {
      const data = await apiFetch(`/request?take=${SR_CONFIG.pageSize}&skip=0&sort=added`);
      return data.results || [];
    } catch (e) { console.warn("[SeerrWidget] requests fetch failed:", e.message); return null; }
  }

  async function enrichMedia(mediaType, tmdbId) {
    if (!tmdbId) return {};
    const cacheKey = `${mediaType}:${tmdbId}`;
    if (_mediaCache[cacheKey]) return _mediaCache[cacheKey];
    try {
      const endpoint = mediaType === "tv" ? `/tv/${tmdbId}` : `/movie/${tmdbId}`;
      const detail = await apiFetch(endpoint);
      const info = {
        title: detail.title || detail.name || detail.originalTitle || detail.originalName || "Unknown",
        posterPath: detail.posterPath || null,
      };
      _mediaCache[cacheKey] = info;
      return info;
    } catch (e) {
      log(`media detail fetch failed for ${mediaType}:${tmdbId}`, e.message);
      _mediaCache[cacheKey] = { title: "Unknown", posterPath: null };
      return _mediaCache[cacheKey];
    }
  }

  async function fetchRequests() {
    const raw = await fetchRawRequests();
    if (!raw) return null;
    const enrichMap = {};
    raw.forEach(req => {
      const mt = req.media?.mediaType;
      const tid = req.media?.tmdbId;
      if (mt && tid) {
        const key = `${mt}:${tid}`;
        if (!enrichMap[key]) enrichMap[key] = enrichMedia(mt, tid);
      }
    });
    await Promise.all(Object.values(enrichMap));
    return raw.map(req => {
      const mt = req.media?.mediaType;
      const tid = req.media?.tmdbId;
      const key = `${mt}:${tid}`;
      const detail = _mediaCache[key] || {};
      return {
        ...req,
        media: {
          ...req.media,
          title: detail.title || req.media?.title || req.media?.name || "Unknown",
          posterPath: detail.posterPath || req.media?.posterPath || null,
        },
      };
    });
  }

  async function actionRequest(id, action) {
    try {
      await apiFetch(`/request/${id}/${action}`, "POST");
      return true;
    } catch (e) { console.warn(`[SeerrWidget] ${action} failed:`, e.message); return false; }
  }

  // ── Search API ───────────────────────────────────────────────────
  async function searchMedia(query) {
    if (!query.trim()) return [];
    try {
      const data = await apiFetch(`/search?query=${encodeURIComponent(query)}&page=1&language=en`);
      return (data.results || []).filter(r => r.mediaType === "movie" || r.mediaType === "tv").slice(0, 9);
    } catch (e) { log("search failed:", e.message); return []; }
  }

  // ── Service / root folder API ────────────────────────────────────
  async function fetchServices(type) {
    try { return await apiFetch(`/service/${type}`); }
    catch (e) { log(`service list failed ${type}`, e.message); return []; }
  }

  async function fetchServiceDetail(type, id) {
    const key = `${type}:${id}`;
    if (_serviceCache[key]) return _serviceCache[key];
    try {
      const d = await apiFetch(`/service/${type}/${id}`);
      _serviceCache[key] = d;
      return d;
    } catch (e) { log(`service detail failed ${key}`, e.message); return null; }
  }

  // ── Request media ────────────────────────────────────────────────
  async function requestMedia(mediaType, mediaId, seasons, serverId, rootFolder) {
    const body = { mediaType, mediaId };
    if (mediaType === "tv") body.seasons = seasons && seasons.length ? seasons : [1];
    if (serverId !== null && serverId !== undefined) body.serverId = serverId;
    if (rootFolder) body.rootFolder = rootFolder;

    const candidates = [];
    if (SR_CONFIG.activeBaseUrl) candidates.push(SR_CONFIG.activeBaseUrl);
    if (!candidates.includes(SR_CONFIG.baseUrl)) candidates.push(SR_CONFIG.baseUrl);
    if (SR_CONFIG.fallbackUrl && !candidates.includes(SR_CONFIG.fallbackUrl)) candidates.push(SR_CONFIG.fallbackUrl);

    let lastErr = null;
    for (const base of candidates) {
      try {
        const res = await fetch(`${base}/api/v1/request`, {
          method: "POST",
          headers: srHeaders(),
          body: JSON.stringify(body),
          mode: "cors",
          credentials: "omit",
          signal: (() => { const c = new AbortController(); setTimeout(() => c.abort(), 8000); return c.signal; })(),
        });
        if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.message || `${res.status}`); }
        SR_CONFIG.activeBaseUrl = base;
        return { ok: true };
      } catch (e) {
        lastErr = e;
        log(`requestMedia failed with base ${base}:`, e.message);
      }
    }
    return { ok: false, error: lastErr?.message || "All base URLs failed" };
  }

  // ── DOM helpers ──────────────────────────────────────────────────
  function findGroupContainer() {
    const headings = Array.from(document.querySelectorAll("h2, h3, .group-title, .service-group-name"));
    const h = headings.find(el => el.textContent.replace(/\s+/g, " ").trim() === SR_CONFIG.groupName);
    if (!h) { log("group not found"); return null; }
    return h.closest("section") || h.closest("div[class*='group']") || h.parentElement?.parentElement || h.parentElement;
  }

  function ensureHost(group) {
    let row = group.querySelector(".sr-flex-row");
    if (!row) {
      const list = group.querySelector("ul.services-list, ul");
      if (list) list.style.display = "none";
      row = document.createElement("div");
      row.className = "sr-flex-row";
      group.appendChild(row);
    }
    let host = row.querySelector(".sr-host");
    if (host) return host;
    host = document.createElement("div");
    host.className = "sr-host";
    row.appendChild(host);
    return host;
  }

  function getHost() {
    const group = findGroupContainer();
    return group ? group.querySelector(".sr-host") : null;
  }

  // ── Status / Section config ──────────────────────────────────────
  const STATUS_MAP = {
    1: { key: "pending", label: "PENDING" },
    2: { key: "approved", label: "APPROVED" },
    3: { key: "declined", label: "DECLINED" },
    4: { key: "available", label: "AVAILABLE" },
    5: { key: "processing", label: "PROCESSING" },
  };

  const SECTION_ORDER = ["pending", "approved", "processing", "available", "declined"];

  const SECTION_META = {
    pending: { label: "Pending", accentCls: "sr-section--pending", icon: `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>` },
    available: { label: "Available", accentCls: "sr-section--available", icon: `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>` },
    approved: { label: "Approved", accentCls: "sr-section--approved", icon: `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14l-4-4 1.41-1.41L10 13.17l6.59-6.59L18 8l-8 8z"/></svg>` },
    processing: { label: "Added", accentCls: "sr-section--processing", icon: `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>` },
    declined: { label: "Declined", accentCls: "sr-section--declined", icon: `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>` },
  };

  function mediaTypeIcon(type) {
    return type === "tv"
      ? `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z"/></svg>`
      : `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z"/></svg>`;
  }

  function timeAgo(dateStr) {
    const diff = Math.floor((Date.now() - new Date(dateStr)) / 1000);
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  function groupRequests(requests) {
    const groups = {};
    SECTION_ORDER.forEach(k => { groups[k] = []; });
    (requests || []).forEach(req => {
      if (req.media?.status === 5) {
        groups["available"].push(req);
      } else {
        const info = STATUS_MAP[req.status];
        const key = info ? info.key : null;
        if (key && groups[key]) groups[key].push(req);
      }
    });
    return groups;
  }

  // ── Build HTML ───────────────────────────────────────────────────
  function buildCountPills(counts, groups) {
    if (!counts) return "";
    const pills = [
      { label: "Total", value: counts.total, cls: "" },
      { label: "Pending", value: groups.pending.length, cls: "sr-pill--pending" },
      { label: "Approved", value: groups.approved.length, cls: "sr-pill--approved" },
      { label: "Added", value: groups.processing.length, cls: "sr-pill--approved" },
      { label: "Available", value: groups.available.length, cls: "sr-pill--available" },
      { label: "Declined", value: groups.declined.length, cls: "sr-pill--declined" },
    ].filter(p => p.value > 0 || p.label === "Total");

    return `<div class="sr-stats">
      ${pills.map(p => `
        <span class="sr-stat-pill ${p.cls}">
          <span class="sr-stat-value">${p.value ?? 0}</span>
          ${esc(p.label)}
        </span>`).join("")}
    </div>`;
  }

  function buildPosterCard(req) {
    const media = req.media || {};
    const title = esc(media.title || media.name || "Unknown");
    const type = media.mediaType || "movie";
    const poster = media.posterPath ? `${TMDB_IMG}${media.posterPath}` : "";
    const user = esc(req.requestedBy?.displayName || req.requestedBy?.username || "Unknown");
    const age = timeAgo(req.createdAt);
    const isPending = req.status === 1;
    const isTV = type === "tv";
    const detailUrl = `${SR_CONFIG.publicUrl}/${isTV ? "tv" : "movie"}/${req.media?.tmdbId}`;

    const imgEl = poster
      ? `<img class="sr-poster-card__img" src="${esc(poster)}" alt="${title}" loading="lazy" decoding="async"
              onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" />
         <div class="sr-poster-card__placeholder" style="display:none">${title.charAt(0)}</div>`
      : `<div class="sr-poster-card__placeholder">${title.charAt(0)}</div>`;

    const actionsEl = isPending ? `
      <div class="sr-poster-card__actions">
        <button class="sr-action-btn sr-action-btn--approve" data-id="${req.id}" title="Approve">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
          Approve
        </button>
        <button class="sr-action-btn sr-action-btn--decline" data-id="${req.id}" title="Decline">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
          Decline
        </button>
      </div>` : "";

    const seasonsData = isTV && req.seasons?.length ? esc(JSON.stringify(req.seasons)) : "";
    const usePopup = isTV || isPending;

    if (usePopup) {
      return `
        <div class="sr-poster-card${isPending ? " sr-poster-card--pending" : ""}${isTV ? " sr-poster-card--tv" : ""}${isPending ? " sr-poster-card--clickable" : ""}"
             data-id="${req.id}" data-tmdb="${req.media?.tmdbId || ""}"
             data-title="${title}" data-user="${user}" data-age="${esc(age)}"
             data-poster="${esc(poster)}" data-url="${esc(detailUrl)}"
             data-seasons="${seasonsData}"
             data-pending="${isPending ? "1" : ""}"
             data-reqid="${req.id}"
             title="${title}">
          ${imgEl}
          <span class="sr-poster-card__type">${mediaTypeIcon(type)}</span>
          <div class="sr-poster-card__overlay">
            <div class="sr-poster-card__title">${title}</div>
            <div class="sr-poster-card__meta">
              <span class="sr-poster-card__user">${user}</span>
              <span class="sr-poster-card__age">${esc(age)}</span>
            </div>
          </div>
          ${actionsEl}
        </div>`;
    }

    return `
      <a class="sr-poster-card"
         data-id="${req.id}" href="${esc(detailUrl)}" target="_blank" rel="noopener" title="${title}">
        ${imgEl}
        <span class="sr-poster-card__type">${mediaTypeIcon(type)}</span>
        <div class="sr-poster-card__overlay">
          <div class="sr-poster-card__title">${title}</div>
          <div class="sr-poster-card__meta">
            <span class="sr-poster-card__user">${user}</span>
            <span class="sr-poster-card__age">${esc(age)}</span>
          </div>
        </div>
      </a>`;
  }

  function buildSection(key, items) {
    if (!items.length) return "";
    const meta = SECTION_META[key];
    const isOpen = !!_sectionOpen[key];
    const chevron = `<svg class="sr-chevron" width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>`;

    return `
      <div class="sr-section ${meta.accentCls}" data-section="${key}">
        <button class="sr-section__header${isOpen ? " sr-section__header--open" : ""}" data-toggle="${key}">
          <span class="sr-section__icon">${meta.icon}</span>
          <span class="sr-section__label">${meta.label}</span>
          <span class="sr-section__count">${items.length}</span>
          <span class="sr-section__spacer"></span>
          ${chevron}
        </button>
        <div class="sr-section__body${isOpen ? " sr-section__body--open" : ""}">
          <div class="sr-grid">
            ${items.map(buildPosterCard).join("")}
          </div>
        </div>
      </div>`;
  }

  // ── Search UI helpers ────────────────────────────────────────────
  const SEARCH_STATUS_LABEL = { 2: "Pending", 3: "Processing", 4: "Partial", 5: "Available" };
  const SEARCH_STATUS_CLS = { 2: "sr-search-result__status--pending", 3: "sr-search-result__status--processing", 4: "sr-search-result__status--processing", 5: "sr-search-result__status--available" };

  function closeSearchDropdown() {
    if (_searchDropdownEl) { _searchDropdownEl.remove(); _searchDropdownEl = null; }
  }

  function showSearchDropdown(results, anchorEl) {
    closeSearchDropdown();

    const dropdown = document.createElement("div");
    dropdown.className = "sr-search-dropdown";

    if (!results.length) {
      dropdown.innerHTML = `<div class="sr-search-empty">No results found</div>`;
    } else {
      dropdown.innerHTML = results.map(item => {
        const title = esc(item.title || item.name || "Unknown");
        const year = (item.releaseDate || item.firstAirDate || "").substring(0, 4);
        const type = item.mediaType === "tv" ? "TV Series" : "Movie";
        const poster = item.posterPath ? `${TMDB_IMG}${item.posterPath}` : "";
        const status = item.mediaInfo?.status;
        const statusHtml = status && SEARCH_STATUS_LABEL[status]
          ? `<span class="sr-search-result__status ${SEARCH_STATUS_CLS[status] || ""}">${SEARCH_STATUS_LABEL[status]}</span>`
          : "";

        const posterEl = poster
          ? `<div class="sr-search-result__poster"><img src="${esc(poster)}" alt="" loading="lazy" onerror="this.parentElement.textContent='${title.charAt(0)}'"></div>`
          : `<div class="sr-search-result__poster">${title.charAt(0)}</div>`;

        return `<div class="sr-search-result"
                     data-media-type="${esc(item.mediaType)}"
                     data-media-id="${item.id}"
                     data-title="${title}"
                     data-year="${esc(year)}"
                     data-overview="${esc(item.overview || "")}"
                     data-poster="${esc(poster)}"
                     data-backdrop="${esc(item.backdropPath ? `${TMDB_IMG_BACK}${item.backdropPath}` : "")}"
                     data-vote="${esc(item.voteAverage?.toFixed(1) || "")}"
                     data-status="${status || ""}"
                     data-url="${esc(`${SR_CONFIG.publicUrl}/${item.mediaType === "tv" ? "tv" : "movie"}/${item.id}`)}">
                  ${posterEl}
                  <div class="sr-search-result__info">
                    <div class="sr-search-result__title">${title}</div>
                    <div class="sr-search-result__meta">${type}${year ? " · " + year : ""}</div>
                    ${statusHtml}
                  </div>
                </div>`;
      }).join("");
    }

    document.body.appendChild(dropdown);
    _searchDropdownEl = dropdown;

    const rect = anchorEl.getBoundingClientRect();
    const dw = dropdown.offsetWidth;
    const vw = window.innerWidth;
    let left = rect.right - dw;
    if (left < 8) left = 8;
    if (left + dw > vw - 8) left = vw - dw - 8;
    dropdown.style.left = `${left}px`;
    dropdown.style.top = `${rect.bottom + 6}px`;

    dropdown.querySelectorAll(".sr-search-result").forEach(row => {
      row.addEventListener("click", () => {
        closeSearchDropdown();
        showDetailPopup(row.dataset);
      });
    });
  }

  function closeDetailPopup() {
    if (_activeDetailPopup) { _activeDetailPopup.remove(); _activeDetailPopup = null; }
    const bd = document.getElementById("sr-detail-backdrop");
    if (bd) bd.remove();
  }

  async function showDetailPopup(data) {
    closeDetailPopup();
    closePopup();

    const isTV = data.mediaType === "tv";
    const mediaId = parseInt(data.mediaId);
    const alreadyAdded = data.status && parseInt(data.status) >= 3;
    const statusLabel = SEARCH_STATUS_LABEL[parseInt(data.status)] || null;
    const serviceType = isTV ? "sonarr" : "radarr";

    // ── Fetch TV details + server list in parallel ───────────────────
    const [tvDetail, servers] = await Promise.all([
      isTV ? apiFetch(`/tv/${mediaId}`).catch(() => null) : Promise.resolve(null),
      alreadyAdded ? Promise.resolve([]) : fetchServices(serviceType),
    ]);

    // Default server + root folders
    const defaultServer = servers.find(s => s.isDefault) || servers[0] || null;
    let _selectedServerId = defaultServer ? defaultServer.id : null;
    let _rootFolders = [];
    let _selectedRootFolder = defaultServer ? defaultServer.activeDirectory : null;

    if (defaultServer !== null && _selectedServerId !== null) {
      const detail = await fetchServiceDetail(serviceType, _selectedServerId);
      _rootFolders = detail?.rootFolders || [];
      if (!_selectedRootFolder && _rootFolders.length) _selectedRootFolder = _rootFolders[0].path;
    }

    // ── Season setup ─────────────────────────────────────────────────
    const seasonStatusMap = {};
    if (tvDetail?.mediaInfo?.seasons) {
      tvDetail.mediaInfo.seasons.forEach(s => { seasonStatusMap[s.seasonNumber] = s.status; });
    }
    const allSeasons = (tvDetail?.seasons || [])
      .map(s => s.seasonNumber).filter(n => n > 0).sort((a, b) => a - b);
    const requestableSeasons = allSeasons.filter(n => {
      const st = seasonStatusMap[n];
      return !st || (st !== 5 && st !== 3 && st !== 4);
    });

    // ── HTML pieces ──────────────────────────────────────────────────
    const backdropHtml = data.backdrop
      ? `<div class="sr-detail-popup__backdrop-wrap">
           <img src="${esc(data.backdrop)}" alt="" class="sr-detail-popup__backdrop-img"
                onerror="this.parentElement.style.display='none'">
           <div class="sr-detail-popup__backdrop-fade"></div>
         </div>` : "";

    const posterHtml = data.poster
      ? `<img src="${esc(data.poster)}" alt="" class="sr-detail-popup__poster" onerror="this.style.display='none'">`
      : `<div class="sr-detail-popup__poster sr-detail-popup__poster--placeholder">${(data.title || "?").charAt(0)}</div>`;

    const ratingHtml = data.vote && parseFloat(data.vote) > 0
      ? `<span class="sr-detail-popup__badge sr-detail-popup__badge--rating">★ ${data.vote}</span>` : "";
    const statusBadge = statusLabel
      ? `<span class="sr-detail-popup__badge sr-detail-popup__badge--status-${data.status}">${statusLabel}</span>` : "";
    const overviewHtml = data.overview
      ? `<p class="sr-detail-popup__overview">${esc(data.overview)}</p>` : "";

    // ── Season picker ────────────────────────────────────────────────
    const SEASON_ST_LABEL = { 2: "Pending", 3: "Processing", 4: "Partial", 5: "Available" };
    const SEASON_ST_CLS = { 2: "sr-season-chip--pending", 3: "sr-season-chip--processing", 4: "sr-season-chip--processing", 5: "sr-season-chip--available" };

    let seasonPickerHtml = "";
    if (isTV && allSeasons.length > 0 && !alreadyAdded) {
      const chips = allSeasons.map(n => {
        const st = seasonStatusMap[n];
        const stLabel = SEASON_ST_LABEL[st] || "";
        const stCls = SEASON_ST_CLS[st] || "";
        const disabled = st === 5 || st === 3 || st === 4;
        const label = `S${String(n).padStart(2, "0")}`;
        const statusBit = stLabel ? `<span class="sr-season-chip__status">${stLabel}</span>` : "";
        return `<label class="sr-season-chip ${stCls}${disabled ? " sr-season-chip--done" : ""}">
          <input type="checkbox" class="sr-season-cb" value="${n}" ${disabled ? "disabled" : "checked"} />
          <span class="sr-season-chip__label">${label}</span>
          ${statusBit}
        </label>`;
      }).join("");

      seasonPickerHtml = `
        <div class="sr-detail-popup__divider"></div>
        <div class="sr-season-picker">
          <div class="sr-season-picker__header">
            <span class="sr-season-picker__title">Seasons</span>
            <button class="sr-season-picker__all" id="sr-season-all-btn" type="button">All</button>
          </div>
          <div class="sr-season-picker__chips">${chips}</div>
        </div>`;
    }

    // ── Server + folder picker ───────────────────────────────────────
    let destinationHtml = "";
    if (!alreadyAdded && servers.length > 0) {
      const serverOpts = servers.map(s =>
        `<option value="${s.id}" ${s.id === _selectedServerId ? "selected" : ""}>${esc(s.name)}</option>`
      ).join("");

      const folderOpts = _rootFolders.map(f => {
        const label = f.path.split("/").filter(Boolean).pop() || f.path;
        const free = f.freeSpace ? ` (${Math.round(f.freeSpace / 1073741824)}GB free)` : "";
        return `<option value="${esc(f.path)}" ${f.path === _selectedRootFolder ? "selected" : ""}>${esc(label)}${free}</option>`;
      }).join("");

      destinationHtml = `
        <div class="sr-detail-popup__divider"></div>
        <div class="sr-dest-picker">
          <div class="sr-dest-picker__row">
            <label class="sr-dest-picker__label">Server</label>
            <select class="sr-dest-picker__select" id="sr-dest-server">${serverOpts}</select>
          </div>
          <div class="sr-dest-picker__row">
            <label class="sr-dest-picker__label">Folder</label>
            <select class="sr-dest-picker__select" id="sr-dest-folder">
              ${folderOpts || `<option value="">Loading…</option>`}
            </select>
          </div>
        </div>`;
    }

    // ── Request button ───────────────────────────────────────────────
    const requestBtnHtml = alreadyAdded
      ? `<button class="sr-detail-popup__request-btn sr-detail-popup__request-btn--already" disabled>${statusLabel || "Added"}</button>`
      : `<button class="sr-detail-popup__request-btn" id="sr-detail-request-btn">
           <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
           Request
         </button>`;

    // ── Assemble popup ───────────────────────────────────────────────
    const popup = document.createElement("div");
    popup.className = "sr-detail-popup";
    popup.innerHTML = `
      ${backdropHtml}
      <div class="sr-detail-popup__body">
        <div class="sr-detail-popup__top">
          ${posterHtml}
          <div class="sr-detail-popup__meta">
            <div class="sr-detail-popup__title">${esc(data.title || "Unknown")}</div>
            <div class="sr-detail-popup__badges">
              <span class="sr-detail-popup__badge sr-detail-popup__badge--type">${isTV ? "TV Series" : "Movie"}</span>
              ${data.year ? `<span class="sr-detail-popup__badge sr-detail-popup__badge--year">${esc(data.year)}</span>` : ""}
              ${ratingHtml}${statusBadge}
            </div>
          </div>
        </div>
        ${overviewHtml}
        ${seasonPickerHtml}
        ${destinationHtml}
        <div class="sr-detail-popup__divider"></div>
        <div class="sr-detail-popup__actions">
          <a class="sr-detail-popup__view-link" href="${esc(data.url || "#")}" target="_blank" rel="noopener">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
              <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
            View
          </a>
          ${requestBtnHtml}
        </div>
      </div>`;

    document.body.appendChild(popup);
    const pw = popup.offsetWidth, ph = popup.offsetHeight;
    popup.style.left = `${Math.max(8, (window.innerWidth - pw) / 2)}px`;
    popup.style.top = `${Math.max(8, (window.innerHeight - ph) / 2)}px`;
    _activeDetailPopup = popup;

    const backdrop = document.createElement("div");
    backdrop.id = "sr-detail-backdrop";
    backdrop.className = "sr-popup-backdrop";
    backdrop.addEventListener("click", closeDetailPopup);
    document.body.appendChild(backdrop);

    // ── Server change → reload root folders ──────────────────────────
    const serverSel = popup.querySelector("#sr-dest-server");
    const folderSel = popup.querySelector("#sr-dest-folder");

    if (serverSel) {
      serverSel.addEventListener("change", async () => {
        _selectedServerId = parseInt(serverSel.value);
        const srv = servers.find(s => s.id === _selectedServerId);
        _selectedRootFolder = srv ? srv.activeDirectory : null;
        if (folderSel) folderSel.innerHTML = `<option value="">Loading…</option>`;
        const detail = await fetchServiceDetail(serviceType, _selectedServerId);
        _rootFolders = detail?.rootFolders || [];
        _selectedRootFolder = _selectedRootFolder || (_rootFolders[0]?.path ?? null);
        if (folderSel) {
          folderSel.innerHTML = _rootFolders.map(f => {
            const label = f.path.split("/").filter(Boolean).pop() || f.path;
            const free = f.freeSpace ? ` (${Math.round(f.freeSpace / 1073741824)}GB free)` : "";
            return `<option value="${esc(f.path)}" ${f.path === _selectedRootFolder ? "selected" : ""}>${esc(label)}${free}</option>`;
          }).join("");
        }
      });
    }

    if (folderSel) {
      folderSel.addEventListener("change", () => { _selectedRootFolder = folderSel.value; });
    }

    // ── Season all/none toggle ────────────────────────────────────────
    const allBtn = popup.querySelector("#sr-season-all-btn");
    if (allBtn) {
      let _allMode = true;
      allBtn.addEventListener("click", () => {
        _allMode = !_allMode;
        popup.querySelectorAll(".sr-season-cb:not(:disabled)").forEach(cb => { cb.checked = _allMode; });
        allBtn.textContent = _allMode ? "All" : "None";
        updateRequestBtn();
      });
    }

    function getSelectedSeasons() {
      return Array.from(popup.querySelectorAll(".sr-season-cb:checked:not(:disabled)"))
        .map(cb => parseInt(cb.value));
    }

    function updateRequestBtn() {
      const reqBtn = popup.querySelector("#sr-detail-request-btn");
      if (!reqBtn) return;
      const sel = isTV ? getSelectedSeasons() : null;
      const none = isTV && sel.length === 0;
      reqBtn.disabled = none;
      if (isTV) {
        const label = sel.length === requestableSeasons.length && requestableSeasons.length > 1
          ? "Request All" : sel.length === 1
            ? "Request S" + String(sel[0]).padStart(2, "0")
            : `Request ${sel.length}`;
        reqBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg> ${none ? "Select seasons" : label}`;
      }
    }

    popup.querySelectorAll(".sr-season-cb").forEach(cb => { cb.addEventListener("change", updateRequestBtn); });
    if (isTV) updateRequestBtn();

    // ── Request button click ──────────────────────────────────────────
    const reqBtn = popup.querySelector("#sr-detail-request-btn");
    if (reqBtn) {
      reqBtn.addEventListener("click", async () => {
        const seasons = isTV ? getSelectedSeasons() : undefined;
        if (isTV && (!seasons || seasons.length === 0)) return;
        const rootFolder = folderSel ? folderSel.value || _selectedRootFolder : _selectedRootFolder;
        reqBtn.disabled = true;
        reqBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" style="animation:sr-detail-spin .8s linear infinite"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg> Requesting…`;
        const result = await requestMedia(data.mediaType, mediaId, seasons, _selectedServerId, rootFolder);
        if (result.ok) {
          reqBtn.classList.add("sr-detail-popup__request-btn--success");
          reqBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg> Requested!`;
          const host = getHost();
          setTimeout(() => { closeDetailPopup(); if (host) refresh(host); }, 1800);
        } else {
          reqBtn.disabled = false;
          reqBtn.classList.add("sr-detail-popup__request-btn--error");
          reqBtn.innerHTML = `⚠ ${esc(result.error || "Failed")}`;
          setTimeout(() => {
            reqBtn.disabled = false;
            reqBtn.classList.remove("sr-detail-popup__request-btn--error");
            updateRequestBtn();
          }, 2500);
        }
      });
    }
  }

  // ── CSS injection ────────────────────────────────────────────────
  function injectSearchCSS() {
    if (document.getElementById("sr-search-styles")) return;
    const s = document.createElement("style");
    s.id = "sr-search-styles";
    s.textContent = `
      .sr-search-wrap{position:relative;display:inline-flex;align-items:center;flex:1;min-width:0;max-width:220px;}
      .sr-search-input-icon{position:absolute;left:8px;pointer-events:none;color:rgba(255,255,255,.28);display:flex;align-items:center;z-index:1;}
      .sr-search-input{width:100%;background:rgba(255,255,255,.07);border:1px solid rgba(34,197,94,.25);border-radius:8px;padding:5px 10px 5px 28px;color:rgba(255,255,255,.90);font-size:.70rem;outline:none;transition:border-color .15s,background .15s;box-sizing:border-box;}
      .sr-search-input:focus{border-color:rgba(34,197,94,.70);background:rgba(255,255,255,.10);}
      .sr-search-input::placeholder{color:rgba(255,255,255,.22);}

      .sr-search-dropdown{position:fixed;z-index:9997;background:rgba(10,14,20,.97);border:1px solid rgba(255,255,255,.10);border-radius:10px;width:280px;max-height:360px;overflow-y:auto;backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);box-shadow:0 12px 40px rgba(0,0,0,.65);animation:sr-popup-in .14s ease;}
      .sr-search-empty{padding:16px;text-align:center;font-size:.72rem;color:rgba(255,255,255,.28);}
      .sr-search-result{display:flex;gap:10px;padding:8px 10px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,.04);transition:background .12s;}
      .sr-search-result:last-child{border-bottom:none;}
      .sr-search-result:hover{background:rgba(255,255,255,.06);}
      .sr-search-result__poster{width:32px;height:48px;border-radius:4px;flex-shrink:0;background:rgba(255,255,255,.06);display:flex;align-items:center;justify-content:center;font-size:.85rem;font-weight:700;color:rgba(255,255,255,.20);overflow:hidden;}
      .sr-search-result__poster img{width:100%;height:100%;object-fit:cover;display:block;}
      .sr-search-result__info{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center;gap:2px;}
      .sr-search-result__title{font-size:.70rem;font-weight:600;color:rgba(255,255,255,.90);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .sr-search-result__meta{font-size:.60rem;color:rgba(255,255,255,.38);}
      .sr-search-result__status{font-size:.58rem;font-weight:600;padding:1px 6px;border-radius:99px;border:1px solid transparent;display:inline-block;margin-top:1px;}
      .sr-search-result__status--available{background:rgba(74,222,128,.12);border-color:rgba(74,222,128,.28);color:#86efac;}
      .sr-search-result__status--pending{background:rgba(251,191,36,.12);border-color:rgba(251,191,36,.25);color:#fde68a;}
      .sr-search-result__status--processing{background:rgba(168,85,247,.12);border-color:rgba(168,85,247,.25);color:#d8b4fe;}

      .sr-detail-popup{position:fixed;z-index:9999;width:320px;border-radius:14px;background:rgba(10,14,20,.97);border:1px solid rgba(255,255,255,.12);backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);box-shadow:0 20px 60px rgba(0,0,0,.70);overflow:hidden;animation:sr-popup-in .16s ease;}
      .sr-detail-popup__backdrop-wrap{position:relative;height:120px;overflow:hidden;}
      .sr-detail-popup__backdrop-img{width:100%;height:100%;object-fit:cover;display:block;opacity:.50;}
      .sr-detail-popup__backdrop-fade{position:absolute;bottom:0;left:0;right:0;height:70px;background:linear-gradient(to bottom,transparent,rgba(10,14,20,.97));}
      .sr-detail-popup__body{padding:12px 14px 14px;}
      .sr-detail-popup__top{display:flex;gap:12px;margin-bottom:10px;}
      .sr-detail-popup__poster{width:60px;height:90px;border-radius:6px;object-fit:cover;flex-shrink:0;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.06);}
      .sr-detail-popup__poster--placeholder{display:flex;align-items:center;justify-content:center;font-size:1.4rem;font-weight:700;color:rgba(255,255,255,.20);}
      .sr-detail-popup__meta{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center;gap:6px;}
      .sr-detail-popup__title{font-size:.80rem;font-weight:700;color:rgba(255,255,255,.95);line-height:1.3;}
      .sr-detail-popup__badges{display:flex;flex-wrap:wrap;gap:4px;}
      .sr-detail-popup__badge{font-size:.58rem;font-weight:600;padding:2px 7px;border-radius:99px;border:1px solid transparent;white-space:nowrap;}
      .sr-detail-popup__badge--type{background:rgba(255,255,255,.07);border-color:rgba(255,255,255,.12);color:rgba(255,255,255,.50);}
      .sr-detail-popup__badge--year{background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.09);color:rgba(255,255,255,.38);}
      .sr-detail-popup__badge--rating{background:rgba(251,191,36,.12);border-color:rgba(251,191,36,.25);color:#fde68a;}
      .sr-detail-popup__badge--status-2{background:rgba(251,191,36,.12);border-color:rgba(251,191,36,.25);color:#fde68a;}
      .sr-detail-popup__badge--status-3{background:rgba(168,85,247,.12);border-color:rgba(168,85,247,.25);color:#d8b4fe;}
      .sr-detail-popup__badge--status-4{background:rgba(168,85,247,.12);border-color:rgba(168,85,247,.25);color:#d8b4fe;}
      .sr-detail-popup__badge--status-5{background:rgba(74,222,128,.12);border-color:rgba(74,222,128,.25);color:#86efac;}
      .sr-detail-popup__overview{font-size:.64rem;color:rgba(255,255,255,.42);line-height:1.5;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;margin:0 0 2px;}
      .sr-detail-popup__divider{height:1px;background:rgba(255,255,255,.07);margin:10px 0;}
      .sr-detail-popup__actions{display:flex;gap:7px;}
      .sr-detail-popup__view-link{flex:1;display:inline-flex;align-items:center;justify-content:center;gap:5px;font-size:.63rem;font-weight:600;color:rgba(34,197,94,.80);text-decoration:none;padding:6px 10px;border-radius:7px;border:1px solid rgba(34,197,94,.22);background:rgba(34,197,94,.07);transition:background .15s,color .15s;}
      .sr-detail-popup__view-link:hover{background:rgba(34,197,94,.16);color:rgba(34,197,94,1);}
      .sr-detail-popup__request-btn{flex:1;display:inline-flex;align-items:center;justify-content:center;gap:5px;font-size:.63rem;font-weight:700;padding:6px 10px;border-radius:7px;border:1px solid rgba(0,164,220,.35);background:rgba(0,164,220,.14);color:rgba(0,200,255,.90);cursor:pointer;transition:background .15s,color .15s;}
      .sr-detail-popup__request-btn:hover:not(:disabled){background:rgba(0,164,220,.26);color:rgba(0,200,255,1);}
      .sr-detail-popup__request-btn:disabled{cursor:not-allowed;}
      .sr-detail-popup__request-btn--already{background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.09);color:rgba(255,255,255,.30);}
      .sr-detail-popup__request-btn--success{background:rgba(74,222,128,.14);border-color:rgba(74,222,128,.30);color:#86efac;}
      .sr-detail-popup__request-btn--error{background:rgba(248,113,113,.14);border-color:rgba(248,113,113,.30);color:#fca5a5;}
      @keyframes sr-detail-spin{to{transform:rotate(360deg);}}

      /* ── Season picker ── */
      .sr-season-picker{padding:4px 0 2px;}
      .sr-season-picker__header{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;}
      .sr-season-picker__title{font-size:.60rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:rgba(255,255,255,.35);}
      .sr-season-picker__all{font-size:.58rem;font-weight:700;padding:2px 9px;border-radius:99px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);color:rgba(255,255,255,.55);cursor:pointer;transition:background .12s,color .12s;}
      .sr-season-picker__all:hover{background:rgba(255,255,255,.12);color:rgba(255,255,255,.90);}
      .sr-season-picker__chips{display:flex;flex-wrap:wrap;gap:6px;}
      .sr-season-chip{display:inline-flex;align-items:center;gap:4px;padding:4px 9px;border-radius:7px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);cursor:pointer;user-select:none;transition:background .12s,border-color .12s;}
      .sr-season-chip input[type=checkbox]{display:none;}
      .sr-season-chip:not(.sr-season-chip--done):hover{background:rgba(0,164,220,.14);border-color:rgba(0,164,220,.35);}
      .sr-season-chip:has(input:checked):not(.sr-season-chip--done){background:rgba(0,164,220,.18);border-color:rgba(0,164,220,.50);}
      .sr-season-chip__label{font-size:.62rem;font-weight:700;color:rgba(255,255,255,.80);}
      .sr-season-chip:has(input:checked):not(.sr-season-chip--done) .sr-season-chip__label{color:rgba(0,200,255,.95);}
      .sr-season-chip__status{font-size:.54rem;font-weight:600;color:rgba(255,255,255,.35);}
      .sr-season-chip--done{cursor:default;opacity:.55;}
      .sr-season-chip--available{border-color:rgba(74,222,128,.25);background:rgba(74,222,128,.06);}
      .sr-season-chip--available .sr-season-chip__label{color:#86efac;}
      .sr-season-chip--available .sr-season-chip__status{color:rgba(74,222,128,.60);}
      .sr-season-chip--processing{border-color:rgba(168,85,247,.25);background:rgba(168,85,247,.06);}
      .sr-season-chip--processing .sr-season-chip__label{color:#d8b4fe;}
      .sr-season-chip--processing .sr-season-chip__status{color:rgba(168,85,247,.60);}
      .sr-season-chip--pending{border-color:rgba(251,191,36,.25);background:rgba(251,191,36,.06);}
      .sr-season-chip--pending .sr-season-chip__label{color:#fde68a;}
      .sr-season-chip--pending .sr-season-chip__status{color:rgba(251,191,36,.60);}

      /* ── Destination picker ── */
      .sr-dest-picker{padding:4px 0 2px;}
      .sr-dest-picker__row{display:flex;align-items:center;gap:8px;margin-bottom:6px;}
      .sr-dest-picker__row:last-child{margin-bottom:0;}
      .sr-dest-picker__label{font-size:.58rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:rgba(255,255,255,.35);width:38px;flex-shrink:0;}
      .sr-dest-picker__select{flex:1;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:7px;padding:5px 8px;color:rgba(255,255,255,.80);font-size:.64rem;outline:none;cursor:pointer;transition:border-color .15s;}
      .sr-dest-picker__select:focus{border-color:rgba(34,197,94,.40);}
      .sr-dest-picker__select option{background:#0d1117;color:rgba(255,255,255,.80);}
    `;
    document.head.appendChild(s);
  }

  // ── Build shell ──────────────────────────────────────────────────
  function buildShell(counts, requests, isLoading) {
    const pendingCount = counts?.pending ?? 0;
    const groups = groupRequests(requests);

    const sectionsHtml = isLoading
      ? Array(3).fill(`<div class="sr-skeleton-section"></div>`).join("")
      : requests === null
        ? `<div class="sr-error">⚠ Could not reach Jellyseerr</div>`
        : SECTION_ORDER.map(k => buildSection(k, groups[k])).join("");

    return `
      <div class="sr-shell">
        <div class="sr-header">
          <div class="sr-header-left">
            <img class="sr-icon" src="/icons/seerr.png" alt="Jellyseerr"
                 onerror="this.src='https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/jellyseerr.png'" />
            <span class="sr-title">Seerr</span>
            ${pendingCount > 0 ? `
              <span class="sr-stat-pill sr-pill--pending" style="padding:2px 8px;font-size:.65rem;">
                <span class="sr-stat-value">${pendingCount}</span>
                pending
              </span>` : ""}
          </div>

          <div class="sr-search-wrap">
            <span class="sr-search-input-icon">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            </span>
            <input type="text" class="sr-search-input" placeholder="Search movies &amp; TV…" autocomplete="off" value="${esc(_searchQuery)}" />
          </div>

          <a class="sr-open-link" href="${esc(SR_CONFIG.publicUrl)}" target="_blank" rel="noopener" title="Open Jellyseerr">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
              <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
            Open
          </a>
        </div>

        ${isLoading
        ? `<div class="sr-skeleton-row"></div>`
        : buildCountPills(counts, groups)}

        <div class="sr-sections">
          ${sectionsHtml}
        </div>

        <div class="sr-footer">Updated ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true })}</div>
      </div>`;
  }

  // ── TV Season Popup ──────────────────────────────────────────────
  const SEASON_STATUS = {
    1: { label: "Pending", cls: "sr-popup__season-badge--pending" },
    2: { label: "Approved", cls: "sr-popup__season-badge--approved" },
    3: { label: "Declined", cls: "sr-popup__season-badge--declined" },
    4: { label: "Processing", cls: "sr-popup__season-badge--processing" },
    5: { label: "Available", cls: "sr-popup__season-badge--available" },
  };

  let _activePopup = null;

  function closePopup() {
    if (_activePopup) { _activePopup.remove(); _activePopup = null; }
    const bd = document.getElementById("sr-popup-backdrop");
    if (bd) bd.remove();
  }

  function showCardPopup(card) {
    closePopup();

    const title = card.dataset.title || "Unknown";
    const user = card.dataset.user || "";
    const age = card.dataset.age || "";
    const poster = card.dataset.poster || "";
    const url = card.dataset.url || "#";
    const isPending = card.dataset.pending === "1";
    const reqId = card.dataset.reqid || "";
    let seasons = [];
    try { seasons = JSON.parse(card.dataset.seasons || "[]"); } catch (e) { }

    const hasSeasons = seasons.length > 0;
    const seasonsHtml = hasSeasons
      ? `<div class="sr-popup__divider"></div>
         <div class="sr-popup__seasons-label">Seasons Requested</div>
         <div class="sr-popup__seasons">
           ${seasons.slice().sort((a, b) => a.seasonNumber - b.seasonNumber).map(s => {
        const st = SEASON_STATUS[s.status] || { label: "Unknown", cls: "sr-popup__season-badge--unknown" };
        const label = s.seasonNumber === 0 ? "Specials" : `Season ${s.seasonNumber}`;
        return `<div class="sr-popup__season-row">
                       <span class="sr-popup__season-name">${label}</span>
                       <span class="sr-popup__season-badge ${st.cls}">${st.label}</span>
                     </div>`;
      }).join("")}
         </div>`
      : "";

    const pendingActionsHtml = isPending
      ? `<div class="sr-popup__divider"></div>
         <div class="sr-popup__actions">
           <button class="sr-popup__action-btn sr-popup__action-btn--approve" data-id="${reqId}">
             <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
             Approve
           </button>
           <button class="sr-popup__action-btn sr-popup__action-btn--decline" data-id="${reqId}">
             <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
             Decline
           </button>
         </div>`
      : "";

    const posterEl = poster
      ? `<img class="sr-popup__poster" src="${esc(poster)}" alt="" loading="lazy" onerror="this.style.display='none'">`
      : `<div class="sr-popup__poster" style="display:flex;align-items:center;justify-content:center;font-size:1rem;color:rgba(255,255,255,.2)">${title[0] || "?"}</div>`;

    const popup = document.createElement("div");
    popup.className = "sr-popup";
    popup.innerHTML = `
      <div class="sr-popup__header">
        ${posterEl}
        <div class="sr-popup__info">
          <div class="sr-popup__title">${title}</div>
          <div class="sr-popup__user">${user}</div>
          <div class="sr-popup__age">${age}</div>
        </div>
      </div>
      ${seasonsHtml}
      ${pendingActionsHtml}
      <div class="sr-popup__divider"></div>
      <a class="sr-popup__open-link" href="${esc(url)}" target="_blank" rel="noopener">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
          <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
        </svg>
        View on Jellyseerr
      </a>`;

    popup.querySelectorAll(".sr-popup__action-btn").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const action = btn.classList.contains("sr-popup__action-btn--approve") ? "approve" : "decline";
        btn.disabled = true;
        btn.textContent = action === "approve" ? "Approving…" : "Declining…";
        const ok = await actionRequest(id, action);
        if (ok) {
          closePopup();
          const host = getHost();
          if (host) setTimeout(() => refresh(host), 800);
        } else {
          btn.disabled = false;
          btn.innerHTML = action === "approve"
            ? `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg> Approve`
            : `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg> Decline`;
        }
      });
    });

    const rect = card.getBoundingClientRect();
    document.body.appendChild(popup);
    const pw = popup.offsetWidth, ph = popup.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = rect.right + 8;
    if (left + pw > vw - 8) left = rect.left - pw - 8;
    if (left < 8) left = 8;
    let top = rect.top;
    if (top + ph > vh - 8) top = vh - ph - 8;
    if (top < 8) top = 8;
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
    _activePopup = popup;

    const backdrop = document.createElement("div");
    backdrop.id = "sr-popup-backdrop";
    backdrop.className = "sr-popup-backdrop";
    backdrop.addEventListener("click", closePopup);
    document.body.appendChild(backdrop);
  }

  // ── Event binding ────────────────────────────────────────────────
  function bindEvents(host) {
    host.querySelectorAll("[data-toggle]").forEach(btn => {
      if (btn._srBound) return;
      btn._srBound = true;
      btn.addEventListener("click", () => {
        const key = btn.dataset.toggle;
        _sectionOpen[key] = !_sectionOpen[key];
        btn.classList.toggle("sr-section__header--open", _sectionOpen[key]);
        const body = btn.nextElementSibling;
        if (body) body.classList.toggle("sr-section__body--open", _sectionOpen[key]);
      });
    });

    host.querySelectorAll(".sr-action-btn").forEach(btn => {
      if (btn._srBound) return;
      btn._srBound = true;
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const action = btn.classList.contains("sr-action-btn--approve") ? "approve" : "decline";
        btn.disabled = true;
        btn.textContent = action === "approve" ? "Approving…" : "Declining…";
        const ok = await actionRequest(id, action);
        if (ok) {
          const card = host.querySelector(`.sr-poster-card[data-id="${id}"]`);
          if (card) { card.style.opacity = "0.3"; card.style.pointerEvents = "none"; }
          setTimeout(() => refresh(host), 1200);
        } else {
          btn.disabled = false;
          btn.textContent = action === "approve" ? "Approve" : "Decline";
        }
      });
    });

    host.querySelectorAll(".sr-poster-card--tv, .sr-poster-card--pending").forEach(card => {
      if (card._srBound) return;
      card._srBound = true;
      card.addEventListener("click", (e) => {
        if (e.target.closest(".sr-action-btn")) return;
        e.preventDefault();
        showCardPopup(card);
      });
    });

    const searchWrap = host.querySelector(".sr-search-wrap");
    const input = host.querySelector(".sr-search-input");

    if (input && !input._srBound) {
      input._srBound = true;
      input.addEventListener("input", () => {
        _searchQuery = input.value;
        clearTimeout(_searchDebounce);
        if (!_searchQuery.trim()) { closeSearchDropdown(); return; }
        _searchDebounce = setTimeout(async () => {
          const results = await searchMedia(_searchQuery);
          if (input.value === _searchQuery) showSearchDropdown(results, searchWrap || input);
        }, 380);
      });

      input.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { closeSearchDropdown(); input.value = ""; _searchQuery = ""; }
      });
    }

    if (!document._srEscBound) {
      document._srEscBound = true;
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { closePopup(); closeDetailPopup(); closeSearchDropdown(); }
      });
    }
  }

  // ── Render / Refresh ─────────────────────────────────────────────
  function updateHost(host, counts, requests, isLoading) {
    host.innerHTML = buildShell(counts, requests, isLoading);
    bindEvents(host);
  }

  async function refresh(host) {
    const [counts, requests] = await Promise.all([fetchCounts(), fetchRequests()]);
    _counts = counts;
    _requests = requests;
    updateHost(host, _counts, _requests, false);
  }

  async function render() {
    if (_rendering) return;
    _rendering = true;
    try {
      const group = findGroupContainer();
      if (!group) return;
      const host = ensureHost(group);
      if (!host.querySelector(".sr-shell")) {
        updateHost(host, undefined, undefined, true);
      }
      await refresh(host);
    } catch (err) {
      console.error("[SeerrWidget] Render error:", err);
    } finally {
      setTimeout(() => { _rendering = false; }, 1500);
    }
  }

  // ── Init ─────────────────────────────────────────────────────────
  function init() {
    injectSearchCSS();

    function scheduleNext() {
      if (_pollTimer) clearTimeout(_pollTimer);
      _pollTimer = setTimeout(async () => {
        const host = getHost();
        if (host) await refresh(host);
        scheduleNext();
      }, SR_CONFIG.pollMs);
    }

    const start = () => {
      setTimeout(async () => { await render(); scheduleNext(); }, 1600);
    };

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        const host = getHost();
        if (host) refresh(host).then(scheduleNext);
      }
    });

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }

    new MutationObserver(() => {
      if (_obsDelay || document.querySelector(".sr-host .sr-shell")) return;
      _obsDelay = setTimeout(() => { _obsDelay = null; render(); }, 700);
    }).observe(document.body, { childList: true, subtree: true });
  }

  init();
})();