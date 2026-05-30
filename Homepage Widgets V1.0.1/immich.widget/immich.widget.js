/* =====================================================
IMMICH PHOTO ALBUMS WIDGET
===================================================== */
(function () {
  const IMMICH_CONFIG = {
    baseUrl: "http://YOUR_LOCAL_IP:PORT",
    fallbackUrl: "https://YOUR_TUNNEL_URL", // or null if not using a tunnel
    activeUrl: null,
    apiKey: "YOUR_API_KEY_HERE",
    groupName: "IMMICH - LIBRARY",
    pollMs: 5 * 120 * 1000,
    coverSize: 300,
    debug: false
  };

  function log(...args) {
    if (IMMICH_CONFIG.debug) console.log("[Homepage Immich]", ...args);
  }

  function normalizeText(v) {
    return (v || "").replace(/\s+/g, " ").trim();
  }

  function escapeHtml(str = "") {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function immichHeaders() {
    return {
      "x-api-key": IMMICH_CONFIG.apiKey,
      "Accept": "application/json"
    };
  }

  function findGroupContainer() {
    const headings = Array.from(
      document.querySelectorAll("h2, h3, .group-title, .service-group-name")
    );
    const heading = headings.find(
      el => normalizeText(el.textContent) === IMMICH_CONFIG.groupName
    );
    if (!heading) { log("Group not found yet"); return null; }
    return (
      heading.closest("section") ||
      heading.closest("div[class*='group']") ||
      heading.parentElement?.parentElement ||
      heading.parentElement
    );
  }

  function ensureHost(group) {
    let host = group.querySelector(".immich-albums-host");
    if (host) return host;
    host = document.createElement("div");
    host.className = "immich-albums-host";
    group.appendChild(host);
    return host;
  }

  async function fetchAlbums() {
    const candidates = [];
    if (IMMICH_CONFIG.activeUrl) candidates.push(IMMICH_CONFIG.activeUrl);
    if (!candidates.includes(IMMICH_CONFIG.baseUrl)) candidates.push(IMMICH_CONFIG.baseUrl);
    if (IMMICH_CONFIG.fallbackUrl && !candidates.includes(IMMICH_CONFIG.fallbackUrl)) candidates.push(IMMICH_CONFIG.fallbackUrl);

    let lastErr = null;
    for (const base of candidates) {
      try {
        const res = await fetch(`${base}/api/albums`, {
          headers: immichHeaders(),
          signal: (() => { const c = new AbortController(); setTimeout(() => c.abort(), 8000); return c.signal; })()
        });
        if (!res.ok) throw new Error(`Immich API ${res.status}`);
        IMMICH_CONFIG.activeUrl = base;
        return res.json();
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error("All URLs failed for Immich");
  }

  function buildCoverUrl(album) {
    if (!album.albumThumbnailAssetId) return null;
    const base = IMMICH_CONFIG.activeUrl || IMMICH_CONFIG.fallbackUrl || IMMICH_CONFIG.baseUrl;
    return `${base}/api/assets/${album.albumThumbnailAssetId}/thumbnail?size=preview&apiKey=${IMMICH_CONFIG.apiKey}`;
  }

  async function loadCoverImages(host) {
    const imgs = host.querySelectorAll("img[data-cover-id]");
    await Promise.allSettled([...imgs].map(async img => {
      const assetId = img.dataset.coverId;
      const base = IMMICH_CONFIG.activeUrl || IMMICH_CONFIG.fallbackUrl || IMMICH_CONFIG.baseUrl;
      try {
        const res = await fetch(`${base}/api/assets/${assetId}/thumbnail?size=preview`, {
          headers: immichHeaders(),
          signal: (() => { const c = new AbortController(); setTimeout(() => c.abort(), 8000); return c.signal; })()
        });
        if (!res.ok) throw new Error(`${res.status}`);
        const blob = await res.blob();
        img.src = URL.createObjectURL(blob);
      } catch {
        img.closest(".immich-album-art").innerHTML = `
        <div class="immich-album-placeholder">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="3" y="3" width="18" height="18" rx="2"></rect>
            <circle cx="8.5" cy="8.5" r="1.5"></circle>
            <polyline points="21 15 16 10 5 21"></polyline>
          </svg>
        </div>`;
      }
    }));
  }

  function formatDate(dateStr) {
    if (!dateStr) return "";
    try {
      return new Date(dateStr).toLocaleDateString("en-US", {
        year: "numeric", month: "short", day: "numeric"
      });
    } catch (_) { return ""; }
  }

  function pluralize(n, word) {
    return `${n.toLocaleString()} ${word}${n !== 1 ? "s" : ""}`;
  }

  function buildAlbumCard(album, index) {
    const coverUrl = buildCoverUrl(album);
    const href = `${IMMICH_CONFIG.baseUrl}/albums/${escapeHtml(album.id)}`;
    const name = escapeHtml(album.albumName || "Untitled");
    const count = album.assetCount ?? 0;
    const date = formatDate(album.lastModifiedAssetTimestamp || album.updatedAt);
    const owner = escapeHtml(album.owner?.name || "");
    const shared = album.shared;

    return `
      <a class="immich-album-card"
         href="${href}"
         target="_blank"
         rel="noopener noreferrer"
         style="animation-delay: ${index * 45}ms"
         title="${name}">
        <div class="immich-album-art">
          ${coverUrl
        ? `<img src="${escapeHtml(buildCoverUrl(album))}" alt="${name}" loading="lazy" decoding="async" onerror="if(!this.dataset.retried){this.dataset.retried='1';this.src='${IMMICH_CONFIG.fallbackUrl}/api/assets/${escapeHtml(album.albumThumbnailAssetId)}/thumbnail?size=preview&apiKey=${IMMICH_CONFIG.apiKey}';}else{this.parentElement.innerHTML='<div class=\\'immich-album-placeholder\\'><svg width=\\'32\\' height=\\'32\\' viewBox=\\'0 0 24 24\\' fill=\\'none\\' stroke=\\'currentColor\\' stroke-width=\\'1.5\\'><rect x=\\'3\\' y=\\'3\\' width=\\'18\\' height=\\'18\\' rx=\\'2\\'></rect><circle cx=\\'8.5\\' cy=\\'8.5\\' r=\\'1.5\\'></circle><polyline points=\\'21 15 16 10 5 21\\'></polyline></svg></div>';}">`
        : `<div class="immich-album-placeholder">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <rect x="3" y="3" width="18" height="18" rx="2"></rect>
                  <circle cx="8.5" cy="8.5" r="1.5"></circle>
                  <polyline points="21 15 16 10 5 21"></polyline>
                </svg>
              </div>`
      }
          <div class="immich-album-overlay">
            <div class="immich-album-count">${pluralize(count, "photo")}</div>
            ${shared ? `<div class="immich-album-badge">Shared</div>` : ""}
          </div>
        </div>
        <div class="immich-album-meta">
          <div class="immich-album-name">${name}</div>
          ${date ? `<div class="immich-album-date">${date}</div>` : ""}
          ${owner ? `<div class="immich-album-owner">${owner}</div>` : ""}
        </div>
      </a>`;
  }

  function buildSkeleton(count = 8) {
    return Array.from({ length: count }, () => `
      <div class="immich-album-card immich-album-card--skeleton">
        <div class="immich-album-art immich-skeleton"></div>
        <div class="immich-album-meta">
          <div class="immich-skeleton immich-skeleton--title"></div>
          <div class="immich-skeleton immich-skeleton--sub"></div>
        </div>
      </div>`).join("");
  }

  function buildError(msg) {
    return `
      <div class="immich-error">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="12" y1="8" x2="12" y2="12"></line>
          <line x1="12" y1="16" x2="12.01" y2="16"></line>
        </svg>
        <div class="immich-error-title">Immich Unavailable</div>
        <div class="immich-error-msg">${escapeHtml(msg)}</div>
      </div>`;
  }

  function buildShell(albums) {
    const sorted = [...albums].sort((a, b) => {
      const da = new Date(b.updatedAt || 0);
      const db = new Date(a.updatedAt || 0);
      return da - db;
    });

    const totalPhotos = albums.reduce((n, a) => n + (a.assetCount ?? 0), 0);

    return `
      <div class="immich-shell">
        <div class="immich-header">
          <div class="immich-header-left">
            <img
              src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/webp/immich.webp"
              alt="Immich"
              class="immich-icon"
            />
          <div class="immich-title">Immich</div>
          </div>
          <div class="immich-header-stats">
            <span class="immich-stat-pill">${albums.length} albums</span>
            <span class="immich-stat-pill">${totalPhotos.toLocaleString()} photos</span>
            <a class="immich-open-btn" href="${IMMICH_CONFIG.baseUrl}" target="_blank" rel="noopener noreferrer">
              Open
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                <polyline points="15 3 21 3 21 9"></polyline>
                <line x1="10" y1="14" x2="21" y2="3"></line>
              </svg>
            </a>
          </div>
        </div>

        <div class="immich-filter-bar">
          <input
            class="immich-search"
            type="text"
            placeholder="Search albums…"
            id="immich-search-input"
            autocomplete="off"
          />
          <div class="immich-sort-tabs" id="immich-sort-tabs">
            <button class="immich-sort-tab immich-sort-tab--active" data-sort="recent">Recent</button>
            <button class="immich-sort-tab" data-sort="alpha">A–Z</button>
            <button class="immich-sort-tab" data-sort="count">Most photos</button>
            <button class="immich-sort-tab" data-sort="shared">Shared</button>
          </div>
        </div>

        <div class="immich-grid" id="immich-grid">
          ${sorted.map((album, i) => buildAlbumCard(album, i)).join("")}
        </div>

        <div class="immich-empty" id="immich-empty" style="display:none;">
          No albums match your search.
        </div>

        <div class="immich-footer">
          Updated ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true })}
        </div>
      </div>`;
  }

  function bindInteractions(host, albums) {
    const grid = host.querySelector("#immich-grid");
    const searchInput = host.querySelector("#immich-search-input");
    const sortTabs = host.querySelectorAll(".immich-sort-tab");
    const emptyMsg = host.querySelector("#immich-empty");

    if (!grid || !searchInput || !sortTabs.length) return;

    let currentSort = "recent";
    let currentQuery = "";

    function sortAlbums(list, mode) {
      const copy = [...list];
      if (mode === "alpha") return copy.sort((a, b) => (a.albumName || "").localeCompare(b.albumName || ""));
      if (mode === "count") return copy.sort((a, b) => (b.assetCount ?? 0) - (a.assetCount ?? 0));
      if (mode === "shared") return copy.filter(a => a.shared).concat(copy.filter(a => !a.shared));
      return copy.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
    }

    function filterAlbums(list, q) {
      if (!q) return list;
      const lower = q.toLowerCase();
      return list.filter(a => (a.albumName || "").toLowerCase().includes(lower));
    }

    function rerender() {
      const filtered = filterAlbums(sortAlbums(albums, currentSort), currentQuery);
      if (!filtered.length) {
        grid.style.display = "none";
        emptyMsg.style.display = "flex";
      } else {
        emptyMsg.style.display = "none";
        grid.style.display = "grid";
        grid.innerHTML = filtered.map((album, i) => buildAlbumCard(album, i)).join("");
        // Trigger animation — double-rAF for reliable reveal on mobile
        const revealFiltered = () => {
          grid.querySelectorAll(".immich-album-card").forEach(card => {
            card.style.opacity = "1";
            card.style.transform = "translateY(0)";
          });
        };
        requestAnimationFrame(() => requestAnimationFrame(revealFiltered));
        setTimeout(revealFiltered, 400);
      }
    }

    searchInput.addEventListener("input", e => {
      currentQuery = e.target.value.trim();
      rerender();
    });

    sortTabs.forEach(tab => {
      tab.addEventListener("click", () => {
        sortTabs.forEach(t => t.classList.remove("immich-sort-tab--active"));
        tab.classList.add("immich-sort-tab--active");
        currentSort = tab.dataset.sort;
        rerender();
      });
    });

    // Initial reveal animation — double-rAF ensures a real paint frame has
    // occurred before setting opacity, fixing the issue on mobile/tablet
    // where a single rAF fires before layout is committed.
    function revealCards() {
      grid.querySelectorAll(".immich-album-card").forEach(card => {
        card.style.opacity = "1";
        card.style.transform = "translateY(0)";
      });
    }
    requestAnimationFrame(() => requestAnimationFrame(revealCards));
    // Safety net: if rAF fires too early (e.g. backgrounded tab on iOS),
    // force-reveal after 400 ms regardless.
    setTimeout(revealCards, 400);
  }


  async function renderImmichWidget() {
    const group = findGroupContainer();
    if (!group) return;
    const host = ensureHost(group);

    if (!host.querySelector(".immich-shell")) {
      host.innerHTML = `<div class="immich-shell immich-shell--loading"><div class="immich-grid immich-grid--skeleton">${buildSkeleton(8)}</div></div>`;
    }

    try {
      const albums = await fetchAlbums();
      log(`Fetched ${albums.length} albums`);
      host.innerHTML = buildShell(albums);
      bindInteractions(host, albums);
      await loadCoverImages(host);
    } catch (err) {
      console.error("[Homepage Immich] Error:", err);
      host.innerHTML = `<div class="immich-shell">${buildError(err.message)}</div>`;
    }
  }

  function init() {
    const start = () => {
      setTimeout(renderImmichWidget, 1800);
      setInterval(() => {
        if (document.hidden) return;
        renderImmichWidget();
      }, IMMICH_CONFIG.pollMs);
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }

    const observer = new MutationObserver(() => {
      if (!document.querySelector(".immich-albums-host .immich-shell")) {
        setTimeout(renderImmichWidget, 500);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  init();
})();