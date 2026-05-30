/* =====================================================
JELLYFIN SLIDER
===================================================== */
(function () {
  const JF_CONFIG = {
    servers: [
      {
        label: "JMG",
        baseUrl: "http://YOUR_LOCAL_IP:PORT",
        fallbackUrl: "https://YOUR_TUNNEL_URL", // or null if not using a tunnel
        activeUrl: null,
        apiKey: "YOUR_API_KEY_HERE",
        userId: "YOUR_USER_ID_HERE", // NOT your Jellyfin Username. Use your USER ID. Can be located in the Dev tools F12 under Networking and depending on your Jellyfin version, can be found in the top search bar.
        sections: [
          { key: "movies", title: "Movies", itemTypes: "Movie", limit: 15, parentId: "YOUR_PARENT_ID", fields: "ProductionYear,ImageTags,BackdropImageTags,Overview,Genres,RunTimeTicks,OfficialRating" },
          { key: "tvShows", title: "TV", itemTypes: "Series", limit: 15, parentId: "YOUR_PARENT_ID", fields: "ProductionYear,ImageTags,BackdropImageTags,Overview,Genres,RunTimeTicks,OfficialRating" },
          { key: "music", title: "Music", itemTypes: "MusicAlbum", limit: 15, parentId: "YOUR_PARENT_ID", fields: "AlbumArtist,Artists,ImageTags,AlbumPrimaryImageTag,ProductionYear,Overview,Genres" },
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
    const safeUrl = String(url)
      .replace(/^http:\/\//i, "https://")
      .replace("https://YOUR_LOCAL_IP:PORT", srv.baseUrl)
      .replace("http://YOUR_LOCAL_IP:PORT", srv.baseUrl);
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
    const base = _activeBaseUrls[_activeServerIdx] || getServer().baseUrl;
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

  function renderOriginalActions(popup, item) {
    const srv = getServer();
    const itemType = popup.__jfItemType;
    const actionsEl = popup.querySelector(".jf-popup__actions");
    if (!actionsEl) return;
    const isSeries = itemType === "Series";
    const isMusic = itemType === "MusicAlbum";

    const detailsHref = `${srv.baseUrl}/web/index.html#!/details?id=${encodeURIComponent(item.Id)}`;
    const playHref = `${srv.baseUrl}/web/index.html#!/details?id=${encodeURIComponent(item.Id)}`;

    actionsEl.innerHTML = `
    ${!isMusic ? `<a class="jf-popup__play-btn" href="${escapeHtml(playHref)}" target="_blank" rel="noopener noreferrer">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
      Play</a>` : ""}
    ${isSeries ? `<button class="jf-popup__download-btn" type="button">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Download Episodes</button>`
        : !isMusic ? `<button class="jf-popup__download-btn" type="button">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Download</button>` : ""}
    <a class="jf-popup__details-btn" href="${escapeHtml(detailsHref)}" target="_blank" rel="noopener noreferrer">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>View Details in Jellyfin</a>`;

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

  function positionPopup(popup, anchorEl) {
    const W = 260, H = 380, M = 12;
    const a = anchorEl.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = a.left + a.width / 2 - W / 2;
    let top = a.bottom + M;
    if (top + H > vh - M) top = a.top - H - M;
    popup.style.left = `${clamp(left, M, vw - W - M)}px`;
    popup.style.top = `${clamp(top, M, vh - H - M)}px`;
    popup.style.width = `${W}px`;
  }

  function openPopup(item, itemType, anchorEl) {
    closePopup();
    const isMusic = itemType === "MusicAlbum";
    const isSeries = itemType === "Series";
    const title = item?.Name || "Untitled";
    const year = item?.ProductionYear ? String(item.ProductionYear) : null;
    const rating = item?.OfficialRating || null;
    const runtime = formatRuntime(item?.RunTimeTicks);
    const overview = item?.Overview || null;
    const genres = (item?.Genres || []).slice(0, 3).join(" · ") || null;
    const artist = isMusic ? (item?.AlbumArtist || item?.Artists?.[0] || null) : null;
    const imageUrl = buildImageUrl(item);
    const backdropUrl = buildBackdropUrl(item);
    let typeLabel = "Movie";
    if (isSeries) typeLabel = "TV Series";
    if (isMusic) typeLabel = "Album";
    const subtitle = [year, rating, runtime].filter(Boolean).join(" · ");

    const backdrop = document.createElement("div");
    backdrop.className = "jf-popup-backdrop";
    backdrop.addEventListener("click", closePopup);
    document.body.appendChild(backdrop);
    _activeBackdrop = backdrop;

    const popup = document.createElement("div");
    popup.className = "jf-popup";
    popup.__jfItemType = itemType;
    popup.addEventListener("click", e => e.stopPropagation());
    popup.innerHTML = `
      ${backdropUrl ? `<img class="jf-popup__backdrop-img" src="${escapeHtml(backdropUrl)}" alt="" aria-hidden="true"/>` : ""}
      <div class="jf-popup__body">
        <div class="jf-popup__poster-row">
          ${imageUrl
        ? `<img class="${isMusic ? "jf-popup__poster--square" : "jf-popup__poster"}" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(title)}"/>`
        : `<div class="jf-popup__poster-placeholder">${escapeHtml(title.charAt(0))}</div>`}
          <div class="jf-popup__info">
            <div class="jf-popup__title">${escapeHtml(title)}</div>
            ${subtitle ? `<div class="jf-popup__subtitle">${escapeHtml(subtitle)}</div>` : ""}
            ${artist ? `<div class="jf-popup__subtitle">${escapeHtml(artist)}</div>` : ""}
            ${genres ? `<div class="jf-popup__subtitle" style="margin-top:2px;font-size:0.62rem;opacity:0.7">${escapeHtml(genres)}</div>` : ""}
            <div class="jf-popup__type-badge">
              <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10"/></svg>${escapeHtml(typeLabel)}
            </div>
          </div>
        </div>
        ${overview ? `<div class="jf-popup__divider"></div><div class="jf-popup__overview">${escapeHtml(overview)}</div>` : ""}
        <div class="jf-popup__divider"></div>
        <div class="jf-popup__actions"></div>
      </div>`;
    renderOriginalActions(popup, item);
    document.body.appendChild(popup);
    _activePopup = popup;
    positionPopup(popup, anchorEl);

    const reposition = () => { if (_activePopup === popup) positionPopup(popup, anchorEl); };
    window.addEventListener("resize", reposition, { passive: true });
    window.addEventListener("scroll", reposition, { passive: true, capture: true });
    backdrop.addEventListener("click", () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, { capture: true });
    }, { once: true });
  }

  // ── Cards ─────────────────────────────────────────────────────────────────
  function buildCardElement(item, itemType, index) {
    const isMusic = itemType === "MusicAlbum";
    const title = escapeHtml(item?.Name || "Untitled");
    let subtitle = "Recently added";
    if (isMusic) subtitle = escapeHtml(item?.AlbumArtist || item?.Artists?.[0] || "Album");
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
    let host = group.querySelector(".jellyfin-host");
    if (host) return host;
    const existingList = group.querySelector("ul.services-list, ul");
    if (existingList) existingList.style.display = "none";
    host = document.createElement("div");
    host.className = "jellyfin-host";
    group.appendChild(host);
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

    const tabsRow = document.createElement("div");
    tabsRow.className = "jf-tabs-row";

    const logoTitle = document.createElement("div");
    logoTitle.className = "jf-logo-title";
    logoTitle.innerHTML = `
      <img src="https://cdn.jsdelivr.net/gh/selfhst/icons/webp/jellyswarrm.webp" alt="Jellyfin" class="jf-icon">
      <span class="jf-title">Jellyfin</span>`;
    tabsRow.appendChild(logoTitle);

    const tabs = document.createElement("div");
    tabs.className = "jf-tabs";
    tabs.setAttribute("role", "tablist");

    const serverSwitch = document.createElement("div");
    serverSwitch.className = "jf-server-switch";
    serverSwitch.innerHTML = JF_CONFIG.servers.map((srv, i) =>
      `<button class="jf-server-btn${i === _activeServerIdx ? " jf-server-btn--active" : ""}"
             data-server="${i}" type="button" title="Switch to ${escapeHtml(srv.label)}">
       ${escapeHtml(srv.label)}
     </button>`
    ).join("");

    const searchWrap = document.createElement("div");
    searchWrap.className = "jf-search-wrap";
    searchWrap.innerHTML = `
    <input class="jf-search-input" type="search" placeholder="Search…" autocomplete="off" autocorrect="off" spellcheck="false" aria-label="Search all media"/>
    <span class="jf-search-icon" aria-hidden="true">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
    </span>
    <button class="jf-search-clear" type="button" aria-label="Clear search">✕</button>`;

    tabsRow.appendChild(tabs);
    tabsRow.appendChild(serverSwitch);
    tabsRow.appendChild(searchWrap);

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

    shell.appendChild(tabsRow);
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