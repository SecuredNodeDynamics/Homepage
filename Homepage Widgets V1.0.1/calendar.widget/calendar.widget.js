/* =====================================================
   MEDIA CALENDAR — Custom unified calendar widget
   Pulls from Radarr, Sonarr, Lidarr, Seerr (Jellyseerr)
   Schedule Tab → group: MEDIA CALENDAR
===================================================== */
(function () {

  const CAL_CONFIG = {
    groupName: "MEDIA CALENDAR",
    pollMs: 10 * 120 * 1000,
    timezone: "America/Los_Angeles",
    sources: [
      { type: "sonarr", label: "Sonarr 1", color: "#2dd4bf", url: "http://YOUR_LOCAL_SONARR1_IP:PORT", fallbackUrl: "https://YOUR_SONARR1_TUNNEL_URL", activeUrl: null, key: "YOUR_SONARR_API_KEY" },
      { type: "sonarr", label: "Sonarr 2", color: "#67e8f9", url: "http://YOUR_LOCAL_SONARR2_IP:PORT", fallbackUrl: "https://YOUR_SONARR2_TUNNEL_URL", activeUrl: null, key: "YOUR_SONARR_API_KEY" },
      { type: "radarr", label: "Radarr 1", color: "#fb923c", url: "http://YOUR_LOCAL_RADARR1_IP:PORT", fallbackUrl: "https://YOUR_RADARR1_TUNNEL_URL", activeUrl: null, key: "YOUR_RADARR_API_KEY" },
      { type: "radarr", label: "Radarr 2", color: "#fbbf24", url: "http://YOUR_LOCAL_RADARR2_IP:PORT", fallbackUrl: "https://YOUR_RADARR2_TUNNEL_URL", activeUrl: null, key: "YOUR_RADARR_API_KEY" },
      { type: "lidarr", label: "Lidarr", color: "#c084fc", url: "http://YOUR_LOCAL_LIDARR_IP:PORT", fallbackUrl: "https://YOUR_LIDARR_TUNNEL_URL", activeUrl: null, key: "YOUR_LIDARR_API_KEY" },
      { type: "seerr", label: "Seerr", color: "#a78bfa", url: "http://YOUR_LOCAL_SEERR_IP:PORT", fallbackUrl: "https://YOUR_SEERR_TUNNEL_URL", activeUrl: null, key: "YOUR_SEERR_API_KEY" },
    ],
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
    let row = group.querySelector(".hp-widget-row, .mcal-flex-row");
    if (!row) {
      const list = group.querySelector("ul.services-list, ul");
      if (list) list.style.display = "none";
      row = document.createElement("div");
      row.className = "hp-widget-row mcal-flex-row";
      group.appendChild(row);
    }
    let host = row.querySelector("." + cls);
    if (host) return host;
    host = document.createElement("div");
    host.className = "mcal-host " + cls;
    row.appendChild(host);
    return host;
  }

  /* ── Date helpers ──────────────────────────────── */
  function toLocalDate(isoStr) {
    if (!isoStr) return null;
    const d = new Date(isoStr);
    return isNaN(d) ? null : d;
  }

  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate();
  }

  function startOfDay(d) {
    const c = new Date(d); c.setHours(0, 0, 0, 0); return c;
  }

  function addDays(d, n) {
    const c = new Date(d); c.setDate(c.getDate() + n); return c;
  }

  function fmtMonthYear(d) {
    return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  }

  function fmtAgendaDate(d) {
    const today = new Date();
    if (sameDay(d, today)) return "Today";
    if (sameDay(d, addDays(today, 1))) return "Tomorrow";
    return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  }

  /* ── Media status badge ────────────────────────── */
  // Seerr mediaInfo.status values:
  //   0 = not in Seerr  1 = Unknown  2 = Pending
  //   3 = Processing    4 = Partial  5 = Available
  function mediaStatusBadge(status) {
    switch (status) {
      case 5: return `<span class="mcal-status mcal-status--available">✓ Available</span>`;
      case 4: return `<span class="mcal-status mcal-status--partial">⬡ Partial</span>`;
      case 3: return `<span class="mcal-status mcal-status--processing">⟳ Processing</span>`;
      case 2: return `<span class="mcal-status mcal-status--pending">⏳ Pending</span>`;
      case 1: return `<span class="mcal-status mcal-status--missing">✕ Missing</span>`;
      default: return `<span class="mcal-status mcal-status--missing">✕ Missing</span>`;
    }
  }

  /* ── Fallback-aware fetch ──────────────────────── */
  async function calFetch(src, path, extraHeaders = {}) {
    const candidates = [];
    if (src.activeUrl) candidates.push(src.activeUrl);
    if (!candidates.includes(src.url)) candidates.push(src.url);
    if (src.fallbackUrl && !candidates.includes(src.fallbackUrl)) candidates.push(src.fallbackUrl);

    let lastErr = null;
    for (const base of candidates) {
      try {
        const res = await fetch(`${base}${path}`, {
          headers: extraHeaders,
          signal: (() => { const c = new AbortController(); setTimeout(() => c.abort(), 8000); return c.signal; })(),
        });
        if (!res.ok) throw new Error(`${src.label} ${res.status}`);
        src.activeUrl = base;           // cache the winner
        return res.json();
      } catch (err) {
        src.activeUrl = null;
        lastErr = err;
      }
    }
    throw lastErr || new Error(`All URLs failed for ${src.label}`);
  }

  /* ── API fetchers ──────────────────────────────── */
  async function fetchRadarrCalendar(src) {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const end = new Date(now.getFullYear(), now.getMonth() + 2, 0).toISOString();
    const data = await calFetch(src, `/api/v3/calendar?apikey=${src.key}&start=${start}&end=${end}&unmonitored=true`);
    return (Array.isArray(data) ? data : []).map(m => ({
      date: toLocalDate(m.physicalRelease || m.digitalRelease || m.inCinemas || m.releaseDate),
      title: m.title,
      type: "movie",
      source: src.label,
      color: src.color,
      poster: m.images?.find(i => i.coverType === "poster")?.remoteUrl || null,
      serverUrl: src.url,
      titleSlug: m.titleSlug || null,
      mediaId: m.id || null,
      mediaStatus: m.hasFile ? 5 : 1,
    })).filter(e => e.date);
  }

  async function fetchSonarrCalendar(src) {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const end = new Date(now.getFullYear(), now.getMonth() + 2, 0).toISOString();
    const data = await calFetch(src, `/api/v3/calendar?apikey=${src.key}&start=${start}&end=${end}&unmonitored=true&includeSeries=true`);
    return (Array.isArray(data) ? data : [])
      .filter(ep => ep.seasonNumber !== 0)
      .map(ep => ({
        date: toLocalDate(ep.airDateUtc || ep.airDate),
        title: ep.series?.title || ep.seriesTitle || ep.series?.sortTitle || "Unknown",
        subtitle: ep.title ? `S${String(ep.seasonNumber).padStart(2, "0")}E${String(ep.episodeNumber).padStart(2, "0")} · ${ep.title}` : null,
        type: "episode",
        source: src.label,
        color: src.color,
        poster: ep.series?.images?.find(i => i.coverType === "poster")?.remoteUrl || null,
        serverUrl: src.url,
        titleSlug: ep.series?.titleSlug || null,
        mediaId: ep.series?.id || null,
        mediaStatus: ep.hasFile ? 5 : 1,
      })).filter(e => e.date);
  }

  async function fetchLidarrCalendar(src) {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const end = new Date(now.getFullYear(), now.getMonth() + 2, 0).toISOString();
    const data = await calFetch(src, `/api/v1/calendar?apikey=${src.key}&start=${start}&end=${end}&unmonitored=true`);
    return (Array.isArray(data) ? data : []).map(a => ({
      date: toLocalDate(a.releaseDate),
      title: a.artist?.artistName || a.artistName || "Unknown",
      subtitle: a.title,
      type: "album",
      source: src.label,
      color: src.color,
      poster: a.images?.find(i => i.coverType === "cover")?.remoteUrl || null,
      serverUrl: src.url,
      titleSlug: a.artist?.foreignArtistId || null,
    })).filter(e => e.date);
  }

  async function fetchSeerrCalendar(src) {
    const now = new Date();
    const oneMonthAgo = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const twoMonthsAhead = new Date(now.getFullYear(), now.getMonth() + 3, 0);
    const events = [];

    async function fetchDiscoverPages(endpoint, type) {
      let page = 1;
      let totalPages = 1;
      while (page <= totalPages && page <= 5) {
        const data = await calFetch(src, `/api/v1${endpoint}?page=${page}`, { "X-Api-Key": src.key });
        totalPages = data.totalPages || 1;
        (data.results || []).forEach(item => {
          const releaseStr = type === "movie" ? item.releaseDate : item.firstAirDate;
          const date = toLocalDate(releaseStr);
          if (!date || date < oneMonthAgo || date > twoMonthsAhead) return;
          events.push({
            date,
            title: item.title || item.name || "Unknown",
            subtitle: type === "movie" ? "Upcoming Movie" : "Upcoming Series",
            type: type === "movie" ? "movie" : "episode",
            source: type === "movie" ? "Seerr · Movie" : "Seerr · Series",
            color: type === "movie" ? src.color : "#a78bfa",
            poster: item.posterPath ? `https://image.tmdb.org/t/p/w200${item.posterPath}` : null,
            serverUrl: `${src.url}/${type === "movie" ? "movie" : "tv"}/${item.id}`,
            mediaStatus: item.mediaInfo?.status ?? 0,
          });
        });
        page++;
      }
    }

    await Promise.allSettled([
      fetchDiscoverPages("/discover/movies/upcoming", "movie"),
      fetchDiscoverPages("/discover/tv/upcoming", "tv"),
    ]);

    return events;
  }

  async function fetchAllEvents() {
    const results = await Promise.allSettled(
      CAL_CONFIG.sources.map(src => {
        if (src.type === "radarr") return fetchRadarrCalendar(src);
        if (src.type === "sonarr") return fetchSonarrCalendar(src);
        if (src.type === "lidarr") return fetchLidarrCalendar(src);
        if (src.type === "seerr") return fetchSeerrCalendar(src);
        return Promise.resolve([]);
      })
    );
    return results.flatMap(r => r.status === "fulfilled" ? r.value : []);
  }

  /* ── Media link builder ────────────────────────── */
  function buildMediaLink(ev) {
    if (!ev.serverUrl) return null;
    if (ev.type === "movie" && ev.titleSlug) return `${ev.serverUrl}/movie/${ev.titleSlug}`;
    if (ev.type === "episode" && ev.titleSlug) return `${ev.serverUrl}/series/${ev.titleSlug}`;
    if (ev.type === "album" && ev.titleSlug) return `${ev.serverUrl}/artist/${ev.titleSlug}`;
    return ev.serverUrl;
  }

  const MEDIA_TYPE_ICON = { movie: "🎬", episode: "📺", album: "🎵" };

  function mediaDotAttrs(ev, baseClass = "mcal-dot") {
    if (ev.mediaStatus === 1) {
      return `class="${baseClass} mcal-status-dot--missing" style="--mcal-src-color:${escH(ev.color)}"`;
    }
    return `class="${baseClass}" style="background:${escH(ev.color)}"`;
  }

  function buildMediaPosterHtml(ev) {
    return ev.poster
      ? `<img class="mcal-today-poster" src="${escH(ev.poster)}" alt="" loading="lazy" onerror="this.style.display='none'">`
      : `<div class="mcal-today-poster mcal-today-poster--fallback">${escH((ev.title || "?").charAt(0))}</div>`;
  }

  function buildMediaBodyHtml(ev, opts = {}) {
    const link = buildMediaLink(ev);
    const {
      bodyClass = "mcal-today-item-body",
      titleClass = "mcal-today-title",
      subClass = "mcal-today-sub",
      srcClass = "mcal-today-src",
      arrowClass = "mcal-today-arrow",
      showInlineArrow = true,
    } = opts;
    return `
      <div class="${bodyClass}">
        <div class="mcal-today-item-top">
          <span class="mcal-today-type">${MEDIA_TYPE_ICON[ev.type] || "•"}</span>
          <span class="${titleClass}">${escH(ev.title)}</span>
          ${link && showInlineArrow ? `<span class="${arrowClass}">↗</span>` : ""}
        </div>
        ${ev.subtitle ? `<div class="${subClass}">${escH(ev.subtitle)}</div>` : ""}
        <div class="mcal-src-row">
          <span class="${srcClass}" style="color:${escH(ev.color)};opacity:0.85;">${escH(ev.source)}</span>
          ${ev.mediaStatus != null ? mediaStatusBadge(ev.mediaStatus) : ""}
        </div>
      </div>`;
  }

  function buildMediaListCard(ev, opts = {}) {
    const link = buildMediaLink(ev);
    const tag = link ? "a" : "div";
    const linkAttrs = link ? `href="${escH(link)}" target="_blank" rel="noopener"` : "";
    const {
      itemClass = "mcal-today-item",
      linkClass = "mcal-today-item--link",
      trailingArrow = false,
      bodyOpts = {},
    } = opts;
    return `
      <${tag} class="${itemClass}${link ? ` ${linkClass}` : ""} mcal-media-list-row" ${linkAttrs}>
        <div class="mcal-today-poster-wrap mcal-today-poster-wrap--list">
          ${buildMediaPosterHtml(ev)}
          <span ${mediaDotAttrs(ev, "mcal-today-dot mcal-today-dot--poster")}></span>
        </div>
        ${buildMediaBodyHtml(ev, bodyOpts)}
        ${trailingArrow && link ? `<span class="mcal-agenda-arrow">↗</span>` : ""}
      </${tag}>`;
  }

  function buildMediaGridCard(ev) {
    const link = buildMediaLink(ev);
    const tag = link ? "a" : "div";
    const linkAttrs = link ? `href="${escH(link)}" target="_blank" rel="noopener"` : "";
    return `
      <${tag} class="mcal-today-card ${link ? "mcal-today-card--link" : ""}" ${linkAttrs}>
        <div class="mcal-today-poster-wrap">
          ${buildMediaPosterHtml(ev)}
          <span ${mediaDotAttrs(ev, "mcal-today-dot mcal-today-dot--poster")}></span>
        </div>
        ${buildMediaBodyHtml(ev, { bodyClass: "mcal-today-card-body" })}
      </${tag}>`;
  }

  /* ── Calendar grid view ────────────────────────── */
  function buildCalendarView(events, month, year) {
    const today = new Date();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startDow = firstDay.getDay();
    const totalDays = lastDay.getDate();

    const byDate = {};
    events.forEach(ev => {
      if (!ev.date) return;
      const key = `${ev.date.getFullYear()}-${ev.date.getMonth()}-${ev.date.getDate()}`;
      if (!byDate[key]) byDate[key] = [];
      byDate[key].push(ev);
    });

    const dowHeaders = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(d =>
      `<div class="mcal-dow">${d}</div>`).join("");

    let cells = "";
    for (let i = 0; i < startDow; i++) {
      cells += `<div class="mcal-cell mcal-cell--empty"></div>`;
    }
    for (let d = 1; d <= totalDays; d++) {
      const date = new Date(year, month, d);
      const key = `${year}-${month}-${d}`;
      const dayEvents = byDate[key] || [];
      const isToday = sameDay(date, today);
      const isPast = date < startOfDay(today);

      const dots = dayEvents.slice(0, 4).map(ev =>
        `<span ${mediaDotAttrs(ev, "mcal-dot")} title="${escH(ev.title)}"></span>`
      ).join("");
      const moreDots = dayEvents.length > 4
        ? `<span class="mcal-dot-more">+${dayEvents.length - 4}</span>` : "";

      cells += `<div class="mcal-cell ${isToday ? "mcal-cell--today" : ""} ${isPast ? "mcal-cell--past" : ""}"
                     data-date="${escH(key)}">
        <div class="mcal-day-num">${d}</div>
        <div class="mcal-dots">${dots}${moreDots}</div>
      </div>`;
    }

    return `
      <div class="mcal-grid-header">${dowHeaders}</div>
      <div class="mcal-grid">${cells}</div>`;
  }

  /* ── Agenda view ───────────────────────────────── */
  function buildAgendaView(events) {
    const today = startOfDay(new Date());
    const future = events
      .filter(ev => ev.date >= today)
      .sort((a, b) => a.date - b.date)
      .slice(0, 30);

    if (!future.length) {
      return `<div class="mcal-agenda-empty">No upcoming releases</div>`;
    }

    const grouped = [];
    let lastKey = null;
    future.forEach(ev => {
      const key = `${ev.date.getFullYear()}-${ev.date.getMonth()}-${ev.date.getDate()}`;
      if (key !== lastKey) {
        grouped.push({ date: ev.date, key, events: [] });
        lastKey = key;
      }
      grouped[grouped.length - 1].events.push(ev);
    });

    return grouped.map(g => {
      const isToday = sameDay(g.date, new Date());
      const items = g.events.map(ev =>
        buildMediaListCard(ev, {
          itemClass: "mcal-agenda-item",
          linkClass: "mcal-agenda-item--link",
          trailingArrow: true,
          bodyOpts: {
            bodyClass: "mcal-agenda-text",
            titleClass: "mcal-agenda-title",
            subClass: "mcal-agenda-sub",
            srcClass: "mcal-agenda-src",
            showInlineArrow: false,
          },
        })
      ).join("");

      return `
        <div class="mcal-agenda-group ${isToday ? "mcal-agenda-group--today" : ""}">
          <div class="mcal-agenda-date">${fmtAgendaDate(g.date)}</div>
          <div class="mcal-agenda-items">${items}</div>
        </div>`;
    }).join("");
  }

  /* ── Today panel ───────────────────────────────── */
  function buildTodayPanel() {
    const today = new Date();
    const todayEvents = _calEvents
      .filter(ev => ev.date && sameDay(ev.date, today))
      .sort((a, b) => a.date - b.date);

    const viewTabs = `
      <div class="mcal-items-view-tabs" aria-label="Today items view">
        <button class="mcal-items-view-tab ${_calItemsView === "list" ? "mcal-items-view-tab--active" : ""}"
                data-items-view="list" type="button">List</button>
        <button class="mcal-items-view-tab ${_calItemsView === "grid" ? "mcal-items-view-tab--active" : ""}"
                data-items-view="grid" type="button">Grid</button>
      </div>`;

    const itemsHtml = todayEvents.length === 0
      ? `<div class="mcal-today-empty">Nothing scheduled for today</div>`
      : todayEvents.map(ev => {
        if (_calItemsView === "grid") return buildMediaGridCard(ev);
        return buildMediaListCard(ev);
      }).join("");

    return `
      <div class="mcal-today-panel">
        <div class="mcal-today-hdr">
          <div class="mcal-today-hdr-main">
            <span class="mcal-today-label">Today</span>
            <span class="mcal-today-date">${today.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</span>
            <span class="mcal-today-count">${todayEvents.length} release${todayEvents.length !== 1 ? "s" : ""}</span>
          </div>
          ${viewTabs}
        </div>
        <div class="mcal-today-items ${_calItemsView === "grid" ? "mcal-today-items--grid" : "mcal-today-items--list"}">${itemsHtml}</div>
      </div>`;
  }

  /* ── Shell ─────────────────────────────────────── */
  let _calMonth = new Date().getMonth();
  let _calYear = new Date().getFullYear();
  let _calView = "month";
  let _calItemsView = "grid";
  let _calEvents = [];

  function legendHtml() {
    return CAL_CONFIG.sources.map(s =>
      `<span class="mcal-legend-item">
        <span class="mcal-legend-dot" style="background:${escH(s.color)}"></span>
        <span class="mcal-legend-label">${escH(s.label)}</span>
      </span>`
    ).join("");
  }

  function buildShell(contentHtml, loading) {
    const monthLabel = fmtMonthYear(new Date(_calYear, _calMonth, 1));
    return `
      <div class="mcal-shell">
        <div class="mcal-hdr">
          <div class="mcal-hdr-left">
            <img src="https://cdn.jsdelivr.net/gh/selfhst/icons/webp/fluidcalendar.webp" alt="Media Calendar" class="mcal-icon">
            <span class="mcal-title">Media Calendar</span>
          </div>
          <div class="mcal-hdr-center">
            <button class="mcal-nav" id="mcal-prev">‹</button>
            <span class="mcal-month-label">${escH(monthLabel)}</span>
            <button class="mcal-nav" id="mcal-next">›</button>
          </div>
          <div class="mcal-hdr-right">
            <button class="mcal-view-tab ${_calView === "month" ? "mcal-view-tab--active" : ""}" data-view="month">Month</button>
            <button class="mcal-view-tab ${_calView === "agenda" ? "mcal-view-tab--active" : ""}" data-view="agenda">Agenda</button>
          </div>
        </div>
        <div class="mcal-legend">${legendHtml()}</div>
        <div class="mcal-body">
          ${loading
        ? `<div class="mcal-loading">
                <svg class="mcal-spin" width="18" height="18" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" stroke-width="2">
                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4
                           M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
                </svg> Loading…</div>`
        : contentHtml}
        </div>
        ${!loading ? buildTodayPanel() : ""}
        <div class="mcal-footer">
          Radarr · Sonarr · Lidarr · Seerr · ${new Date().toLocaleTimeString()}
        </div>
      </div>`;
  }

  /* ── Day popup ─────────────────────────────────── */
  let _calPopup = null;
  let _calPopupBackdrop = null;

  function closeCalPopup() {
    if (_calPopup) { _calPopup.remove(); _calPopup = null; }
    if (_calPopupBackdrop) { _calPopupBackdrop.remove(); _calPopupBackdrop = null; }
  }

  document.addEventListener("keydown", e => { if (e.key === "Escape") closeCalPopup(); });

  function popupWidthForEvents(count) {
    const vw = window.innerWidth;
    if (count <= 0) return 280;
    if (count === 1) return Math.min(320, vw - 16);
    return Math.min(560, vw - 16);
  }

  function positionCalPopup(popup, anchorEl, eventCount = 1) {
    const PW = popupWidthForEvents(eventCount);
    const rect = anchorEl.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const PH = popup.offsetHeight || 400;

    let left = rect.left + rect.width / 2 - PW / 2;
    let top = rect.bottom + 8;

    if (left + PW > vw - 8) left = vw - PW - 8;
    if (left < 8) left = 8;
    if (top + PH > vh - 8) top = rect.top - PH - 8;
    if (top < 8) top = 8;

    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
    popup.style.width = `${PW}px`;
  }

  function openCalDayPopup(date, events, anchorEl) {
    closeCalPopup();

    const dateLabel = date.toLocaleDateString("en-US", {
      weekday: "long", month: "long", day: "numeric", year: "numeric"
    });

    const itemsHtml = events.length === 0
      ? `<div class="mcal-popup-empty">Nothing scheduled</div>`
      : events.map(ev => buildMediaGridCard(ev)).join("");

    const popup = document.createElement("div");
    popup.className = "mcal-popup";
    popup.innerHTML = `
      <div class="mcal-popup-hdr">
        <div class="mcal-popup-date">${escH(dateLabel)}</div>
        <div class="mcal-popup-count">${events.length} release${events.length !== 1 ? "s" : ""}</div>
      </div>
      <div class="mcal-popup-items mcal-popup-items--grid">${itemsHtml}</div>`;

    document.body.appendChild(popup);
    _calPopup = popup;

    const backdrop = document.createElement("div");
    backdrop.className = "mcal-popup-backdrop";
    backdrop.addEventListener("click", closeCalPopup);
    document.body.appendChild(backdrop);
    _calPopupBackdrop = backdrop;

    positionCalPopup(popup, anchorEl, events.length);

    const reposition = () => { if (_calPopup === popup) positionCalPopup(popup, anchorEl, events.length); };
    window.addEventListener("resize", reposition, { passive: true });
    window.addEventListener("scroll", reposition, { passive: true, capture: true });
    backdrop.addEventListener("click", () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, { capture: true });
    }, { once: true });
  }

  function renderContent() {
    if (_calView === "agenda") return buildAgendaView(_calEvents);
    return buildCalendarView(_calEvents, _calMonth, _calYear);
  }

  /* ── Main render ───────────────────────────────── */
  let _calHost = null;
  let _calRendering = false;

  function paint(loading = false) {
    if (!_calHost) return;
    _calHost.innerHTML = buildShell(loading ? "" : renderContent(), loading);
    bindCalEvents();
  }

  function bindCalEvents() {
    if (!_calHost) return;

    _calHost.querySelector("#mcal-prev")?.addEventListener("click", () => {
      _calMonth--;
      if (_calMonth < 0) { _calMonth = 11; _calYear--; }
      paint();
    });

    _calHost.querySelector("#mcal-next")?.addEventListener("click", () => {
      _calMonth++;
      if (_calMonth > 11) { _calMonth = 0; _calYear++; }
      paint();
    });

    _calHost.querySelectorAll(".mcal-view-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        _calView = btn.dataset.view;
        paint();
      });
    });

    _calHost.querySelectorAll("[data-items-view]").forEach(btn => {
      btn.addEventListener("click", () => {
        _calItemsView = btn.dataset.itemsView === "grid" ? "grid" : "list";
        paint();
      });
    });

    _calHost.querySelectorAll(".mcal-cell:not(.mcal-cell--empty)").forEach(cell => {
      cell.addEventListener("click", () => {
        const key = cell.dataset.date;
        if (!key) return;
        const [y, m, d] = key.split("-").map(Number);
        const date = new Date(y, m, d);
        const dayEvents = _calEvents.filter(ev => ev.date && sameDay(ev.date, date));
        openCalDayPopup(date, dayEvents, cell);
      });
    });
  }

  async function renderCalendar() {
    if (_calRendering) return;
    _calRendering = true;
    paint(true);
    try {
      _calEvents = await fetchAllEvents();
      paint(false);
    } catch (err) {
      console.error("[MediaCal]", err);
      if (_calHost) _calHost.innerHTML = buildShell(
        `<div class="mcal-loading" style="color:#f87171;">Failed to load calendar data</div>`, false);
    } finally {
      _calRendering = false;
    }
  }

  /* ── Init ──────────────────────────────────────── */
  function init() {
    const start = () => setTimeout(() => {
      const group = findGroup(CAL_CONFIG.groupName);
      if (!group) return;
      _calHost = ensureHost(group, "mcal-widget-host");
      renderCalendar();
      setInterval(() => {
        if (document.hidden) return;
        renderCalendar();
      }, CAL_CONFIG.pollMs);
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
        if (!document.querySelector(".mcal-widget-host .mcal-shell")) {
          const group = findGroup(CAL_CONFIG.groupName);
          if (!group) return;
          _calHost = ensureHost(group, "mcal-widget-host");
          renderCalendar();
        }
      }, 700);
    }).observe(document.body, { childList: true, subtree: true });
  }

  init();
})();
