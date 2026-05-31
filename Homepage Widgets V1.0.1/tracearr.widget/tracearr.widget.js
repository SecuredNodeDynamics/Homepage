/* =====================================================
   TRACEARR WIDGET
===================================================== */
(function () {
  const TRACEARR_CONFIG = {
    groupName: "TRACEARR - WIDGET",
    url: "http://YOUR_LOCAL_IP:PORT",
    fallbackUrl: "https://YOUR_TUNNEL_URL", // or null if not using a tunnel
    activeUrl: null,
    apiKey: "YOUR_API_KEY_HERE", // API key created in the TDarr Server GUI settings under API KEY
    pollMs: 60_000,
  };

  let _pollTimer = null;
  let _rendered = false;
  let _data = {};
  let _activeTab = "overview";
  let _histRange = 7;
  let _histMetric = "plays";
  let _charts = {};

  function normText(v) {
    return (v || "").replace(/\s+/g, " ").trim();
  }

  function escH(s = "") {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function asArray(v) {
    if (Array.isArray(v)) return v;
    if (Array.isArray(v?.data)) return v.data;
    return [];
  }

  function num(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

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
    let row = group.querySelector(".trr-flex-row");
    if (!row) {
      const list = group.querySelector("ul.services-list, ul");
      if (list) list.style.display = "none";
      row = document.createElement("div");
      row.className = "trr-flex-row";
      group.appendChild(row);
    }
    let host = row.querySelector(".trr-host");
    if (host) return host;
    host = document.createElement("div");
    host.className = "trr-host";
    row.appendChild(host);
    return host;
  }

  async function trrFetch(path) {
    const candidates = [];
    if (TRACEARR_CONFIG.activeUrl) candidates.push(TRACEARR_CONFIG.activeUrl);
    if (!candidates.includes(TRACEARR_CONFIG.url)) candidates.push(TRACEARR_CONFIG.url);
    if (TRACEARR_CONFIG.fallbackUrl && !candidates.includes(TRACEARR_CONFIG.fallbackUrl)) candidates.push(TRACEARR_CONFIG.fallbackUrl);

    let lastErr = null;
    for (const base of candidates) {
      try {
        const res = await fetch(`${base}${path}`, {
          headers: {
            Authorization: `Bearer ${TRACEARR_CONFIG.apiKey}`,
            Accept: "application/json",
          },
          signal: (() => { const c = new AbortController(); setTimeout(() => c.abort(), 8000); return c.signal; })(),
        });
        if (!res.ok) throw new Error(`Tracearr ${res.status}: ${path}`);
        TRACEARR_CONFIG.activeUrl = base;
        return res.json();
      } catch (err) {
        TRACEARR_CONFIG.activeUrl = null;
        lastErr = err;
      }
    }
    throw lastErr || new Error(`All URLs failed for Tracearr`);
  }

  async function fetchAll() {
    const [health, stats, today, activity, users, streams] =
      await Promise.allSettled([
        trrFetch("/api/v1/public/health"),
        trrFetch("/api/v1/public/stats"),
        trrFetch("/api/v1/public/stats/today"),
        trrFetch("/api/v1/public/activity"),
        trrFetch("/api/v1/public/users"),
        trrFetch("/api/v1/public/streams"),
      ]);

    // Fetch enough history pages to cover 35 days
    let historyData = [];
    try {
      const pages = await Promise.all([
        trrFetch("/api/v1/public/history?pageSize=100&page=1"),
        trrFetch("/api/v1/public/history?pageSize=100&page=2"),
        trrFetch("/api/v1/public/history?pageSize=100&page=3"),
        trrFetch("/api/v1/public/history?pageSize=100&page=4"),
        trrFetch("/api/v1/public/history?pageSize=100&page=5"),
      ]);
      historyData = pages.flatMap(p => asArray(p));
    } catch (err) {
      console.warn("[TracearrWidget] history fetch error", err);
    }

    _data = {
      health: health.status === "fulfilled" ? health.value : null,
      stats: stats.status === "fulfilled" ? stats.value : null,
      today: today.status === "fulfilled" ? today.value : null,
      activity: activity.status === "fulfilled" ? activity.value : null,
      history: historyData,
      users: users.status === "fulfilled" ? users.value : null,
      streams: streams.status === "fulfilled" ? streams.value : null,
      error:
        health.status === "rejected" &&
        stats.status === "rejected" &&
        today.status === "rejected",
    };
  }

  function getDurationSeconds(e) {
    const msFields = [
      e.totalDurationMs,
      e.durationMs,
      e.progressMs,
      e.duration_ms,
      e.progress_ms,
    ];

    for (const value of msFields) {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) return Math.round(n / 1000);
    }

    const starts = [e.startedAt, e.started_at, e.startTime, e.start_time];
    const stops = [e.stoppedAt, e.stopped_at, e.stopTime, e.stop_time,
    e.endedAt, e.ended_at, e.endTime, e.end_time];

    for (const s of starts) {
      for (const t of stops) {
        if (!s || !t) continue;
        const start = new Date(s).getTime();
        const stop = new Date(t).getTime();
        if (!isNaN(start) && !isNaN(stop) && stop > start) {
          return Math.round((stop - start) / 1000);
        }
      }
    }

    const secFields = [
      e.duration, e.watchTime, e.watch_time,
      e.durationSeconds, e.duration_seconds,
      e.playDuration, e.play_duration,
      e.playbackDuration, e.playback_duration,
      e.watchedDuration, e.watched_duration,
      e.sessionDuration, e.session_duration,
      e.elapsed, e.elapsedSeconds, e.elapsed_seconds,
      e.runtime, e.runtimeSeconds, e.runtime_seconds,
      e.minutesWatched ? Number(e.minutesWatched) * 60 : null,
      e.minutes_watched ? Number(e.minutes_watched) * 60 : null,
      e.hoursWatched ? Number(e.hoursWatched) * 3600 : null,
      e.hours_watched ? Number(e.hours_watched) * 3600 : null,
    ];

    for (const value of secFields) {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) return n;
    }

    if (e.watchTime && typeof e.watchTime === "object") {
      const nested = [
        e.watchTime.seconds,
        e.watchTime.minutes ? Number(e.watchTime.minutes) * 60 : null,
        e.watchTime.hours ? Number(e.watchTime.hours) * 3600 : null,
        e.watchTime.value,
      ];
      for (const value of nested) {
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) return n;
      }
    }

    return 0;
  }

  function getHistoryPlays(rangeOverride = null) {
    const days = rangeOverride || _histRange;
    const acts = _data.activity || {};
    const hist = asArray(_data.history);
    const activityPlays = Array.isArray(acts.plays) ? acts.plays : [];
    const source = hist.length ? hist : activityPlays;
    const now = new Date();
    const buckets = {};

    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      buckets[key] = { plays: 0, duration: 0 };
    }

    source.forEach(e => {
      const ts =
        e.startedAt ||
        e.stoppedAt ||
        e.date ||
        e.timestamp ||
        e.started_at ||
        e.startTime ||
        e.created_at ||
        e.time;

      if (!ts) return;

      const d = new Date(ts);
      if (Number.isNaN(d.getTime())) return;

      const key = d.toISOString().slice(0, 10);
      if (!buckets[key]) return;

      buckets[key].plays += 1;
      buckets[key].duration += getDurationSeconds(e);
    });

    return {
      labels: Object.keys(buckets).map(k => {
        const [, m, d] = k.split("-");
        return `${m}/${d}`;
      }),
      plays: Object.values(buckets).map(b => b.plays),
      duration: Object.values(buckets).map(b => Math.round(b.duration / 60)),
    };
  }

  function getDevices() {
    const platforms = Array.isArray(_data.activity?.platforms)
      ? _data.activity.platforms
      : [];

    if (platforms.length) {
      return platforms
        .filter(p => num(p.count) > 0)
        .sort((a, b) => num(b.count) - num(a.count))
        .slice(0, 8)
        .map(p => ({
          name: p.platform || p.name || p.device || "Unknown",
          count: num(p.count),
        }));
    }

    const hist = asArray(_data.history);
    const map = {};

    hist.forEach(e => {
      const raw =
        e.player ||
        e.device ||
        e.client ||
        e.platform ||
        e.product ||
        e.app ||
        "Unknown";

      const key =
        typeof raw === "object"
          ? raw.name || raw.title || raw.platform || raw.product || "Unknown"
          : raw;

      map[key] = (map[key] || 0) + 1;
    });

    return Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, count]) => ({ name, count }));
  }

  function getTopUsers() {
    const hist = asArray(_data.history);
    const usersArr = asArray(_data.users);
    const map = {};

    function pickUserName(value) {
      if (!value) return null;
      if (typeof value === "string") return value;
      if (typeof value === "number") return String(value);
      if (typeof value === "object") {
        return (
          value.displayName ||
          value.display_name ||
          value.username ||
          value.name ||
          value.email ||
          value.title ||
          value.label ||
          value.id ||
          null
        );
      }
      return null;
    }

    function pickUserId(value) {
      if (!value) return null;
      if (typeof value === "string" || typeof value === "number") return value;
      if (typeof value === "object") {
        return (
          value.id ||
          value.userId ||
          value.user_id ||
          value.username ||
          value.email ||
          null
        );
      }
      return null;
    }

    hist.forEach(e => {
      const rawUser =
        e.user ||
        e.userInfo ||
        e.userObject ||
        e.account ||
        e.username ||
        e.userId ||
        e.user_id;

      const uid =
        pickUserId(rawUser) ||
        pickUserId(e.userId) ||
        pickUserId(e.user_id) ||
        pickUserName(rawUser);

      if (!uid) return;

      if (!map[uid]) {
        map[uid] = {
          uid,
          name: pickUserName(rawUser) || `User ${uid}`,
          plays: 0,
          duration: 0,
        };
      }

      map[uid].plays += 1;
      map[uid].duration += getDurationSeconds(e);
    });

    return Object.values(map)
      .map(u => {
        const info = usersArr.find(x => {
          const xid =
            x?.id || x?.userId || x?.user_id || x?.username || x?.email;
          return String(xid) === String(u.uid);
        });

        return {
          ...u,
          name: pickUserName(info) || u.name || `User ${u.uid}`,
        };
      })
      .sort((a, b) => b.plays - a.plays)
      .slice(0, 8);
  }

  function getLibraries() {
    const hist = asArray(_data.history);
    const map = {};

    hist.forEach(e => {
      const raw =
        e.library ||
        e.libraryName ||
        e.library_name ||
        e.section ||
        e.sectionTitle ||
        e.mediaType ||
        e.type ||
        "Unknown";

      const key = raw === "track" || raw === "Track" ? "Music" : raw;

      map[key] = (map[key] || 0) + 1;
    });

    return Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count }));
  }

  function fmtDuration(secs) {
    const total = num(secs, 0);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  const C = {
    teal: ["rgba(74,222,180,0.85)", "rgba(74,222,180,0.18)"],
    blue: ["rgba(96,165,250,0.85)", "rgba(96,165,250,0.18)"],
    purple: ["rgba(167,139,250,0.85)", "rgba(167,139,250,0.18)"],
    amber: ["rgba(251,191,36,0.85)", "rgba(251,191,36,0.18)"],
    green: ["rgba(52,211,153,0.85)", "rgba(52,211,153,0.18)"],
    rose: ["rgba(251,113,133,0.85)", "rgba(251,113,133,0.18)"],
    indigo: ["rgba(129,140,248,0.85)", "rgba(129,140,248,0.18)"],
    orange: ["rgba(251,146,60,0.85)", "rgba(251,146,60,0.18)"],
  };

  const PALETTE = Object.values(C);

  function ensureChartJs(cb) {
    if (window.Chart) {
      cb();
      return;
    }
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js";
    s.onload = cb;
    document.head.appendChild(s);
  }

  function destroyChart(k) {
    if (_charts[k]) {
      _charts[k].destroy();
      delete _charts[k];
    }
  }

  function destroyAll() {
    Object.keys(_charts).forEach(k => destroyChart(k));
  }

  function baseOpts(extra = {}) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 600, easing: "easeOutQuart" },
      layout: {
        padding: { top: 4, right: 0, bottom: 10, left: 0 },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "rgba(12,16,22,0.96)",
          borderColor: "rgba(255,255,255,0.12)",
          borderWidth: 1,
          titleColor: "rgba(255,255,255,0.85)",
          bodyColor: "rgba(255,255,255,0.65)",
          padding: 10,
          cornerRadius: 8,
        },
        ...extra.plugins,
      },
      scales: {
        x: {
          grid: { color: "rgba(255,255,255,0.05)", drawTicks: false },
          ticks: {
            color: "rgba(255,255,255,0.30)",
            font: { size: 10 },
            maxRotation: 45,
            autoSkip: true,
            maxTicksLimit: 14,
            padding: 8,
          },
          border: { color: "rgba(255,255,255,0.08)" },
        },
        y: {
          grid: { color: "rgba(255,255,255,0.05)", drawTicks: false },
          ticks: {
            color: "rgba(255,255,255,0.30)",
            font: { size: 10 },
          },
          border: { color: "transparent" },
          beginAtZero: true,
        },
        ...extra.scales,
      },
    };
  }

  function buildWidget() {
    const t = _data.today || {};
    const s = _data.stats || {};
    const h = _data.health;

    const online = h?.servers?.[0]?.online ?? true;
    const serverName = h?.servers?.[0]?.name || "Tracearr";
    const version = h?.version || "";
    const activeStreams = num(t.activeStreams ?? s.activeStreams, 0);

    const statusCls = online ? "trr-status--active" : "trr-status--idle";
    const statusTxt = online
      ? activeStreams > 0
        ? `${activeStreams} Streaming`
        : "Online"
      : "Offline";

    const TABS = [
      { id: "overview", label: "Overview" },
      { id: "history", label: "History" },
      { id: "users", label: "Users" },
      { id: "devices", label: "Devices" },
      { id: "libraries", label: "Libraries" },
      { id: "heatmap", label: "Peak Hours" },
    ];

    return `
      <div class="trr-shell">
        <div class="trr-header">
          <div class="trr-header-left">
            <img src="/icons/tracearr.png" alt="Tracearr" class="trr-icon">
            <div>
              <div class="trr-title">Tracearr</div>
            </div>
          </div>
          <div class="trr-header-right">
            <div class="trr-tabs">
              ${TABS.map(tab => `
                <button class="trr-tab ${_activeTab === tab.id ? "trr-tab--active" : ""}" data-tab="${tab.id}">
                  ${escH(tab.label)}
                </button>
              `).join("")}
            </div>
            <span class="trr-status ${statusCls}">${escH(statusTxt)}</span>
            <a class="trr-open-link" href="${escH(TRACEARR_CONFIG.url)}" target="_blank" rel="noopener">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
              </svg>
              Open
            </a>
          </div>
        </div>

        <div class="trr-body">
          ${buildTabContent()}
        </div>

        <div class="trr-footer">
          Updated ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true })}
        </div>
      </div>
    `;
  }

  function buildMetricCards() {
    const t = _data.today || {};
    const s = _data.stats || {};

    const cards = [
      { label: "Today Plays", value: num(t.todayPlays ?? t.plays ?? t.totalPlays, 0) },
      { label: "Today Watch Time", value: t.watchTimeHours != null ? `${num(t.watchTimeHours, 0)}h` : fmtDuration(num(t.watchTime ?? t.watch_time ?? 0, 0)) },
      { label: "Active Streams", value: num(t.activeStreams ?? s.activeStreams, 0) },
      { label: "Users", value: num(s.users ?? s.totalUsers, 0) },
    ];

    return `
      <div class="trr-metrics">
        ${cards
        .map(
          c => `
            <div class="trr-card trr-metric">
              <div class="trr-metric-value">${escH(c.value)}</div>
              <div class="trr-metric-label">${escH(c.label)}</div>
            </div>
          `
        )
        .join("")}
      </div>
    `;
  }

  // ── UPDATED: calendar heatmap replaces plays bar chart ──
  function buildOverviewTab() {
    return `
      ${buildMetricCards()}
      <div class="trr-grid trr-grid--2">
        <div class="trr-card">
          <div class="trr-card-title">Plays Per Day — Last 5 Weeks</div>
          <div id="trr-overview-cal" class="trr-cal-wrap"></div>
        </div>
        <div class="trr-card">
          <div class="trr-card-title">Watch Time Per Day (min)</div>
          <div class="trr-chart-wrap" style="position:relative">
            <canvas id="trr-overview-watchtime"></canvas>
          </div>
        </div>
      </div>
    `;
  }

  function buildHistoryTab() {
    return `
      <div class="trr-toolbar">
        <div class="trr-toggle-group">
          <button class="trr-toggle ${_histRange === 7 ? "is-active" : ""}" data-range="7">7 days</button>
          <button class="trr-toggle ${_histRange === 30 ? "is-active" : ""}" data-range="30">30 days</button>
        </div>
        <div class="trr-toggle-group">
          <button class="trr-toggle ${_histMetric === "plays" ? "is-active" : ""}" data-metric="plays">Plays</button>
          <button class="trr-toggle ${_histMetric === "watchTime" ? "is-active" : ""}" data-metric="watchTime">Watch Time</button>
        </div>
      </div>

      <div class="trr-grid">
        <div class="trr-card">
          <div class="trr-card-title">
            ${_histMetric === "plays"
        ? `Plays Over Time (${_histRange}D)`
        : `Watch Time Over Time (${_histRange}D)`}
          </div>
          <div class="trr-chart-wrap"><canvas id="trr-history-main"></canvas></div>
        </div>

        <div class="trr-card">
          <div class="trr-card-title">30-Day Plays Trend</div>
          <div class="trr-chart-wrap"><canvas id="trr-history-trend"></canvas></div>
        </div>
      </div>
    `;
  }

  function buildUsersTab() {
    const users = getTopUsers();

    return `
      <div class="trr-grid trr-grid--2">
        <div class="trr-card">
          <div class="trr-card-title">Top Users by Play Count</div>
          <div class="trr-chart-wrap"><canvas id="trr-users-chart"></canvas></div>
        </div>
        <div class="trr-card">
          <div class="trr-card-title">User Watch Time</div>
          <div class="trr-list">
            ${users
        .map(
          u => `
                <div class="trr-list-row">
                  <div class="trr-list-main">
                    <div class="trr-list-title">${escH(u.name)}</div>
                    <div class="trr-list-sub">${u.plays} plays</div>
                  </div>
                  <div class="trr-list-side">${fmtDuration(u.duration)}</div>
                </div>
              `
        )
        .join("") || `<div class="trr-empty">No user data</div>`}
          </div>
        </div>
      </div>
    `;
  }

  function buildDevicesTab() {
    const devices = getDevices();

    return `
      <div class="trr-grid trr-grid--2">
        <div class="trr-card">
          <div class="trr-card-title">Device Breakdown</div>
          <div class="trr-chart-wrap"><canvas id="trr-devices-donut"></canvas></div>
        </div>
        <div class="trr-card">
          <div class="trr-card-title">Top Players / Devices</div>
          <div class="trr-chart-wrap"><canvas id="trr-devices-bars"></canvas></div>
        </div>
      </div>
    `;
  }

  function buildLibrariesTab() {
    const libs = getLibraries();

    return `
      <div class="trr-grid trr-grid--2">
        <div class="trr-card">
          <div class="trr-card-title">Most-Watched Libraries</div>
          <div class="trr-chart-wrap"><canvas id="trr-libraries-chart"></canvas></div>
        </div>
        <div class="trr-card">
          <div class="trr-card-title">Library Totals</div>
          <div class="trr-list">
            ${libs
        .map((l, i) => `
                <div class="trr-list-row">
                  <div class="trr-list-main">
                    <div class="trr-list-title">${escH(l.name)}</div>
                    <div class="trr-bar">
                      <span style="width:${Math.max(
          6,
          Math.round((l.count / Math.max(...libs.map(x => x.count), 1)) * 100)
        )}%; background:${PALETTE[i % PALETTE.length][0]}"></span>
                    </div>
                  </div>
                  <div class="trr-list-side">${l.count}</div>
                </div>
              `)
        .join("") || `<div class="trr-empty">No library data</div>`}
          </div>
        </div>
      </div>
    `;
  }

  function buildHeatmapTab() {
    return `
      <div class="trr-card">
        <div class="trr-card-title">Peak Hours Heatmap</div>
        <div id="trr-heatmap" class="trr-heatmap"></div>
      </div>
    `;
  }

  function buildTabContent() {
    if (_activeTab === "overview") return buildOverviewTab();
    if (_activeTab === "history") return buildHistoryTab();
    if (_activeTab === "users") return buildUsersTab();
    if (_activeTab === "devices") return buildDevicesTab();
    if (_activeTab === "libraries") return buildLibrariesTab();
    if (_activeTab === "heatmap") return buildHeatmapTab();
    return buildOverviewTab();
  }

  function mountCharts() {
    ensureChartJs(() => {
      destroyAll();

      if (_activeTab === "overview") {
        renderOverviewCharts();
      } else if (_activeTab === "history") {
        renderHistoryCharts();
      } else if (_activeTab === "users") {
        renderUsersChart();
      } else if (_activeTab === "devices") {
        renderDevicesCharts();
      } else if (_activeTab === "libraries") {
        renderLibrariesChart();
      } else if (_activeTab === "heatmap") {
        renderHeatmap();
      }
    });
  }

  // ── UPDATED: drives calendar + fixed watch time chart ──
  function renderOverviewCharts() {
    renderOverviewCalendar();

    const watch30 = getHistoryPlays(30);
    const watchEl = document.getElementById("trr-overview-watchtime");
    if (!watchEl) return;

    const hasDuration = watch30.duration.some(v => v > 0);

    _charts.overviewWatch = new Chart(watchEl, {
      type: "line",
      data: {
        labels: watch30.labels,
        datasets: [{
          data: watch30.duration,
          borderColor: C.green[0],
          backgroundColor: C.green[1],
          fill: true,
          tension: 0.35,
          pointRadius: hasDuration ? 2 : 0,
          pointHoverRadius: hasDuration ? 5 : 0,
          borderWidth: hasDuration ? 1.8 : 1,
        }],
      },
      options: {
        ...baseOpts(),
        plugins: {
          ...baseOpts().plugins,
          tooltip: {
            ...baseOpts().plugins.tooltip,
            callbacks: {
              label: ctx => {
                const v = ctx.parsed.y;
                return v >= 60
                  ? `${Math.floor(v / 60)}h ${v % 60}m`
                  : `${v}m`;
              },
            },
          },
        },
      },
    });

    // If server never returned duration data, show a clear no-data state
    if (!hasDuration) {
      const wrap = watchEl.closest(".trr-chart-wrap");
      if (wrap) {
        const ov = document.createElement("div");
        ov.className = "trr-no-data";
        ov.innerHTML = `<span>Duration not reported by server</span>`;
        wrap.appendChild(ov);
      }
    }
  }

  // ── NEW: GitHub-style 5-week calendar heatmap for plays ──
  function renderOverviewCalendar() {
    const host = document.getElementById("trr-overview-cal");
    if (!host) return;

    const DAYS = 35;
    const data = getHistoryPlays(DAYS);
    const max = Math.max(...data.plays, 1);

    const now = new Date();
    now.setHours(0, 0, 0, 0);

    const lookup = {};
    for (let i = 0; i < DAYS; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - (DAYS - 1 - i));
      lookup[d.toISOString().slice(0, 10)] = {
        plays: data.plays[i],
        label: data.labels[i],
        date: new Date(d),
      };
    }

    const rangeStart = new Date(now);
    rangeStart.setDate(rangeStart.getDate() - (DAYS - 1));
    rangeStart.setDate(rangeStart.getDate() - rangeStart.getDay());

    const weeks = [];
    const cur = new Date(rangeStart);

    while (cur <= now) {
      if (!weeks.length || weeks[weeks.length - 1].length === 7) weeks.push([]);
      const key = cur.toISOString().slice(0, 10);
      const info = lookup[key];
      weeks[weeks.length - 1].push(
        info
          ? { ...info, inRange: true }
          : { inRange: false }
      );
      cur.setDate(cur.getDate() + 1);
    }

    while (weeks[weeks.length - 1].length < 7) {
      weeks[weeks.length - 1].push({ inRange: false });
    }

    const DOW = ["S", "M", "T", "W", "T", "F", "S"];
    const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    function cellColor(plays) {
      if (!plays) return "rgba(255,255,255,0.05)";
      const t = plays / max;
      if (t <= 0.25) return "rgba(74,222,180,0.22)";
      if (t <= 0.50) return "rgba(74,222,180,0.46)";
      if (t <= 0.75) return "rgba(74,222,180,0.70)";
      return "rgba(74,222,180,0.92)";
    }

    function textColor(plays) {
      if (!plays) return "rgba(255,255,255,0.25)";
      const t = plays / max;
      return t >= 0.50 ? "rgba(0,0,0,0.70)" : "rgba(255,255,255,0.60)";
    }

    function monthLabel(week) {
      const first = week.find(c => c.inRange && c.date);
      if (!first) return "";
      return first.date.getDate() <= 7 ? MONTHS[first.date.getMonth()] : "";
    }

    host.innerHTML = `
      <div class="trr-cal">
        <div class="trr-cal-body">
          <div class="trr-cal-dow">
            ${DOW.map(d => `<div class="trr-cal-dow-item">${d}</div>`).join("")}
          </div>
          <div class="trr-cal-scroll">
            <div class="trr-cal-months">
              ${weeks.map(w => `<div class="trr-cal-month-lbl">${monthLabel(w)}</div>`).join("")}
            </div>
            <div class="trr-cal-grid">
              ${weeks.map(week => `
                <div class="trr-cal-col">
                  ${week.map(cell => cell.inRange
      ? `<div class="trr-cal-cell"
                             style="background:${cellColor(cell.plays || 0)};color:${textColor(cell.plays || 0)};display:flex;align-items:center;justify-content:center;font-size:0.52rem;font-weight:700;"
                             title="${cell.date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}: ${cell.plays || 0} play${cell.plays !== 1 ? "s" : ""}"
                        >${cell.date.getDate()}</div>`
      : `<div class="trr-cal-cell trr-cal-cell--void"></div>`
    ).join("")}
                </div>
              `).join("")}
            </div>
          </div>
        </div>
        <div class="trr-cal-legend">
          <span>Less</span>
          ${[0.05, 0.22, 0.46, 0.70, 0.92].map(a =>
      `<div class="trr-cal-swatch" style="background:rgba(74,222,180,${a})"></div>`
    ).join("")}
          <span>More</span>
        </div>
      </div>
    `;
  }

  function renderHistoryCharts() {
    const hist = getHistoryPlays(_histRange);
    const trend30 = getHistoryPlays(30);

    const mainEl = document.getElementById("trr-history-main");
    const trendEl = document.getElementById("trr-history-trend");

    if (mainEl) {
      _charts.historyMain = new Chart(mainEl, {
        type: _histMetric === "plays" ? "bar" : "line",
        data: {
          labels: hist.labels,
          datasets: [{
            data: _histMetric === "plays" ? hist.plays : hist.duration,
            backgroundColor: _histMetric === "plays" ? C.blue[1] : C.green[1],
            borderColor: _histMetric === "plays" ? C.blue[0] : C.green[0],
            borderWidth: 1.5,
            borderRadius: _histMetric === "plays" ? 6 : 0,
            fill: _histMetric !== "plays",
            tension: 0.35,
            pointRadius: _histMetric === "plays" ? 0 : 2,
            pointHoverRadius: _histMetric === "plays" ? 0 : 4,
          }],
        },
        options: baseOpts(),
      });
    }

    if (trendEl) {
      _charts.historyTrend = new Chart(trendEl, {
        type: "line",
        data: {
          labels: trend30.labels,
          datasets: [{
            data: trend30.plays,
            borderColor: C.teal[0],
            backgroundColor: C.teal[1],
            fill: true,
            tension: 0.35,
            pointRadius: 2,
            pointHoverRadius: 4,
          }],
        },
        options: baseOpts(),
      });
    }
  }

  function renderUsersChart() {
    const users = getTopUsers();
    const el = document.getElementById("trr-users-chart");
    if (!el) return;

    _charts.users = new Chart(el, {
      type: "bar",
      data: {
        labels: users.map(u => u.name),
        datasets: [{
          data: users.map(u => u.plays),
          backgroundColor: users.map((_, i) => PALETTE[i % PALETTE.length][1]),
          borderColor: users.map((_, i) => PALETTE[i % PALETTE.length][0]),
          borderWidth: 1.3,
          borderRadius: 6,
        }],
      },
      options: baseOpts({
        indexAxis: "y",
        scales: {
          x: {
            grid: { color: "rgba(255,255,255,0.05)", drawTicks: false },
            ticks: { color: "rgba(255,255,255,0.30)", font: { size: 10 } },
            border: { color: "transparent" },
            beginAtZero: true,
          },
          y: {
            grid: { display: false },
            ticks: { color: "rgba(255,255,255,0.45)", font: { size: 11 } },
            border: { color: "transparent" },
          },
        },
      }),
    });
  }

  function renderDevicesCharts() {
    const devices = getDevices();
    const donutEl = document.getElementById("trr-devices-donut");
    const barsEl = document.getElementById("trr-devices-bars");

    if (donutEl) {
      _charts.devicesDonut = new Chart(donutEl, {
        type: "doughnut",
        data: {
          labels: devices.map(d => d.name),
          datasets: [{
            data: devices.map(d => d.count),
            backgroundColor: devices.map((_, i) => PALETTE[i % PALETTE.length][0]),
            borderColor: "rgba(12,16,22,0.8)",
            borderWidth: 2,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: "64%",
          plugins: {
            legend: {
              position: "bottom",
              labels: {
                color: "rgba(255,255,255,0.50)",
                boxWidth: 10,
                boxHeight: 10,
                padding: 12,
              },
            },
            tooltip: {
              backgroundColor: "rgba(12,16,22,0.96)",
              borderColor: "rgba(255,255,255,0.12)",
              borderWidth: 1,
              titleColor: "rgba(255,255,255,0.85)",
              bodyColor: "rgba(255,255,255,0.65)",
            },
          },
        },
      });
    }

    if (barsEl) {
      _charts.devicesBars = new Chart(barsEl, {
        type: "bar",
        data: {
          labels: devices.map(d => d.name),
          datasets: [{
            data: devices.map(d => d.count),
            backgroundColor: devices.map((_, i) => PALETTE[i % PALETTE.length][1]),
            borderColor: devices.map((_, i) => PALETTE[i % PALETTE.length][0]),
            borderWidth: 1.3,
            borderRadius: 6,
          }],
        },
        options: baseOpts({
          indexAxis: "y",
          scales: {
            x: {
              grid: { color: "rgba(255,255,255,0.05)", drawTicks: false },
              ticks: { color: "rgba(255,255,255,0.30)", font: { size: 10 } },
              border: { color: "transparent" },
              beginAtZero: true,
            },
            y: {
              grid: { display: false },
              ticks: { color: "rgba(255,255,255,0.45)", font: { size: 11 } },
              border: { color: "transparent" },
            },
          },
        }),
      });
    }
  }

  function renderLibrariesChart() {
    const libs = getLibraries();
    const el = document.getElementById("trr-libraries-chart");
    if (!el) return;

    _charts.libraries = new Chart(el, {
      type: "bar",
      data: {
        labels: libs.map(l => l.name),
        datasets: [{
          data: libs.map(l => l.count),
          backgroundColor: libs.map((_, i) => PALETTE[i % PALETTE.length][1]),
          borderColor: libs.map((_, i) => PALETTE[i % PALETTE.length][0]),
          borderWidth: 1.3,
          borderRadius: 6,
        }],
      },
      options: baseOpts(),
    });
  }

  function renderHeatmap() {
    const host = document.getElementById("trr-heatmap");
    if (!host) return;

    const hist = asArray(_data.history);
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const grid = Array.from({ length: 7 }, () => Array(24).fill(0));

    hist.forEach(e => {
      const ts =
        e.startedAt ||
        e.stoppedAt ||
        e.date ||
        e.timestamp ||
        e.started_at ||
        e.startTime ||
        e.created_at ||
        e.time;

      if (!ts) return;

      const d = new Date(ts);
      if (Number.isNaN(d.getTime())) return;

      grid[d.getDay()][d.getHours()] += 1;
    });

    const max = Math.max(...grid.flat(), 1);

    host.innerHTML = `
      <div class="trr-heatmap-grid">
        <div class="trr-heatmap-corner"></div>
        ${Array.from({ length: 24 }, (_, h) => `<div class="trr-heatmap-hour">${h}</div>`).join("")}
        ${grid.map((row, dayIdx) => `
          <div class="trr-heatmap-day">${days[dayIdx]}</div>
          ${row.map(v => {
      const a = v === 0 ? 0.06 : 0.12 + (v / max) * 0.88;
      return `<div class="trr-heatmap-cell" title="${days[dayIdx]} ${String(
        row.indexOf(v)
      ).padStart(2, "0")}:00 • ${v} plays" style="background:rgba(74,222,180,${a})"></div>`;
    }).join("")}
        `).join("")}
      </div>
    `;
  }

  function bindEvents(host) {
    host.querySelectorAll("[data-tab]").forEach(btn => {
      if (btn._bound) return;
      btn._bound = true;
      btn.addEventListener("click", () => {
        _activeTab = btn.dataset.tab;
        render(host);
      });
    });

    host.querySelectorAll("[data-range]").forEach(btn => {
      if (btn._bound) return;
      btn._bound = true;
      btn.addEventListener("click", () => {
        _histRange = num(btn.dataset.range, 30);
        render(host);
      });
    });

    host.querySelectorAll("[data-metric]").forEach(btn => {
      if (btn._bound) return;
      btn._bound = true;
      btn.addEventListener("click", () => {
        _histMetric = btn.dataset.metric;
        render(host);
      });
    });
  }

  function render(host) {
    if (!host) return;
    const scrollY = window.scrollY;
    host.innerHTML = buildWidget();
    bindEvents(host);
    mountCharts();
    _rendered = true;
    window.scrollTo({ top: scrollY, behavior: "instant" });
  }

  async function refresh() {
    const group = findGroupContainer(TRACEARR_CONFIG.groupName);
    if (!group) return;

    const host = ensureHost(group);

    try {
      await fetchAll();
      render(host);
    } catch (err) {
      console.error("[TracearrWidget]", err);
      host.innerHTML = `
        <div class="trr-shell">
          <div class="trr-card">
            <div class="trr-empty">Unable to load Tracearr data.</div>
          </div>
        </div>
      `;
    }
  }

  function startPolling() {
    if (_pollTimer) clearInterval(_pollTimer);
    _pollTimer = setInterval(refresh, TRACEARR_CONFIG.pollMs);
  }

  function init() {
    const boot = () => {
      refresh();
      startPolling();
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", boot, { once: true });
    } else {
      boot();
    }

    const mo = new MutationObserver(() => {
      const group = findGroupContainer(TRACEARR_CONFIG.groupName);
      if (group && !_rendered) refresh();
    });

    mo.observe(document.body, { childList: true, subtree: true });
  }

  init();
})();

