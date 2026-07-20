/* =====================================================
JELLYFIN SLIDER
===================================================== */
(function () {
  const JF_CONFIG = {
    servers: [
      {
        label: "Jellyfin",
        baseUrl: "http://YOUR_LOCAL_IP:PORT",
        fallbackUrl: "https://YOUR_TUNNEL_URL", // or null if not using a tunnel
        activeUrl: null,
        apiKey: "YOUR_API_KEY_HERE",
        userId: "YOUR_USER_ID_HERE", // NOT your Jellyfin Username. Use your USER ID. Can be located in the Dev tools F12 under Networking and depending on your Jellyfin version, can be found in the top search bar.
        sections: [
          { key: "movies", title: "Movies", itemTypes: "Movie", limit: 15, parentId: "YOUR_PARENT_ID", fields: "ProductionYear,ImageTags,BackdropImageTags,Overview,Genres,RunTimeTicks,OfficialRating" },
          { key: "tvShows", title: "TV", itemTypes: "Series", limit: 15, parentId: "YOUR_PARENT_ID", fields: "ProductionYear,ImageTags,BackdropImageTags,Overview,Genres,RunTimeTicks,OfficialRating" },
          { key: "music", title: "Music", itemTypes: "MusicAlbum", limit: 15, parentId: "YOUR_PARENT_ID", fields: "AlbumArtist,Artists,ImageTags,AlbumPrimaryImageTag,ProductionYear,Overview,Genres" },
          { key: "collections", title: "Collections", itemTypes: "BoxSet", limit: 45, parentId: "YOUR_PARENT_ID", fields: "ProductionYear,ImageTags,BackdropImageTags,Overview,Genres,RunTimeTicks,OfficialRating,ChildCount" },
        ],
      },
    ],
    groupName: "JELLYFIN - SLIDER",
    pollMs: 5 * 120 * 1000,
    debug: false,
  };

  // Helper — always use current server's sections
  function getSections() { return JF_CONFIG.servers[_activeServerIdx].sections; }

  let _rendering = false;
  let _activeServerIdx = 0;
  let _activePopup = null;
  let _activeBackdrop = null;
  let _searchDebounce = null;
  let _lastSearchQuery = "";

  function getServer() { return JF_CONFIG.servers[_activeServerIdx]; }

  function log(...args) { if (JF_CONFIG.debug) console.log("[Homepage Jellyfin]", ...args); }
  function jellyfinHeaders() {
    return { "Content-Type": "application/json", "Authorization": `MediaBrowser Token="${getServer().apiKey}"` };
  }
  function normalizeText(v) { return (v || "").replace(/\s+/g, " ").trim(); }
  function escapeHtml(str = "") {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function clamp(v, mn, mx) { return Math.min(Math.max(v, mn), mx); }

  function findGroupContainer() {
    const headings = Array.from(document.querySelectorAll("h2, h3, .group-title, .service-group-name"));
    const heading = headings.find(el => normalizeText(el.textContent) === JF_CONFIG.groupName);
    if (!heading) { log("Group heading not found yet."); return null; }
    return heading.closest("section") || heading.closest("div[class*='group']") || heading.parentElement?.parentElement || heading.parentElement;
  }

  async function fetchJson(url) {
    const srv = getServer();
    const preferred = (srv.activeUrl || srv.baseUrl || "").replace(/\/$/, "");
    let safeUrl = String(url);
    try {
      const abs = new URL(safeUrl, `${preferred}/`);
      const knownHosts = new Set();
      for (const candidate of [srv.baseUrl, srv.fallbackUrl, srv.activeUrl]) {
        if (!candidate) continue;
        try { knownHosts.add(new URL(candidate).host); } catch (_) { /* ignore */ }
      }
      if (!preferred) {
        safeUrl = abs.href;
      } else if (knownHosts.has(abs.host) || !/^https?:\/\//i.test(String(url))) {
        safeUrl = `${preferred}${abs.pathname}${abs.search}`;
      } else {
        safeUrl = abs.href;
      }
    } catch (_) {
      /* keep original */
    }
    const res = await fetch(safeUrl, { method: "GET", headers: jellyfinHeaders(), mode: "cors", credentials: "omit" });
    if (!res.ok) throw new Error(`Jellyfin API error ${res.status}`);
    return await res.json();
  }

  async function fetchRecentSection(section) {
    const srv = getServer();
    const params = new URLSearchParams({
      Recursive: "true", IncludeItemTypes: section.itemTypes,
      SortBy: "DateCreated", SortOrder: "Descending",
      Limit: String(section.limit), Fields: section.fields
    });
    if (section.parentId) params.set("ParentId", section.parentId);
    const data = await fetchJson(`${srv.baseUrl}/Users/${srv.userId}/Items?${params}`);
    return data.Items || [];
  }

  async function fetchSearchResults(query) {
    const srv = getServer();
    const allTypes = [...new Set(getSections().map(s => s.itemTypes))].join(",");
    const params = new URLSearchParams({
      searchTerm: query, Recursive: "true", IncludeItemTypes: allTypes, Limit: "40",
      Fields: "ProductionYear,ImageTags,BackdropImageTags,Overview,Genres,RunTimeTicks,OfficialRating,AlbumArtist,Artists,AlbumPrimaryImageTag"
    });
    const data = await fetchJson(`${srv.baseUrl}/Users/${srv.userId}/Items?${params}`);
    return data.Items || [];
  }

  function buildImageUrl(item) {
    const base = getServer().baseUrl;
    if (!item?.Id) return "";
    if (item?.ImageTags?.Primary) return `${base}/Items/${item.Id}/Images/Primary?maxHeight=400&maxWidth=280&tag=${item.ImageTags.Primary}&quality=90`;
    if (item?.AlbumPrimaryImageTag) return `${base}/Items/${item.Id}/Images/Primary?maxHeight=280&maxWidth=280&tag=${item.AlbumPrimaryImageTag}&quality=90`;
    if (item?.ImageTags?.Thumb) return `${base}/Items/${item.Id}/Images/Thumb?maxHeight=400&maxWidth=280&tag=${item.ImageTags.Thumb}&quality=90`;
    return "";
  }

  function buildBackdropUrl(item) {
  const base = getServer().baseUrl;
    if (!item?.Id) return "";
    if (item?.BackdropImageTags?.length) return `${base}/Items/${item.Id}/Images/Backdrop/0?maxHeight=400&tag=${item.BackdropImageTags[0]}&quality=80`;
    return "";
  }

  function formatRuntime(ticks) {
    if (!ticks) return null;
    const m = Math.round(ticks / 600000000);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60), rm = m % 60;
    return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
  }

  function triggerDownload(itemId, filename) {
    const srv = getServer();
    const a = document.createElement("a");
    a.href = `${srv.baseUrl}/Items/${itemId}/Download?api_key=${srv.apiKey}`;
    if (filename) a.download = filename;
    a.target = "_blank"; a.rel = "noopener noreferrer";
    document.body.appendChild(a); a.click(); setTimeout(() => a.remove(), 200);
  }

  function triggerEpisodeDownloads(episodes, seriesName, seasonName) {
    episodes.forEach((ep, i) => {
      const n = String(ep.IndexNumber || "?").padStart(2, "0");
      setTimeout(() => triggerDownload(ep.Id, `${seriesName} - ${seasonName} - E${n} ${ep.Name || "Episode"}`), i * 150);
    });
  }

  async function fetchSeasons(seriesId) {
    const srv = getServer();
    const data = await fetchJson(`${srv.baseUrl}/Shows/${seriesId}/Seasons?userId=${srv.userId}&Fields=IndexNumber,Name,ImageTags`);
    return data.Items || [];
  }

  async function fetchEpisodes(seriesId, seasonId) {
    const srv = getServer();
    const data = await fetchJson(`${srv.baseUrl}/Shows/${seriesId}/Episodes?seasonId=${seasonId}&userId=${srv.userId}&Fields=IndexNumber,Name,RunTimeTicks,MediaSources`);
    return data.Items || [];
  }

  function isCollectionType(itemType, item) {
    return itemType === "Collections" || itemType === "BoxSet" || item?.Type === "BoxSet";
  }

  function formatTrackDuration(ticks) {
    if (!ticks) return "";
    const secs = Math.max(0, Math.round(ticks / 10000000));
    return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  }

  async function fetchCollectionItems(collectionId) {
    const srv = getServer();
    const params = new URLSearchParams({
      ParentId: collectionId,
      Fields: "ProductionYear,ImageTags,BackdropImageTags,Overview,Genres,RunTimeTicks,OfficialRating,Type",
      SortBy: "SortName",
      SortOrder: "Ascending",
      Limit: "100",
    });
    const data = await fetchJson(`${srv.baseUrl}/Users/${srv.userId}/Items?${params}`);
    return data.Items || [];
  }

  async function fetchAlbumTracks(albumId) {
    const srv = getServer();
    const params = new URLSearchParams({
      ParentId: albumId,
      IncludeItemTypes: "Audio",
      Fields: "IndexNumber,Name,RunTimeTicks,Artists,AlbumArtist",
      SortBy: "IndexNumber,SortName",
      SortOrder: "Ascending",
      Limit: "200",
    });
    const data = await fetchJson(`${srv.baseUrl}/Users/${srv.userId}/Items?${params}`);
    return data.Items || [];
  }

  async function queueSeriesDownloads(seriesItem, startOffset = 0) {
    const seasons = await fetchSeasons(seriesItem.Id);
    let offset = startOffset;
    for (const season of seasons) {
      const episodes = await fetchEpisodes(seriesItem.Id, season.Id);
      episodes.forEach(ep => {
        const n = String(ep.IndexNumber || "?").padStart(2, "0");
        setTimeout(
          () => triggerDownload(ep.Id, `${seriesItem.Name} - ${season.Name} - E${n} ${ep.Name || "Episode"}`),
          offset++ * 150
        );
      });
    }
    return offset;
  }

  async function downloadCollectionAll(children) {
    let offset = 0;
    for (const child of children) {
      if (child.Type === "Series") {
        offset = await queueSeriesDownloads(child, offset);
      } else {
        setTimeout(() => triggerDownload(child.Id, child.Name), offset++ * 150);
      }
    }
    return offset;
  }

  function renderOriginalActions(popup, item) {
    const srv = getServer();
    const itemType = popup.__jfItemType;
    const actionsEl = popup.querySelector(".jf-popup__actions");
    if (!actionsEl) return;
    const isSeries = itemType === "Series";
    const isMusic = itemType === "MusicAlbum";
    const isMediaLayout = popup.classList.contains("jf-popup--media") || popup.classList.contains("jf-popup--music");

    const detailsHref = `${srv.baseUrl}/web/index.html#!/details?id=${encodeURIComponent(item.Id)}`;
    const playHref = `${srv.baseUrl}/web/index.html#!/details?id=${encodeURIComponent(item.Id)}`;

    if (isMediaLayout) {
      actionsEl.innerHTML = `
        <a class="jf-popup__open-btn" href="${escapeHtml(detailsHref)}" target="_blank" rel="noopener noreferrer">Open in Jellyfin</a>
        <button class="jf-popup__download-btn" type="button">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          ${isSeries ? "Download Episodes" : (isMusic ? "Download Album" : "Download")}
        </button>`;
    } else {
      actionsEl.innerHTML = `
      <a class="jf-popup__play-btn" href="${escapeHtml(playHref)}" target="_blank" rel="noopener noreferrer">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        Play</a>
      ${isSeries ? `<button class="jf-popup__download-btn" type="button">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Download Episodes</button>`
          : `<button class="jf-popup__download-btn" type="button">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>${isMusic ? "Download Album" : "Download"}</button>`}
      <a class="jf-popup__details-btn" href="${escapeHtml(detailsHref)}" target="_blank" rel="noopener noreferrer">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>View Details in Jellyfin</a>`;
    }

    const dlBtn = actionsEl.querySelector(".jf-popup__download-btn");
    if (dlBtn) dlBtn.addEventListener("click", () =>
      isSeries ? renderDownloadPanel(popup, item) : triggerDownload(item.Id, item.Name)
    );
  }

  function renderDownloadPanel(popup, item) {
    const actionsEl = popup.querySelector(".jf-popup__actions");
    if (!actionsEl) return;
    actionsEl.innerHTML = `
      <div class="jf-dl-header">
        <button class="jf-dl-back" type="button" aria-label="Back">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M15 18l-6-6 6-6"/></svg>Back
        </button>
        <span class="jf-dl-title">Download</span>
      </div>
      <div class="jf-dl-body">
        <div class="jf-dl-mode-row">
          <button class="jf-dl-mode-btn jf-dl-mode-btn--active" data-mode="episode" type="button">Episode</button>
          <button class="jf-dl-mode-btn" data-mode="season" type="button">Season</button>
          <button class="jf-dl-mode-btn" data-mode="all" type="button">All Seasons</button>
        </div>
        <div class="jf-dl-picker" data-view="episode">
          <div class="jf-dl-loading"><svg class="jf-dl-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>Loading…</div>
        </div>
      </div>`;
    actionsEl.querySelector(".jf-dl-back").addEventListener("click", () => renderOriginalActions(popup, item));
    const modeBtns = actionsEl.querySelectorAll(".jf-dl-mode-btn");
    modeBtns.forEach(btn => btn.addEventListener("click", () => {
      modeBtns.forEach(b => b.classList.remove("jf-dl-mode-btn--active"));
      btn.classList.add("jf-dl-mode-btn--active");
      loadDownloadView(actionsEl, item, btn.dataset.mode);
    }));
    loadDownloadView(actionsEl, item, "episode");
  }

  async function loadDownloadView(actionsEl, item, mode) {
    const picker = actionsEl.querySelector(".jf-dl-picker");
    if (!picker) return;
    picker.setAttribute("data-view", mode);
    picker.innerHTML = `<div class="jf-dl-loading"><svg class="jf-dl-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>Loading…</div>`;
    try {
      const seasons = await fetchSeasons(item.Id);
      if (!seasons.length) { picker.innerHTML = `<div class="jf-dl-empty">No seasons found</div>`; return; }
      if (mode === "all") {
        picker.innerHTML = `<div class="jf-dl-confirm">
          <div class="jf-dl-confirm-msg">Download all ${seasons.length} season${seasons.length !== 1 ? "s" : ""}?<br><span style="font-size:0.65rem;opacity:0.55">Each episode downloads separately.</span></div>
          <button class="jf-dl-confirm-btn" type="button"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Download Everything</button></div>`;
        picker.querySelector(".jf-dl-confirm-btn").addEventListener("click", async e => {
          const btn = e.currentTarget; btn.disabled = true;
          btn.innerHTML = `<svg class="jf-dl-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>Preparing…`;
          try {
            const all = await Promise.all(seasons.map(s => fetchEpisodes(item.Id, s.Id).then(eps => ({ season: s, eps }))));
            let offset = 0;
            all.forEach(({ season, eps }) => eps.forEach(ep => {
              const n = String(ep.IndexNumber || "?").padStart(2, "0");
              setTimeout(() => triggerDownload(ep.Id, `${item.Name} - ${season.Name} - E${n} ${ep.Name || "Episode"}`), offset++ * 150);
            }));
            const total = all.reduce((s, { eps }) => s + eps.length, 0);
            btn.innerHTML = `✓ ${total} episode${total !== 1 ? "s" : ""} downloading`;
          } catch { btn.disabled = false; btn.textContent = "Error — try again"; }
        });
      } else {
        const list = seasons.map(s => `<button class="jf-dl-list-item" data-id="${escapeHtml(s.Id)}" data-name="${escapeHtml(s.Name)}" type="button">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>${escapeHtml(s.Name)}</button>`).join("");
        picker.innerHTML = `${mode === "episode" ? `<div class="jf-dl-hint">Select a season</div>` : ""}<div class="jf-dl-list">${list}</div>`;
        picker.querySelectorAll(".jf-dl-list-item").forEach(btn => {
          btn.addEventListener("click", async () => {
            const { id: seasonId, name: seasonName } = btn.dataset;
            btn.disabled = true;
            btn.innerHTML = `<svg class="jf-dl-spin" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>Loading…`;
            try {
              const episodes = await fetchEpisodes(item.Id, seasonId);
              if (!episodes.length) { btn.textContent = "No episodes"; btn.disabled = false; return; }
              if (mode === "season") {
                picker.innerHTML = `<div class="jf-dl-confirm">
                  <div class="jf-dl-confirm-msg">${escapeHtml(seasonName)}<br><span style="font-size:0.65rem;opacity:0.55">${episodes.length} episode${episodes.length !== 1 ? "s" : ""} · each downloads separately</span></div>
                  <button class="jf-dl-confirm-btn" type="button"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Download Season</button>
                  <button class="jf-dl-back-inline" type="button">← Back to seasons</button></div>`;
                picker.querySelector(".jf-dl-confirm-btn").addEventListener("click", e => {
                  const cb = e.currentTarget; cb.disabled = true;
                  cb.innerHTML = `<svg class="jf-dl-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>Starting…`;
                  triggerEpisodeDownloads(episodes, item.Name, seasonName);
                  setTimeout(() => { cb.innerHTML = `✓ ${episodes.length} episode${episodes.length !== 1 ? "s" : ""} downloading`; }, 800);
                });
                picker.querySelector(".jf-dl-back-inline").addEventListener("click", () => loadDownloadView(actionsEl, item, "season"));
              } else {
                const epList = episodes.map(ep => `<button class="jf-dl-list-item jf-dl-list-item--episode"
                  data-id="${escapeHtml(ep.Id)}" data-epnum="${String(ep.IndexNumber || "").padStart(2, "0")}" data-name="${escapeHtml(ep.Name || "")}" type="button">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  <span class="jf-dl-ep-num">E${String(ep.IndexNumber || "?").padStart(2, "0")}</span>
                  <span class="jf-dl-ep-name">${escapeHtml(ep.Name || "Episode")}</span></button>`).join("");
                picker.innerHTML = `<button class="jf-dl-back-inline" type="button">← ${escapeHtml(seasonName)}</button><div class="jf-dl-list jf-dl-list--episodes">${epList}</div>`;
                picker.querySelector(".jf-dl-back-inline").addEventListener("click", () => loadDownloadView(actionsEl, item, "episode"));
                picker.querySelectorAll(".jf-dl-list-item--episode").forEach(epBtn => {
                  epBtn.addEventListener("click", () => {
                    if (epBtn.disabled) return;
                    epBtn.disabled = true;
                    triggerDownload(epBtn.dataset.id, `${item.Name} - ${seasonName} - E${epBtn.dataset.epnum} ${epBtn.dataset.name}`);
                    const orig = epBtn.innerHTML;
                    epBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="20 6 9 17 4 12"/></svg><span class="jf-dl-ep-num" style="color:inherit">✓</span><span class="jf-dl-ep-name">${escapeHtml(epBtn.dataset.name)}</span>`;
                    setTimeout(() => { epBtn.innerHTML = orig; epBtn.disabled = false; }, 1800);
                  });
                });
              }
            } catch { btn.textContent = "Error loading"; btn.disabled = false; }
          });
        });
      }
    } catch (err) {
      picker.innerHTML = `<div class="jf-dl-empty">Failed to load seasons</div>`;
      console.error("[Homepage Jellyfin] Download fetch failed:", err);
    }
  }

  // ── Popup ─────────────────────────────────────────────────────────────────
  function closePopup() {
    if (_activePopup) { _activePopup.remove(); _activePopup = null; }
    if (_activeBackdrop) { _activeBackdrop.remove(); _activeBackdrop = null; }
  }

  function positionPopup(popup, anchorEl, size = {}) {
    const W = size.width || 260;
    const H = size.height || 380;
    const M = 12;
    const a = anchorEl.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = a.left + a.width / 2 - W / 2;
    let top = a.bottom + M;
    if (top + H > vh - M) top = a.top - H - M;
    popup.style.left = `${clamp(left, M, vw - W - M)}px`;
    popup.style.top = `${clamp(top, M, Math.max(M, vh - Math.min(H, vh - M * 2) - M))}px`;
    popup.style.width = `${Math.min(W, vw - M * 2)}px`;
  }

  function attachPopupChrome(popup, backdrop, anchorEl, size) {
    document.body.appendChild(popup);
    _activePopup = popup;
    positionPopup(popup, anchorEl, size);
    const reposition = () => { if (_activePopup === popup) positionPopup(popup, anchorEl, size); };
    window.addEventListener("resize", reposition, { passive: true });
    window.addEventListener("scroll", reposition, { passive: true, capture: true });
    backdrop.addEventListener("click", () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, { capture: true });
    }, { once: true });
  }

  function createPopupShell(extraClass = "") {
    closePopup();
    const backdrop = document.createElement("div");
    backdrop.className = "jf-popup-backdrop";
    backdrop.addEventListener("click", closePopup);
    document.body.appendChild(backdrop);
    _activeBackdrop = backdrop;

    const popup = document.createElement("div");
    popup.className = `jf-popup${extraClass ? ` ${extraClass}` : ""}`;
    popup.addEventListener("click", e => e.stopPropagation());
    return { popup, backdrop };
  }

  function openPopup(item, itemType, anchorEl) {
    if (isCollectionType(itemType, item)) return openCollectionPopup(item, itemType, anchorEl);
    if (itemType === "MusicAlbum" || item?.Type === "MusicAlbum") return openMusicPopup(item, itemType, anchorEl);
    return openMediaPopup(item, itemType, anchorEl);
  }

  function resolveSectionTitle(item) {
    const parentId = item?.ParentId || item?.LibraryId || item?.ParentLibraryItemId;
    if (parentId) {
      const section = getSections().find(s => s.parentId === parentId);
      if (section?.title) return section.title;
    }
    return null;
  }

  function attachCenteredPopup(popup, backdrop) {
    document.body.appendChild(popup);
    _activePopup = popup;
    backdrop.classList.add("jf-popup-backdrop--dim");
    popup.querySelector(".jf-popup__close")?.addEventListener("click", closePopup);
  }

  function openMediaPopup(item, itemType, anchorEl) {
    const isSeries = itemType === "Series" || item?.Type === "Series";
    const resolvedType = isSeries ? "Series" : (itemType === "Movie" || item?.Type === "Movie" ? "Movie" : itemType);
    const title = item?.Name || "Untitled";
    const year = item?.ProductionYear ? String(item.ProductionYear) : null;
    const rating = item?.OfficialRating || null;
    const runtime = formatRuntime(item?.RunTimeTicks);
    const overview = item?.Overview || "No summary available.";
    const imageUrl = buildImageUrl(item);
    const backdropUrl = buildBackdropUrl(item);
    const typeLabel = isSeries ? "Series" : (resolvedType === "Movie" ? "Movie" : (resolvedType || "Media"));
    const sectionTitle = resolveSectionTitle(item) || (isSeries ? "TV" : "Movies");
    const kicker = [sectionTitle, typeLabel, year].filter(Boolean).join(" · ");
    const meta = [runtime, rating, year].filter(Boolean).join(" · ");

    const { popup, backdrop } = createPopupShell("jf-popup--media");
    popup.__jfItemType = resolvedType;
    popup.innerHTML = `
      <button class="jf-popup__close" type="button" aria-label="Close">×</button>
      ${backdropUrl ? `<div class="jf-popup__bg" style="background-image:url('${escapeHtml(backdropUrl)}')"></div>` : ""}
      <div class="jf-popup__body jf-popup__body--media">
        <div class="jf-popup__poster-wrap">
          ${imageUrl
        ? `<img class="jf-popup__poster-lg" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(title)}"/>`
        : `<div class="jf-popup__poster-placeholder jf-popup__poster-placeholder--lg">${escapeHtml(title.charAt(0))}</div>`}
        </div>
        <div class="jf-popup__info jf-popup__info--media">
          <div class="jf-popup__kicker">${escapeHtml(kicker)}</div>
          <div class="jf-popup__title jf-popup__title--media">${escapeHtml(title)}</div>
          ${meta ? `<div class="jf-popup__meta">${escapeHtml(meta)}</div>` : ""}
          <div class="jf-popup__summary">${escapeHtml(overview)}</div>
          <div class="jf-popup__actions jf-popup__actions--media"></div>
        </div>
      </div>`;
    renderOriginalActions(popup, item);
    attachCenteredPopup(popup, backdrop);
  }

  function openMusicPopup(item, itemType, anchorEl) {
    const title = item?.Name || "Untitled";
    const artist = item?.AlbumArtist || item?.Artists?.[0] || "Unknown Artist";
    const year = item?.ProductionYear ? String(item.ProductionYear) : null;
    const genres = (item?.Genres || []).slice(0, 3).join(" · ") || null;
    const overview = item?.Overview || "";
    const imageUrl = buildImageUrl(item);
    const backdropUrl = buildBackdropUrl(item) || imageUrl;
    const sectionTitle = resolveSectionTitle(item) || "Music";
    const kicker = [sectionTitle, "Album", year].filter(Boolean).join(" · ");
    const meta = [artist, year, genres].filter(Boolean).join(" · ");

    const { popup, backdrop } = createPopupShell("jf-popup--music");
    popup.__jfItemType = "MusicAlbum";
    popup.innerHTML = `
      <button class="jf-popup__close" type="button" aria-label="Close">×</button>
      ${backdropUrl ? `<div class="jf-popup__bg" style="background-image:url('${escapeHtml(backdropUrl)}')"></div>` : ""}
      <div class="jf-popup__body jf-popup__body--music">
        <div class="jf-popup__cover-wrap">
          ${imageUrl
        ? `<img class="jf-popup__cover" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(title)}"/>`
        : `<div class="jf-popup__cover-placeholder">${escapeHtml(title.charAt(0))}</div>`}
        </div>
        <div class="jf-popup__info jf-popup__info--music">
          <div class="jf-popup__kicker">${escapeHtml(kicker)}</div>
          <div class="jf-popup__title jf-popup__title--media">${escapeHtml(title)}</div>
          <div class="jf-popup__meta">${escapeHtml(meta)}</div>
          ${overview ? `<div class="jf-popup__summary">${escapeHtml(overview)}</div>` : ""}
          <div class="jf-popup__actions jf-popup__actions--media"></div>
          <div class="jf-popup__track-section">
            <div class="jf-popup__section-label">Tracks</div>
            <div class="jf-popup__track-list"><div class="jf-dl-loading"><svg class="jf-dl-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>Loading tracks…</div></div>
          </div>
        </div>
      </div>`;
    renderOriginalActions(popup, item);
    attachCenteredPopup(popup, backdrop);

    const trackList = popup.querySelector(".jf-popup__track-list");
    fetchAlbumTracks(item.Id).then(tracks => {
      if (_activePopup !== popup || !trackList) return;
      if (!tracks.length) {
        trackList.innerHTML = `<div class="jf-dl-empty">No tracks found</div>`;
        return;
      }
      const sectionLabel = popup.querySelector(".jf-popup__section-label");
      if (sectionLabel) sectionLabel.textContent = `${tracks.length} Track${tracks.length !== 1 ? "s" : ""}`;
      trackList.innerHTML = tracks.map(track => {
        const num = track.IndexNumber != null ? String(track.IndexNumber) : "–";
        const dur = formatTrackDuration(track.RunTimeTicks);
        const trackArtist = (track.Artists && track.Artists[0]) || artist;
        return `<div class="jf-popup__track" data-id="${escapeHtml(track.Id)}" data-name="${escapeHtml(track.Name || "Track")}">
          <span class="jf-popup__track-num">${escapeHtml(num)}</span>
          <span class="jf-popup__track-meta">
            <span class="jf-popup__track-name">${escapeHtml(track.Name || "Track")}</span>
            <span class="jf-popup__track-artist">${escapeHtml(trackArtist)}</span>
          </span>
          <span class="jf-popup__track-dur">${escapeHtml(dur)}</span>
          <button class="jf-popup__track-dl" type="button" aria-label="Download track" title="Download">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </button>
        </div>`;
      }).join("");
      trackList.querySelectorAll(".jf-popup__track-dl").forEach(btn => {
        btn.addEventListener("click", e => {
          e.stopPropagation();
          const row = btn.closest(".jf-popup__track");
          if (!row) return;
          triggerDownload(row.dataset.id, row.dataset.name);
          btn.classList.add("is-done");
          setTimeout(() => btn.classList.remove("is-done"), 1600);
        });
      });
    }).catch(err => {
      console.error("[Homepage Jellyfin] Album tracks fetch failed:", err);
      if (trackList) trackList.innerHTML = `<div class="jf-dl-empty">Failed to load tracks</div>`;
    });
  }

  function openCollectionPopup(item, itemType, anchorEl) {
    const srv = getServer();
    const title = item?.Name || "Untitled";
    const year = item?.ProductionYear ? String(item.ProductionYear) : null;
    const overview = item?.Overview || null;
    const imageUrl = buildImageUrl(item);
    const backdropUrl = buildBackdropUrl(item);
    const detailsHref = `${srv.baseUrl}/web/index.html#!/details?id=${encodeURIComponent(item.Id)}`;
    const childCount = item?.ChildCount != null ? `${item.ChildCount} item${item.ChildCount !== 1 ? "s" : ""}` : null;
    const subtitle = [year, childCount].filter(Boolean).join(" · ");

    const { popup, backdrop } = createPopupShell("jf-popup--collection");
    popup.__jfItemType = "BoxSet";
    popup.__jfCollectionChildren = [];
    popup.innerHTML = `
      ${backdropUrl ? `<img class="jf-popup__backdrop-img" src="${escapeHtml(backdropUrl)}" alt="" aria-hidden="true"/>` : ""}
      <div class="jf-popup__body">
        <div class="jf-popup__poster-row">
          ${imageUrl
        ? `<img class="jf-popup__poster" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(title)}"/>`
        : `<div class="jf-popup__poster-placeholder">${escapeHtml(title.charAt(0))}</div>`}
          <div class="jf-popup__info">
            <div class="jf-popup__title-row">
              <div class="jf-popup__title">${escapeHtml(title)}</div>
              <div class="jf-popup__collection-actions">
                <button class="jf-popup__download-all-btn" type="button" disabled>Download All</button>
                <a class="jf-popup__open-collection-btn" href="${escapeHtml(detailsHref)}" target="_blank" rel="noopener noreferrer">Open</a>
              </div>
            </div>
            ${subtitle ? `<div class="jf-popup__subtitle">${escapeHtml(subtitle)}</div>` : ""}
            <div class="jf-popup__type-badge">
              <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10"/></svg>Collection
            </div>
          </div>
        </div>
        ${overview ? `<div class="jf-popup__divider"></div><div class="jf-popup__overview">${escapeHtml(overview)}</div>` : ""}
        <div class="jf-popup__divider"></div>
        <div class="jf-popup__collection-body">
          <div class="jf-popup__section-label">In this collection</div>
          <div class="jf-popup__items-grid"><div class="jf-dl-loading"><svg class="jf-dl-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>Loading items…</div></div>
        </div>
      </div>`;
    attachPopupChrome(popup, backdrop, anchorEl, { width: 440, height: 560 });

    const grid = popup.querySelector(".jf-popup__items-grid");
    const dlAllBtn = popup.querySelector(".jf-popup__download-all-btn");

    fetchCollectionItems(item.Id).then(children => {
      if (_activePopup !== popup || !grid) return;
      popup.__jfCollectionChildren = children;
      if (!children.length) {
        grid.innerHTML = `<div class="jf-dl-empty">No items in this collection</div>`;
        return;
      }
      const sectionLabel = popup.querySelector(".jf-popup__section-label");
      if (sectionLabel) sectionLabel.textContent = `${children.length} Item${children.length !== 1 ? "s" : ""}`;
      if (dlAllBtn) dlAllBtn.disabled = false;

      grid.innerHTML = children.map((child, index) => {
        const childType = child.Type || "Movie";
        const childTitle = escapeHtml(child.Name || "Untitled");
        const childYear = child.ProductionYear ? escapeHtml(String(child.ProductionYear)) : (childType === "Series" ? "TV Show" : "Movie");
        const childImage = buildImageUrl(child);
        return `<button class="jf-collection-card-wrap" type="button" data-index="${index}" aria-label="${childTitle}">
          <div class="jf-card jf-card--compact">
            <div class="jf-card__art">
              ${childImage
            ? `<img src="${escapeHtml(childImage)}" alt="${childTitle}" loading="lazy" decoding="async"/>`
            : `<div class="jf-card__art-placeholder"><span>${childTitle.charAt(0)}</span></div>`}
              <div class="jf-card__overlay">
                <div class="jf-card__overlay-title">${childTitle}</div>
                <div class="jf-card__overlay-sub">${childYear}</div>
              </div>
            </div>
          </div>
        </button>`;
      }).join("");

      grid.querySelectorAll(".jf-collection-card-wrap").forEach(btn => {
        btn.addEventListener("click", () => {
          const child = children[Number(btn.dataset.index)];
          if (!child) return;
          openPopup(child, child.Type || "Movie", anchorEl);
        });
      });

      if (dlAllBtn) {
        dlAllBtn.addEventListener("click", async () => {
          if (dlAllBtn.disabled) return;
          dlAllBtn.disabled = true;
          const orig = dlAllBtn.textContent;
          dlAllBtn.textContent = "Preparing…";
          try {
            const total = await downloadCollectionAll(children);
            dlAllBtn.textContent = total ? `✓ ${total} downloading` : "Nothing to download";
            setTimeout(() => { dlAllBtn.textContent = orig; dlAllBtn.disabled = false; }, 2200);
          } catch (err) {
            console.error("[Homepage Jellyfin] Collection download failed:", err);
            dlAllBtn.textContent = "Error — try again";
            dlAllBtn.disabled = false;
          }
        });
      }

      positionPopup(popup, anchorEl, { width: 440, height: 560 });
    }).catch(err => {
      console.error("[Homepage Jellyfin] Collection items fetch failed:", err);
      if (grid) grid.innerHTML = `<div class="jf-dl-empty">Failed to load collection</div>`;
    });
  }

  // ── Cards ─────────────────────────────────────────────────────────────────
  function buildCardElement(item, itemType, index) {
    const isMusic = itemType === "MusicAlbum";
    const isCollection = isCollectionType(itemType, item);
    const title = escapeHtml(item?.Name || "Untitled");
    let subtitle = "Recently added";
    if (isMusic) subtitle = escapeHtml(item?.AlbumArtist || item?.Artists?.[0] || "Album");
    else if (isCollection) {
      const count = item?.ChildCount != null ? `${item.ChildCount} item${item.ChildCount !== 1 ? "s" : ""}` : "Collection";
      subtitle = item?.ProductionYear ? escapeHtml(`${item.ProductionYear} · ${count}`) : escapeHtml(count);
    }
    else if (item?.ProductionYear) subtitle = escapeHtml(String(item.ProductionYear));
    else if (itemType === "Series") subtitle = "TV Show";
    else if (itemType === "Movie") subtitle = "Movie";
    const image = buildImageUrl(item);
    const card = document.createElement("div");
    card.className = `jf-card${isMusic ? " jf-card--music" : ""}`;
    card.style.cssText = `opacity:0;transform:translateY(10px);transition:opacity 0.28s ease ${index * 35}ms,transform 0.28s ease ${index * 35}ms`;
    card.setAttribute("role", "button"); card.setAttribute("tabindex", "0");
    card.setAttribute("aria-label", `${item?.Name || "Untitled"} — view details`);
    card.innerHTML = `
      <div class="jf-card__art">
        ${image ? `<img src="${image}" alt="${title}" loading="lazy" decoding="async"/>`
        : `<div class="jf-card__art-placeholder"><span>${title.charAt(0)}</span></div>`}
        <div class="jf-card__overlay">
          <div class="jf-card__overlay-title">${title}</div>
          <div class="jf-card__overlay-sub">${subtitle}</div>
        </div>
      </div>
      <div class="jf-card__meta">
        <div class="jf-card__title">${title}</div>
        <div class="jf-card__subtitle">${subtitle}</div>
      </div>`;
    card.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); openPopup(item, itemType, card); });
    card.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPopup(item, itemType, card); } });
    return card;
  }

  function buildSkeletonCards(count = 8, isMusic = false) {
    return Array.from({ length: count }, () => {
      const el = document.createElement("div");
      el.className = `jf-card jf-card--skeleton${isMusic ? " jf-card--music" : ""}`;
      el.innerHTML = `<div class="jf-card__art jf-skeleton"></div><div class="jf-card__meta"><div class="jf-skeleton jf-skeleton--title"></div><div class="jf-skeleton jf-skeleton--sub"></div></div>`;
      return el;
    });
  }

  function buildSliderMarkup() {
    return `<div class="jf-slider-wrap">
      <button class="jf-slider__btn jf-slider__btn--left" type="button" aria-label="Scroll left">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>
      </button>
      <div class="jf-slider"><div class="jf-slider__rail"><div class="jf-slider__fill"></div><div class="jf-slider__thumb" tabindex="0" role="slider" aria-label="Jellyfin slider"></div></div></div>
      <button class="jf-slider__btn jf-slider__btn--right" type="button" aria-label="Scroll right">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
      </button>
    </div>`;
  }

  function ensureHost(group) {
    let row = group.querySelector(".hp-widget-row, .jellyfin-flex-row");
    if (!row) {
      const existingList = group.querySelector("ul.services-list, ul");
      if (existingList) existingList.style.display = "none";
      row = document.createElement("div");
      row.className = "hp-widget-row jellyfin-flex-row";
      group.appendChild(row);
    } else {
      row.classList.add("hp-widget-row", "jellyfin-flex-row");
    }
    let host = row.querySelector(".jellyfin-host");
    if (host) return host;
    host = document.createElement("div");
    host.className = "jellyfin-host";
    row.appendChild(host);
    return host;
  }

  function updateSlider(panel) {
    if (!panel) return;
    const track = panel.querySelector(".jf-track");
    const rail = panel.querySelector(".jf-slider__rail");
    const thumb = panel.querySelector(".jf-slider__thumb");
    const fill = panel.querySelector(".jf-slider__fill");
    const leftBtn = panel.querySelector(".jf-slider__btn--left");
    const rightBtn = panel.querySelector(".jf-slider__btn--right");
    const slider = panel.querySelector(".jf-slider");
    if (!track || !rail || !thumb || !fill || !leftBtn || !rightBtn) return;
    const maxScroll = Math.max(0, track.scrollWidth - track.clientWidth);
    const ratio = maxScroll > 0 ? track.scrollLeft / maxScroll : 0;
    const usable = Math.max(0, rail.clientWidth - (thumb.offsetWidth || 18));
    const leftPx = usable * ratio;
    thumb.style.left = `${leftPx}px`;
    fill.style.width = `${leftPx + (thumb.offsetWidth || 18) / 2}px`;
    const disabled = maxScroll <= 2;
    slider?.classList.toggle("is-disabled", disabled);
    leftBtn.disabled = disabled || track.scrollLeft <= 2;
    rightBtn.disabled = disabled || track.scrollLeft >= maxScroll - 2;
  }

  function bindSlider(panel) {
    if (!panel) return;
    const rail = panel.querySelector(".jf-slider__rail");
    const thumb = panel.querySelector(".jf-slider__thumb");
    const leftBtn = panel.querySelector(".jf-slider__btn--left");
    const rightBtn = panel.querySelector(".jf-slider__btn--right");
    const getTrack = () => panel.querySelector(".jf-track");
    if (!rail || !thumb || !leftBtn || !rightBtn) return;

    let dragging = false, rafId = null, targetScrollLeft = 0;
    const getStep = () => { const t = getTrack(); return t ? Math.max(220, Math.floor(t.clientWidth * 0.82)) : 220; };
    const stopAnim = () => { if (rafId) { cancelAnimationFrame(rafId); rafId = null; } };
    const animTo = () => {
      const t = getTrack(); if (!t) { rafId = null; return; }
      const diff = targetScrollLeft - t.scrollLeft;
      if (Math.abs(diff) < 0.5) { t.scrollLeft = targetScrollLeft; updateSlider(panel); rafId = null; return; }
      t.scrollLeft += diff * 0.18; updateSlider(panel); rafId = requestAnimationFrame(animTo);
    };
    const setTarget = (v, immediate = false) => {
      const t = getTrack(); if (!t) return;
      targetScrollLeft = clamp(v, 0, Math.max(0, t.scrollWidth - t.clientWidth));
      if (immediate) { stopAnim(); t.scrollLeft = targetScrollLeft; updateSlider(panel); return; }
      if (!rafId) rafId = requestAnimationFrame(animTo);
    };
    const doScroll = delta => { const t = getTrack(); if (t) setTarget(t.scrollLeft + delta); };

    if (!leftBtn.dataset.bound) { leftBtn.dataset.bound = "1"; leftBtn.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); doScroll(-getStep()); }); }
    if (!rightBtn.dataset.bound) { rightBtn.dataset.bound = "1"; rightBtn.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); doScroll(getStep()); }); }
    if (!panel.dataset.trackScrollBound) {
      panel.dataset.trackScrollBound = "1";
      panel.addEventListener("scroll", e => { if (e.target?.classList?.contains("jf-track")) updateSlider(panel); }, { passive: true, capture: true });
    }
    if (!rail.dataset.bound) {
      rail.dataset.bound = "1";
      rail.addEventListener("click", e => {
        e.preventDefault(); e.stopPropagation(); if (e.target === thumb) return;
        const t = getTrack(); if (!t) return;
        const rect = rail.getBoundingClientRect(), tw = thumb.offsetWidth || 18;
        const usable = Math.max(0, rect.width - tw);
        const x = clamp(e.clientX - rect.left - tw / 2, 0, usable);
        setTarget((usable > 0 ? x / usable : 0) * Math.max(0, t.scrollWidth - t.clientWidth));
      });
    }
    if (!thumb.dataset.bound) {
      thumb.dataset.bound = "1";
      const moveThumb = cx => {
        const t = getTrack(); if (!t) return;
        const rect = rail.getBoundingClientRect(), tw = thumb.offsetWidth || 18;
        const usable = Math.max(0, rect.width - tw);
        const x = clamp(cx - rect.left - tw / 2, 0, usable);
        setTarget((usable > 0 ? x / usable : 0) * Math.max(0, t.scrollWidth - t.clientWidth), true);
      };
      const stopDrag = () => { dragging = false; panel.classList.remove("jf-slider--dragging"); };
      thumb.addEventListener("pointerdown", e => { e.preventDefault(); e.stopPropagation(); dragging = true; stopAnim(); panel.classList.add("jf-slider--dragging"); try { thumb.setPointerCapture(e.pointerId); } catch { } });
      thumb.addEventListener("pointermove", e => { if (dragging) moveThumb(e.clientX); });
      thumb.addEventListener("pointerup", e => { stopDrag(); try { thumb.releasePointerCapture(e.pointerId); } catch { } });
      thumb.addEventListener("pointercancel", stopDrag);
      thumb.addEventListener("mousedown", e => { e.preventDefault(); e.stopPropagation(); dragging = true; stopAnim(); panel.classList.add("jf-slider--dragging"); });
      document.addEventListener("mousemove", e => { if (dragging) moveThumb(e.clientX); });
      document.addEventListener("mouseup", stopDrag);
      thumb.addEventListener("keydown", e => {
        if (e.key === "ArrowLeft") { e.preventDefault(); doScroll(-getStep()); }
        if (e.key === "ArrowRight") { e.preventDefault(); doScroll(getStep()); }
      });
    }
    updateSlider(panel);
  }

  // ── Tab activation ────────────────────────────────────────────────────────
  function activateTab(shell, key) {
    shell.querySelectorAll(".jf-tab").forEach(tab => {
      const active = tab.dataset.tab === key;
      tab.classList.toggle("jf-tab--active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    shell.querySelectorAll(".jf-panel").forEach(panel => panel.classList.toggle("jf-panel--active", panel.dataset.panel === key));
    shell.querySelector(".jf-search-panel")?.classList.remove("jf-search-panel--active");
    requestAnimationFrame(() => { const p = shell.querySelector(`.jf-panel[data-panel="${key}"]`); bindSlider(p); updateSlider(p); });
  }

  // ── Server switcher ───────────────────────────────────────────────────────
  async function switchServer(idx, shell) {
    if (idx === _activeServerIdx) return;
    closePopup();
    _activeServerIdx = idx;
    _lastSearchQuery = "";

    // Update server button states
    shell.querySelectorAll(".jf-server-btn").forEach(btn => {
      btn.classList.toggle("jf-server-btn--active", parseInt(btn.dataset.server) === idx);
    });

    const openBtn = shell.querySelector(".jf-open-btn");
    if (openBtn) openBtn.href = getServer().baseUrl;

    const sections = getSections();

    // Rebuild tabs to match new server's section list
    const tabsContainer = shell.querySelector(".jf-tabs");
    if (tabsContainer) {
      tabsContainer.innerHTML = "";
      sections.forEach((section, i) => {
        const tab = document.createElement("button");
        tab.className = `jf-tab${i === 0 ? " jf-tab--active" : ""}`;
        tab.type = "button";
        tab.textContent = section.title;
        tab.dataset.tab = section.key;
        tab.setAttribute("role", "tab");
        tab.setAttribute("aria-selected", String(i === 0));
        tab.addEventListener("click", () => activateTab(shell, section.key));
        tabsContainer.appendChild(tab);
      });
    }

    // Rebuild panels to match new server's section list
    const panelsContainer = shell.querySelector(".jf-panels");
    if (panelsContainer) {
      // Remove old section panels (keep the search panel)
      panelsContainer.querySelectorAll(".jf-panel").forEach(p => p.remove());

      sections.forEach((section, i) => {
        const panel = document.createElement("div");
        panel.className = `jf-panel${i === 0 ? " jf-panel--active" : ""}`;
        panel.dataset.panel = section.key;
        const track = document.createElement("div");
        track.className = "jf-track";
        buildSkeletonCards(8, section.itemTypes === "MusicAlbum").forEach(c => track.appendChild(c));
        panel.appendChild(track);
        panel.insertAdjacentHTML("beforeend", buildSliderMarkup());
        // Insert before the search panel
        const searchPanel = panelsContainer.querySelector(".jf-search-panel");
        panelsContainer.insertBefore(panel, searchPanel);
      });

      // Bind sliders on new panels
      panelsContainer.querySelectorAll(".jf-panel").forEach(bindSlider);
    }

    // Fetch data from new server
    const results = await Promise.all(sections.map(async section => {
      try { return { section, items: await fetchRecentSection(section), ok: true }; }
      catch (err) { console.error(`[Jellyfin] Section "${section.key}" failed on server ${idx}:`, err); return { section, items: [], ok: false }; }
    }));
    results.forEach(({ section, items }) => populatePanel(shell, section.key, items, section.itemTypes));
  }

  // ── Search ────────────────────────────────────────────────────────────────
  function showSearchResults(shell, items) {
    shell.querySelectorAll(".jf-panel").forEach(p => p.classList.remove("jf-panel--active"));
    const searchPanel = shell.querySelector(".jf-search-panel");
    if (!searchPanel) return;
    searchPanel.classList.add("jf-search-panel--active");
    const track = searchPanel.querySelector(".jf-track");
    if (!track) return;
    track.innerHTML = "";
    if (!items?.length) { track.innerHTML = `<div class="jf-empty">No results found</div>`; updateSlider(searchPanel); return; }
    items.forEach((item, i) => track.appendChild(buildCardElement(item, item.Type, i)));
    requestAnimationFrame(() => requestAnimationFrame(() => {
      track.querySelectorAll(".jf-card").forEach(c => { c.style.opacity = "1"; c.style.transform = "translateY(0)"; });
      bindSlider(searchPanel); updateSlider(searchPanel);
    }));
  }

  function showSearchStatus(shell, message) {
    const searchPanel = shell.querySelector(".jf-search-panel");
    if (!searchPanel) return;
    searchPanel.classList.add("jf-search-panel--active");
    shell.querySelectorAll(".jf-panel").forEach(p => p.classList.remove("jf-panel--active"));
    const track = searchPanel.querySelector(".jf-track");
    if (track) track.innerHTML = `<div class="jf-search-status"><svg class="jf-dl-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>${escapeHtml(message)}</div>`;
  }

  function clearSearch(shell, input) {
    input.value = "";
    input.classList.remove("has-value", "is-open");
    _lastSearchQuery = "";
    const activeKey = shell.querySelector(".jf-tab--active")?.dataset.tab || getSections()[0].key;
    shell.querySelector(".jf-search-panel")?.classList.remove("jf-search-panel--active");
    shell.querySelectorAll(".jf-panel").forEach(p => p.classList.toggle("jf-panel--active", p.dataset.panel === activeKey));
    requestAnimationFrame(() => { const p = shell.querySelector(`.jf-panel[data-panel="${activeKey}"]`); bindSlider(p); updateSlider(p); });
  }

  function bindSearch(shell) {
    const input = shell.querySelector(".jf-search-input");
    const clearBtn = shell.querySelector(".jf-search-clear");
    if (!input) return;

    input.addEventListener("focus", () => input.classList.add("is-open"));
    input.addEventListener("blur", () => { if (!input.value) input.classList.remove("is-open"); });

    input.addEventListener("input", () => {
      const query = input.value.trim();
      input.classList.toggle("has-value", query.length > 0);
      if (!query) {
        if (_searchDebounce) clearTimeout(_searchDebounce);
        _lastSearchQuery = "";
        const activeKey = shell.querySelector(".jf-tab--active")?.dataset.tab || getSections()[0].key;
        shell.querySelector(".jf-search-panel")?.classList.remove("jf-search-panel--active");
        shell.querySelectorAll(".jf-panel").forEach(p => p.classList.toggle("jf-panel--active", p.dataset.panel === activeKey));
        requestAnimationFrame(() => {
          const p = shell.querySelector(`.jf-panel[data-panel="${activeKey}"]`);
          bindSlider(p); updateSlider(p);
        });
        return;
      }
      if (_searchDebounce) clearTimeout(_searchDebounce);
      _searchDebounce = setTimeout(async () => {
        if (query === _lastSearchQuery) return;
        _lastSearchQuery = query;
        showSearchStatus(shell, `Searching for "${query}"…`);
        try {
          const items = await fetchSearchResults(query);
          if (input.value.trim() === query) showSearchResults(shell, items);
        } catch (err) {
          console.error("[Homepage Jellyfin] Search failed:", err);
          if (input.value.trim() === query) {
            const t = shell.querySelector(".jf-search-panel .jf-track");
            if (t) t.innerHTML = `<div class="jf-empty">Search failed — try again</div>`;
          }
        }
      }, 380);
    });

    input.addEventListener("keydown", e => { if (e.key === "Escape") { clearSearch(shell, input); input.blur(); } });
    clearBtn?.addEventListener("click", () => { clearSearch(shell, input); input.focus(); });
  }

  // ── Shell builder ─────────────────────────────────────────────────────────
  function buildShell() {
    const shell = document.createElement("div");
    shell.className = "jf-shelf";

    const header = document.createElement("div");
    header.className = "jf-header";

    const headerTop = document.createElement("div");
    headerTop.className = "jf-header-top";

    const logoTitle = document.createElement("div");
    logoTitle.className = "jf-logo-title";
    logoTitle.innerHTML = `
      <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/webp/jellyfin.webp" alt="Jellyfin" class="jf-icon">
      <span class="jf-title">Jellyfin</span>`;
    headerTop.appendChild(logoTitle);

    const serverSwitch = document.createElement("div");
    serverSwitch.className = "jf-server-switch";
    serverSwitch.innerHTML = JF_CONFIG.servers.map((srv, i) =>
      `<button class="jf-server-btn${i === _activeServerIdx ? " jf-server-btn--active" : ""}"
             data-server="${i}" type="button" title="Switch to ${escapeHtml(srv.label)}">
       ${escapeHtml(srv.label)}
     </button>`
    ).join("");

    const openBtn = document.createElement("a");
    openBtn.className = "jf-open-btn";
    openBtn.href = getServer().baseUrl;
    openBtn.target = "_blank";
    openBtn.rel = "noopener noreferrer";
    openBtn.title = "Open Jellyfin";
    openBtn.setAttribute("aria-label", "Open Jellyfin in new tab");
    openBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>Open`;

    const headerTools = document.createElement("div");
    headerTools.className = "jf-header-tools";
    headerTools.appendChild(serverSwitch);
    headerTools.appendChild(openBtn);
    headerTop.appendChild(headerTools);
    header.appendChild(headerTop);

    const searchWrap = document.createElement("div");
    searchWrap.className = "jf-search-wrap";
    searchWrap.innerHTML = `
    <span class="jf-search-icon" aria-hidden="true">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
    </span>
    <input class="jf-search-input" type="search" placeholder="Search…" autocomplete="off" autocorrect="off" spellcheck="false" aria-label="Search all media"/>
    <button class="jf-search-clear" type="button" aria-label="Clear search">✕</button>`;
    header.appendChild(searchWrap);

    const controls = document.createElement("div");
    controls.className = "jf-controls";
    const tabs = document.createElement("div");
    tabs.className = "jf-tabs";
    tabs.setAttribute("role", "tablist");
    controls.appendChild(tabs);

    const panels = document.createElement("div");
    panels.className = "jf-panels";

    getSections().forEach((section, i) => {
      const tab = document.createElement("button");
      tab.className = `jf-tab${i === 0 ? " jf-tab--active" : ""}`;
      tab.type = "button";
      tab.textContent = section.title;
      tab.dataset.tab = section.key;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(i === 0));
      tab.addEventListener("click", () => activateTab(shell, section.key));
      tabs.appendChild(tab);

      const panel = document.createElement("div");
      panel.className = `jf-panel${i === 0 ? " jf-panel--active" : ""}`;
      panel.dataset.panel = section.key;
      const track = document.createElement("div");
      track.className = "jf-track";
      buildSkeletonCards(8, section.itemTypes === "MusicAlbum").forEach(c => track.appendChild(c));
      panel.appendChild(track);
      panel.insertAdjacentHTML("beforeend", buildSliderMarkup());
      panels.appendChild(panel);
    });

    const searchPanel = document.createElement("div");
    searchPanel.className = "jf-search-panel";
    const searchTrack = document.createElement("div");
    searchTrack.className = "jf-track";
    searchPanel.appendChild(searchTrack);
    searchPanel.insertAdjacentHTML("beforeend", buildSliderMarkup());
    panels.appendChild(searchPanel);

    shell.appendChild(header);
    shell.appendChild(controls);
    shell.appendChild(panels);

    requestAnimationFrame(() => {
      shell.querySelectorAll(".jf-panel").forEach(bindSlider);
      bindSearch(shell);
      shell.querySelectorAll(".jf-server-btn").forEach(btn => {
        btn.addEventListener("click", () => switchServer(parseInt(btn.dataset.server), shell));
      });
    });

    return shell;
  }

  function populatePanel(shell, sectionKey, items, itemType) {
    const panel = shell.querySelector(`.jf-panel[data-panel="${sectionKey}"]`);
    if (!panel) return;
    const oldTrack = panel.querySelector(".jf-track");
    if (!oldTrack) return;
    const newTrack = document.createElement("div");
    newTrack.className = "jf-track";
    if (!items?.length) newTrack.innerHTML = `<div class="jf-empty">No recent items</div>`;
    else items.forEach((item, i) => newTrack.appendChild(buildCardElement(item, itemType, i)));
    oldTrack.replaceWith(newTrack);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      newTrack.querySelectorAll(".jf-card").forEach(c => { c.style.opacity = "1"; c.style.transform = "translateY(0)"; });
      bindSlider(panel); updateSlider(panel);
    }));
  }

  function buildErrorMarkup(message) {
    return `<div class="jf-error"><div class="jf-error__title">Jellyfin unavailable</div><div class="jf-error__msg">${escapeHtml(message)}</div></div>`;
  }

  document.addEventListener("keydown", e => { if (e.key === "Escape" && _activePopup) closePopup(); });

  async function renderJellyfinModule() {
    if (_rendering) { log("Render already in progress."); return; }
    _rendering = true;
    try {
      const group = findGroupContainer();
      if (!group) return;
      const host = ensureHost(group);
      let shell = host.querySelector(".jf-shelf");
      if (!shell) { shell = buildShell(); host.innerHTML = ""; host.appendChild(shell); }
      const results = await Promise.all(getSections().map(async section => {
        try { return { section, items: await fetchRecentSection(section), ok: true }; }
        catch (err) { console.error(`[Homepage Jellyfin] Section "${section.key}" failed:`, err); return { section, items: [], ok: false }; }
      }));
      results.forEach(({ section, items }) => populatePanel(shell, section.key, items, section.itemTypes));
    } catch (err) {
      console.error("[Homepage Jellyfin] Render failed:", err);
      const host = findGroupContainer()?.querySelector(".jellyfin-host");
      if (host) host.innerHTML = buildErrorMarkup("Browser blocked the Jellyfin request or the server returned an error.");
    } finally { _rendering = false; }
  }

  function init() {
    const start = () => {
      setTimeout(renderJellyfinModule, 1200);
      setInterval(() => { if (!document.hidden) renderJellyfinModule(); }, JF_CONFIG.pollMs);
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
    else start();
    const observer = new MutationObserver(() => { if (!_rendering && !document.querySelector(".jellyfin-host .jf-shelf")) setTimeout(renderJellyfinModule, 400); });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  init();
})();