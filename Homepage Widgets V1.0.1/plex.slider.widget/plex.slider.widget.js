/* =====================================================
   PLEX SLIDER WIDGET
   Recent media rails + search + details popup
   Group name: PLEX-SLIDER
===================================================== */
(function () {
  const PLS_CONFIG = {
    groupName: "PLEX-SLIDER",
    baseUrl: "http://10.128.1.64:32400",
    fallbackUrl: null, // or null
    activeUrl: null,
    token: "mRovD3tPzVjcHYxTLWoi",
    href: "http://10.128.1.64:32400/web",
    fallbackHref: null,
    limit: 18,
    pollMs: 10 * 60 * 1000,
    debug: false
  };

  let _host = null;
  let _rendering = false;
  let _sections = [];
  let _itemsBySection = {};
  let _activeSection = "__all__";
  let _searchQuery = "";
  let _searchResults = [];
  let _searchDebounce = null;
  let _activePopup = null;
  let _activeBackdrop = null;

  function log(...a) { if (PLS_CONFIG.debug) console.log("[PlexSlider]", ...a); }
  function esc(s = "") {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
  function normText(v) { return (v || "").replace(/\s+/g, " ").trim(); }

  function getTargets() {
    const targets = [];
    if (PLS_CONFIG.activeUrl) targets.push(PLS_CONFIG.activeUrl);
    if (PLS_CONFIG.baseUrl && PLS_CONFIG.baseUrl !== PLS_CONFIG.activeUrl) targets.push(PLS_CONFIG.baseUrl);
    if (PLS_CONFIG.fallbackUrl && PLS_CONFIG.fallbackUrl !== PLS_CONFIG.activeUrl) targets.push(PLS_CONFIG.fallbackUrl);
    return targets;
  }

  function getBaseUrl() {
    return PLS_CONFIG.activeUrl || PLS_CONFIG.baseUrl || PLS_CONFIG.fallbackUrl || "";
  }

  function getHref() {
    if (PLS_CONFIG.activeUrl === PLS_CONFIG.fallbackUrl && PLS_CONFIG.fallbackHref) return PLS_CONFIG.fallbackHref;
    return PLS_CONFIG.href || PLS_CONFIG.fallbackHref || "#";
  }

  function tokenPath(path) {
    const joiner = path.includes("?") ? "&" : "?";
    return `${path}${joiner}X-Plex-Token=${encodeURIComponent(PLS_CONFIG.token)}`;
  }

  async function plexFetch(path, timeout = 10_000) {
    const targets = getTargets();
    let lastErr = null;

    for (const baseUrl of targets) {
      try {
        const res = await fetch(`${baseUrl}${tokenPath(path)}`, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(timeout)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        PLS_CONFIG.activeUrl = baseUrl;
        const ct = res.headers.get("content-type") || "";
        return ct.includes("json") ? res.json() : null;
      } catch (err) {
        lastErr = err;
      }
    }

    throw lastErr || new Error(`Plex request failed for ${path}`);
  }

  function directImageUrl(path) {
    if (!path) return "";
    return `${getBaseUrl()}${tokenPath(path)}`;
  }

  function imageUrl(path, w = 320, h = 480) {
    if (!path) return "";
    const base = getBaseUrl();
    const directPath = tokenPath(path);
    return `${base}/photo/:/transcode?width=${w}&height=${h}&minSize=1&upscale=1&url=${encodeURIComponent(directPath)}&X-Plex-Token=${encodeURIComponent(PLS_CONFIG.token)}`;
  }

  function rawImageUrl(path) {
    if (!path) return "";
    return directImageUrl(path);
  }

  function findGroupContainer() {
    const hd = Array.from(document.querySelectorAll("h2,h3,.group-title,.service-group-name"))
      .find(el => normText(el.textContent) === PLS_CONFIG.groupName);
    if (!hd) return null;
    return hd.closest("section") || hd.closest("div[class*='group']") ||
      hd.parentElement?.parentElement || hd.parentElement;
  }

  function ensureHost(group) {
    let row = group.querySelector(".hp-widget-row, .plex-slider-flex-row");
    if (!row) {
      const list = group.querySelector("ul.services-list, ul");
      if (list) list.style.display = "none";
      row = document.createElement("div");
      row.className = "hp-widget-row plex-slider-flex-row";
      group.appendChild(row);
    } else {
      row.classList.add("hp-widget-row", "plex-slider-flex-row");
    }

    let host = row.querySelector(".plex-slider-host");
    if (host) return host;
    host = document.createElement("div");
    host.className = "plex-slider-host";
    row.appendChild(host);
    return host;
  }

  function sectionIcon(type) {
    if (type === "movie") return "🎬";
    if (type === "show") return "📺";
    if (type === "artist") return "🎵";
    if (type === "photo") return "🖼";
    return "📁";
  }

  function cardShape(item) {
    const type = String(item?.type || "").toLowerCase();
    const sectionType = String(item?.sectionType || "").toLowerCase();
    if (type === "artist" || type === "album" || sectionType === "artist") return "square";
    return "poster";
  }

  function normalizeItem(item = {}, section = null) {
    const type = item.type || section?.type || "media";
    const title = type === "episode"
      ? `${item.grandparentTitle || "Unknown"} · ${item.title || ""}`.replace(/\s+·\s*$/, "")
      : item.title || "Untitled";
    const subtitle = type === "episode"
      ? [item.parentTitle, item.year].filter(Boolean).join(" · ")
      : [section?.title || type, item.year].filter(Boolean).join(" · ");
    const thumb = type === "episode"
      ? item.grandparentThumb || item.parentThumb || item.thumb || ""
      : type === "season"
        ? item.parentThumb || item.grandparentThumb || item.thumb || ""
        : item.thumb || item.grandparentThumb || item.parentThumb || "";

    return {
      key: item.ratingKey || item.key || title,
      ratingKey: item.ratingKey || "",
      type,
      title,
      subtitle,
      year: item.year || "",
      summary: item.summary || "",
      thumb,
      art: item.art || item.grandparentArt || "",
      duration: Number(item.duration || 0),
      sectionTitle: section?.title || "",
      sectionType: section?.type || "",
      addedAt: Number(item.addedAt || 0)
    };
  }

  function formatRuntime(ms) {
    if (!ms) return "";
    const m = Math.round(Number(ms) / 60000);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return rm ? `${h}h ${rm}m` : `${h}h`;
  }

  async function fetchSections() {
    const data = await plexFetch("/library/sections");
    const dirs = data?.MediaContainer?.Directory || [];
    return (Array.isArray(dirs) ? dirs : [dirs]).filter(Boolean).map(s => ({
      key: String(s.key || ""),
      title: s.title || "Library",
      type: s.type || ""
    })).filter(s => s.key);
  }

  async function fetchSectionItems(section) {
    const path = section.type === "show"
      ? `/library/sections/${section.key}/all?type=2&sort=addedAt:desc&X-Plex-Container-Start=0&X-Plex-Container-Size=${PLS_CONFIG.limit}`
      : `/library/sections/${section.key}/recentlyAdded?X-Plex-Container-Start=0&X-Plex-Container-Size=${PLS_CONFIG.limit}`;
    const data = await plexFetch(path);
    const meta = data?.MediaContainer?.Metadata || [];
    return (Array.isArray(meta) ? meta : [meta]).filter(Boolean).map(i => normalizeItem(i, section));
  }

  async function fetchSearch(query) {
    if (!query.trim()) return [];
    const data = await plexFetch(`/hubs/search?query=${encodeURIComponent(query)}&limit=40`);
    const hubs = data?.MediaContainer?.Hub || [];
    const items = [];
    (Array.isArray(hubs) ? hubs : [hubs]).filter(Boolean).forEach(hub => {
      const meta = hub.Metadata || [];
      (Array.isArray(meta) ? meta : [meta]).filter(Boolean).forEach(item => {
        items.push(normalizeItem(item, { title: hub.title || "", type: item.type || "" }));
      });
    });
    const seen = new Set();
    return items.filter(item => {
      const key = item.ratingKey || item.key;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function allItems() {
    return Object.values(_itemsBySection).flat()
      .sort((a, b) => Number(b.addedAt || 0) - Number(a.addedAt || 0))
      .slice(0, PLS_CONFIG.limit);
  }

  function activeItems() {
    if (_searchQuery.trim()) return _searchResults;
    if (_activeSection === "__all__") return allItems();
    return _itemsBySection[_activeSection] || [];
  }

  function buildTabs() {
    const tabs = [
      { key: "__all__", title: "Recent", type: "mixed" },
      ..._sections
    ];
    return tabs.map(tab => `
      <button class="pls-tab${_activeSection === tab.key && !_searchQuery ? " pls-tab--active" : ""}" data-section="${esc(tab.key)}">
        <span>${sectionIcon(tab.type)}</span>${esc(tab.title)}
      </button>`).join("");
  }

  function buildCard(item) {
    const poster = imageUrl(item.thumb, 320, 480);
    const directPoster = directImageUrl(item.thumb);
    const fallback = sectionIcon(item.type);
    const shape = cardShape(item);
    return `
      <button class="pls-card pls-card--${esc(shape)}" data-key="${esc(item.key)}" title="${esc(item.title)}">
        <div class="pls-poster">
          ${poster ? `<img src="${esc(poster)}" data-fallback-src="${esc(directPoster)}" alt="" loading="lazy" decoding="async" onerror="if(this.dataset.fallbackSrc&&!this.dataset.usedFallback){this.dataset.usedFallback='1';this.src=this.dataset.fallbackSrc;}else{this.closest('.pls-poster').innerHTML='<span>${fallback}</span>';}">` : `<span>${fallback}</span>`}
        </div>
        <div class="pls-card-title">${esc(item.title)}</div>
        <div class="pls-card-sub">${esc(item.subtitle || item.type)}</div>
      </button>`;
  }

  function buildRail() {
    const items = activeItems();
    if (!items.length) {
      return `<div class="pls-empty">${_searchQuery ? "No Plex results" : "No recent media found"}</div>`;
    }
    return `
      <div class="pls-slider-wrap">
        <div class="pls-slider">${items.map(buildCard).join("")}</div>
        <div class="pls-slider-control">
          <button class="pls-slider__btn pls-slider__btn--left" type="button" aria-label="Scroll left">‹</button>
          <div class="pls-slider__bar">
            <div class="pls-slider__rail">
              <div class="pls-slider__fill"></div>
              <div class="pls-slider__thumb" tabindex="0" role="slider" aria-label="Plex slider"></div>
            </div>
          </div>
          <button class="pls-slider__btn pls-slider__btn--right" type="button" aria-label="Scroll right">›</button>
        </div>
      </div>`;
  }

  function updateSlider(host = _host) {
    if (!host) return;
    const track = host.querySelector(".pls-slider");
    const bar = host.querySelector(".pls-slider__bar");
    const fill = host.querySelector(".pls-slider__fill");
    const thumb = host.querySelector(".pls-slider__thumb");
    const leftBtn = host.querySelector(".pls-slider__btn--left");
    const rightBtn = host.querySelector(".pls-slider__btn--right");
    if (!track || !bar || !fill || !thumb) return;

    const maxScroll = Math.max(0, track.scrollWidth - track.clientWidth);
    const ratio = maxScroll > 0 ? track.scrollLeft / maxScroll : 0;
    const disabled = maxScroll <= 2;
    bar.classList.toggle("is-disabled", disabled);
    fill.style.width = `${ratio * 100}%`;
    thumb.style.left = `calc(${ratio * 100}% - ${ratio * 18}px)`;
    thumb.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
    if (leftBtn) leftBtn.disabled = disabled || track.scrollLeft <= 2;
    if (rightBtn) rightBtn.disabled = disabled || track.scrollLeft >= maxScroll - 2;
  }

  function bindSlider(host = _host) {
    if (!host || host.dataset.plexSliderBound === "1") return;
    host.dataset.plexSliderBound = "1";

    const getTrack = () => host.querySelector(".pls-slider");
    const getRail = () => host.querySelector(".pls-slider__rail");
    let targetScrollLeft = 0;
    let rafId = null;

    const stopAnim = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = null;
    };

    const animateToTarget = () => {
      const track = getTrack();
      if (!track) {
        rafId = null;
        return;
      }

      const diff = targetScrollLeft - track.scrollLeft;
      if (Math.abs(diff) < 0.5) {
        track.scrollLeft = targetScrollLeft;
        updateSlider(host);
        rafId = null;
        return;
      }

      track.scrollLeft += diff * 0.18;
      updateSlider(host);
      rafId = requestAnimationFrame(animateToTarget);
    };

    const setTarget = (left, immediate = false) => {
      const track = getTrack();
      if (!track) return;
      const maxScroll = Math.max(0, track.scrollWidth - track.clientWidth);
      targetScrollLeft = Math.min(Math.max(left, 0), maxScroll);
      if (immediate) {
        stopAnim();
        track.scrollLeft = targetScrollLeft;
        updateSlider(host);
        return;
      }
      if (!rafId) rafId = requestAnimationFrame(animateToTarget);
    };

    const scrollByPage = (dir) => {
      const track = getTrack();
      if (!track) return;
      setTarget(track.scrollLeft + dir * Math.max(280, track.clientWidth * 0.82));
    };

    host.addEventListener("scroll", (e) => {
      if (e.target?.classList?.contains("pls-slider")) updateSlider(host);
    }, { passive: true, capture: true });

    host.addEventListener("click", (e) => {
      const left = e.target.closest?.(".pls-slider__btn--left");
      const right = e.target.closest?.(".pls-slider__btn--right");
      if (left) scrollByPage(-1);
      if (right) scrollByPage(1);

      const rail = e.target.closest?.(".pls-slider__rail");
      const track = getTrack();
      if (rail && track) {
        const rect = rail.getBoundingClientRect();
        const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
        setTarget(ratio * Math.max(0, track.scrollWidth - track.clientWidth));
      }
    });

    let dragging = false;
    const dragTo = (clientX) => {
      const rail = getRail();
      const track = getTrack();
      if (!rail || !track) return;
      const rect = rail.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      track.scrollLeft = ratio * Math.max(0, track.scrollWidth - track.clientWidth);
      updateSlider(host);
    };

    host.addEventListener("pointerdown", (e) => {
      if (!e.target.closest?.(".pls-slider__thumb")) return;
      stopAnim();
      dragging = true;
      host.classList.add("pls-slider--dragging");
      e.preventDefault();
    });
    window.addEventListener("pointermove", (e) => {
      if (dragging) dragTo(e.clientX);
    });
    window.addEventListener("pointerup", () => {
      if (!dragging) return;
      dragging = false;
      host.classList.remove("pls-slider--dragging");
    });
  }

  function buildShell() {
    return `
      <div class="pls-shelf">
        <div class="pls-head">
          <div class="pls-logo-title">
            <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/webp/plex.webp" alt="Plex" class="pls-icon">
            <div>
              <div class="pls-title">Plex Slider</div>
              <div class="pls-subtitle">${_searchQuery ? "Search results" : "Recently added"}</div>
            </div>
          </div>
          <a class="pls-open-btn" href="${esc(getHref())}" target="_blank" rel="noopener noreferrer">Open</a>
        </div>
        <div class="pls-tabs-row">
          <div class="pls-tabs">${buildTabs()}</div>
          <div class="pls-search-wrap">
            <input class="pls-search-input${_searchQuery ? " is-open" : ""}" type="search" value="${esc(_searchQuery)}" placeholder="Search Plex">
            <span class="pls-search-icon">⌕</span>
            <button class="pls-search-clear${_searchQuery ? " is-visible" : ""}" aria-label="Clear search">×</button>
          </div>
        </div>
        ${buildRail()}
      </div>`;
  }

  function closePopup() {
    if (_activePopup) _activePopup.remove();
    if (_activeBackdrop) _activeBackdrop.remove();
    _activePopup = null;
    _activeBackdrop = null;
    document.removeEventListener("keydown", onPopupKeydown);
  }

  function onPopupKeydown(e) {
    if (e.key === "Escape") closePopup();
  }

  function openPopup(item) {
    closePopup();
    const poster = imageUrl(item.thumb, 420, 630);
    const directPoster = directImageUrl(item.thumb);
    const backdrop = rawImageUrl(item.art);
    const detailsHref = `${getHref()}#!/server/${encodeURIComponent(getBaseUrl())}/details?key=${encodeURIComponent(`/library/metadata/${item.ratingKey}`)}`;
    const shape = cardShape(item);
    _activeBackdrop = document.createElement("div");
    _activeBackdrop.className = "pls-popup-backdrop";
    _activeBackdrop.addEventListener("click", closePopup);
    _activePopup = document.createElement("div");
    _activePopup.className = "pls-popup";
    _activePopup.innerHTML = `
      <button class="pls-popup-close" aria-label="Close">×</button>
      ${backdrop ? `<div class="pls-popup-bg" style="background-image:url('${esc(backdrop)}')"></div>` : ""}
      <div class="pls-popup-body">
        <div class="pls-popup-poster pls-popup-poster--${esc(shape)}">
          ${poster ? `<img src="${esc(poster)}" data-fallback-src="${esc(directPoster)}" alt="" onerror="if(this.dataset.fallbackSrc&&!this.dataset.usedFallback){this.dataset.usedFallback='1';this.src=this.dataset.fallbackSrc;}else{this.closest('.pls-popup-poster').innerHTML='<span>${sectionIcon(item.type)}</span>';}">` : `<span>${sectionIcon(item.type)}</span>`}
        </div>
        <div class="pls-popup-info">
          <div class="pls-popup-kicker">${esc([item.sectionTitle, item.type, item.year].filter(Boolean).join(" · "))}</div>
          <div class="pls-popup-title">${esc(item.title)}</div>
          <div class="pls-popup-meta">${esc([formatRuntime(item.duration), item.subtitle].filter(Boolean).join(" · "))}</div>
          <div class="pls-popup-summary">${esc(item.summary || "No summary available.")}</div>
          <div class="pls-popup-actions">
            <a class="pls-popup-play" href="${esc(detailsHref)}" target="_blank" rel="noopener noreferrer">Open in Plex</a>
          </div>
        </div>
      </div>`;
    document.body.appendChild(_activeBackdrop);
    document.body.appendChild(_activePopup);
    _activePopup.querySelector(".pls-popup-close")?.addEventListener("click", closePopup);
    document.addEventListener("keydown", onPopupKeydown);
  }

  function findItem(key) {
    return [...allItems(), ...Object.values(_itemsBySection).flat(), ..._searchResults]
      .find(item => String(item.key) === String(key));
  }

  function bind(host) {
    host.querySelectorAll(".pls-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        _activeSection = btn.dataset.section || "__all__";
        _searchQuery = "";
        _searchResults = [];
        updateHost();
      });
    });

    const input = host.querySelector(".pls-search-input");
    if (input) {
      input.addEventListener("input", () => {
        _searchQuery = input.value;
        clearTimeout(_searchDebounce);
        _searchDebounce = setTimeout(async () => {
          try {
            _searchResults = await fetchSearch(_searchQuery);
          } catch (err) {
            console.warn("[PlexSlider] search failed:", err.message);
            _searchResults = [];
          }
          updateHost();
        }, 350);
      });
      input.addEventListener("focus", () => input.classList.add("is-open"));
    }

    host.querySelector(".pls-search-clear")?.addEventListener("click", () => {
      _searchQuery = "";
      _searchResults = [];
      updateHost();
    });

    host.querySelectorAll(".pls-card").forEach(card => {
      card.addEventListener("click", () => {
        const item = findItem(card.dataset.key);
        if (item) openPopup(item);
      });
    });

    bindSlider(host);
    requestAnimationFrame(() => updateSlider(host));
  }

  function updateHost() {
    if (!_host) return;
    _host.innerHTML = buildShell();
    bind(_host);
  }

  async function refresh() {
    if (_rendering) return;
    const group = findGroupContainer();
    if (!group) return;
    _host = ensureHost(group);
    _rendering = true;
    try {
      if (!PLS_CONFIG.token || PLS_CONFIG.token === "YOUR_PLEX_TOKEN") {
        _host.innerHTML = `<div class="pls-shelf"><div class="pls-empty">Set your Plex token in PLS_CONFIG.token</div></div>`;
        return;
      }
      if (!_host.querySelector(".pls-shelf")) {
        _host.innerHTML = `<div class="pls-shelf"><div class="pls-empty">Loading Plex media</div></div>`;
      }
      _sections = await fetchSections();
      const pairs = await Promise.all(_sections.map(async section => [section.key, await fetchSectionItems(section)]));
      _itemsBySection = Object.fromEntries(pairs);
      updateHost();
    } catch (err) {
      console.error("[PlexSlider]", err);
      if (_host) _host.innerHTML = `<div class="pls-shelf"><div class="pls-empty pls-empty--error">${esc(err.message || "Failed to load Plex")}</div></div>`;
    } finally {
      _rendering = false;
    }
  }

  function init() {
    const start = () => {
      setTimeout(refresh, 1700);
      setInterval(() => { if (!document.hidden) refresh(); }, PLS_CONFIG.pollMs);
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }
    new MutationObserver(() => {
      if (!_rendering && !document.querySelector(".plex-slider-host .pls-shelf")) {
        setTimeout(refresh, 500);
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  init();
})();
