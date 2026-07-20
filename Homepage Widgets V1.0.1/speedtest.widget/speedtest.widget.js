/* =====================================================
   SPEEDTEST TRACKER MONITOR WIDGET
   Shows latest results + triggers new tests per node
   Group name: SPEEDTEST-MONITOR
===================================================== */
(function () {

  const SPT_CONFIG = {
    groupName: "SPEEDTEST-MONITOR",
    pollMs: 5 * 60 * 1000,
    nodes: [
      {
        name: "Speedtest Node 1",
        url: "http://YOUR_LOCAL_IP:PORT",
        fallbackUrl: "https://YOUR_TUNNEL_URL", // or null if not using a tunnel
        activeUrl: null,
        key: "YOUR_API_KEY_HERE",
        color: "#22c55e"
      },
    ]
  };

  /* ── State ── */
  const _nodeData = {};
  const _nodeHist = {};
  const _nodeState = {};
  const _errTimers = {};   // FIX: track error-reset timers to avoid corrupting "running" state
  const _nodeBackoffUntil = {};
  let _rendering = false;
  let _obsDelay = null;
  let _lastUpdated = null;
  let _refreshing = false; // FIX: flag for in-progress poll refresh

  /* ── Utilities ── */
  function normText(v) { return (v || "").replace(/\s+/g, " ").trim(); }
  function escH(s = "") {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /* ── FIX: single shared abortable-fetch helper (replaces duplicate sptFetch) ── */
  function makeSignal(ms) {
    // FIX: AbortSignal.timeout() has limited browser support; use AbortController instead
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    return { signal: ctrl.signal, clear: () => clearTimeout(timer) };
  }

  async function sptFetch(node, path, options = {}, timeoutMs = 8000) {
    const candidates = [];
    if (node.activeUrl) candidates.push(node.activeUrl);
    if (!candidates.includes(node.url)) candidates.push(node.url);
    if (node.fallbackUrl && !candidates.includes(node.fallbackUrl)) candidates.push(node.fallbackUrl);

    let lastErr = null;
    for (const base of candidates) {
      const { signal, clear } = makeSignal(timeoutMs);
      try {
        const res = await fetch(`${base}${path}`, { ...options, signal });
        clear();
        if (res.status === 429) {
          _nodeBackoffUntil[node.name] = Date.now() + 15 * 60 * 1000;
          throw new Error(`${node.name} HTTP 429 rate limited`);
        }
        if (!res.ok) throw new Error(`${node.name} HTTP ${res.status}`);
        node.activeUrl = base;
        return res;
      } catch (err) {
        clear();
        // FIX: log every failed candidate, not just the last one
        console.warn(`[SptWidget] ${node.name} failed on ${base}:`, err.message);
        lastErr = err;
      }
    }
    throw lastErr || new Error(`All URLs failed for ${node.name}`);
  }

  function findGroupContainer() {
    const hd = Array.from(
      document.querySelectorAll("h2,h3,.group-title,.service-group-name")
    ).find(el => normText(el.textContent) === SPT_CONFIG.groupName);
    if (!hd) return null;
    return (
      hd.closest("section") ||
      hd.closest("div[class*='group']") ||
      hd.parentElement?.parentElement ||
      hd.parentElement
    );
  }

  function ensureHost(group) {
    let row = group.querySelector(".hp-widget-row, .spt-flex-row");
    if (!row) {
      const list = group.querySelector("ul.services-list, ul");
      if (list) list.style.display = "none";
      row = document.createElement("div");
      row.className = "hp-widget-row spt-flex-row";
      group.appendChild(row);
    } else {
      row.classList.add("hp-widget-row", "spt-flex-row");
    }
    let host = row.querySelector(".spt-monitor-host");
    if (host) return host;
    host = document.createElement("div");
    host.className = "spt-monitor-host";
    row.appendChild(host);
    return host;
  }

  function getHost() {
    const g = findGroupContainer();
    return g ? g.querySelector(".spt-monitor-host") : null;
  }

  /* ── API ── */
  async function fetchLatestResult(node) {
    const res = await sptFetch(node, `/api/v1/results?per_page=1&sort=-created_at`, {
      headers: {
        "Authorization": `Bearer ${node.key}`,
        "Accept": "application/json"
      }
    });
    const data = await res.json();
    return (data?.data ?? [])[0] ?? null;
  }

  async function fetchHistory(node) {
    const res = await sptFetch(node, `/api/v1/results?per_page=10&sort=-created_at`, {
      headers: {
        "Authorization": `Bearer ${node.key}`,
        "Accept": "application/json"
      }
    });
    const data = await res.json();
    return (data?.data ?? [])
      .map(r => parseFloat(r?.download ?? 0))
      .filter(v => v > 0)
      .reverse();
  }

  async function triggerTest(node) {
    // FIX: use sptFetch with a 120s timeout so intermediate failures are logged
    const res = await sptFetch(
      node,
      `/api/v1/speedtests/run`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${node.key}`,
          "Accept": "application/json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ serverId: 35180 })
      },
      120000
    );

    // FIX: capture triggeredAt AFTER the trigger call resolves, not before
    const triggeredAt = new Date();
    const deadline = Date.now() + 120000;

    await new Promise(r => setTimeout(r, 10000));

    while (Date.now() < deadline) {
      const latest = await fetchLatestResult(node).catch(() => null);
      if (latest?.created_at && new Date(latest.created_at) >= triggeredAt) {
        return latest;
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    return null;
  }

  /* ── Parse result ── */
  function parseResult(raw) {
    if (!raw) return null;
    return {
      download: parseFloat(raw.download ?? 0),
      upload: parseFloat(raw.upload ?? 0),
      ping: parseFloat(raw.ping ?? 0),
      jitter: parseFloat(raw.data?.ping?.jitter ?? raw.data?.jitter ?? 0),
      isp: raw.data?.isp ?? "",
      server: raw.data?.server?.name ?? raw.data?.server?.host ?? "",
      result_url: raw.data?.result?.url ?? "",
      created_at: raw.created_at ?? "",
    };
  }

  function timeAgo(isoStr) {
    if (!isoStr) return "";
    const diff = Math.floor((Date.now() - new Date(isoStr)) / 1000);
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  function fmtSpeed(val) {
    // FIX: guard against negative or zero before multiplying
    if (val == null || isNaN(val) || val <= 0) return "—";
    const bps = val * 8;
    if (bps >= 1e9) return (bps / 1e9).toFixed(2);
    if (bps >= 1e6) return (bps / 1e6).toFixed(1);
    return (bps / 1e3).toFixed(0);
  }

  function speedUnit(val) {
    if (val == null || isNaN(val) || val <= 0) return "bps";
    const bps = val * 8;
    if (bps >= 1e9) return "Gbps";
    if (bps >= 1e6) return "Mbps";
    return "Kbps";
  }

  /* ── HTML builders ── */
  function buildCard(node) {
    const state = _nodeState[node.name] || "idle";
    const result = _nodeData[node.name] || null;
    const hist = _nodeHist[node.name] || [];
    const running = state === "running";
    const errored = state === "err";

    const dotColor = running ? "#3b82f6" : errored ? "#ef4444" : result ? "#22c55e" : "rgba(255,255,255,0.25)";
    const dotAnimation = running ? `animation:spt-pulse 1s ease-in-out infinite;` : "";

    const dl = result?.download;
    const ul = result?.upload;
    const ping = result?.ping;
    const jitter = result?.jitter;

    const maxV = hist.length ? Math.max(...hist, 1) : 1;
    const barHtml = hist.length
      ? hist.map(v => {
        const h = Math.max(3, Math.round((v / maxV) * 28));
        return `<div style="flex:1;border-radius:2px;height:${h}px;background:${escH(node.color)};opacity:0.55;min-width:4px;"></div>`;
      }).join("")
      : Array(8).fill(`<div style="flex:1;border-radius:2px;height:3px;background:rgba(255,255,255,0.08);min-width:4px;"></div>`).join("");

    const badgeBg = running ? "rgba(59,130,246,0.15)" : errored ? "rgba(239,68,68,0.12)" : result ? "rgba(34,197,94,0.12)" : "rgba(255,255,255,0.06)";
    const badgeColor = running ? "#93c5fd" : errored ? "#fca5a5" : result ? "#86efac" : "rgba(255,255,255,0.38)";
    const badgeBorder = running ? "rgba(59,130,246,0.30)" : errored ? "rgba(239,68,68,0.25)" : result ? "rgba(34,197,94,0.25)" : "rgba(255,255,255,0.09)";
    const badgeTxt = running ? "Running test…" : errored ? "Test failed" : result ? `Result · ${timeAgo(result.created_at)}` : "No data yet";

    const btnDisabled = running ? "disabled" : "";
    const btnText = running ? "Testing…" : "Run test";
    const btnStyle = running ? `border-color:rgba(59,130,246,0.45);color:#93c5fd;` : "";

    const detailRows = [
      jitter > 0
        ? `<span style="font-size:11px;color:rgba(255,255,255,0.30);">Jitter ${Math.round(jitter)} ms</span>`
        : "",
      result?.server
        ? `<span style="font-size:11px;color:rgba(255,255,255,0.28);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:140px;" title="${escH(result.server)}">${escH(result.server)}</span>`
        : "",
    ].filter(Boolean).join(`<span style="color:rgba(255,255,255,0.18);margin:0 4px">·</span>`);

    const resultLink = result?.result_url
      ? `<a href="${escH(result.result_url)}" target="_blank" rel="noopener"
            style="font-size:11px;color:rgba(255,255,255,0.35);text-decoration:none;display:inline-flex;align-items:center;gap:3px;transition:color 0.14s;"
            onmouseover="this.style.color='rgba(255,255,255,0.72)'" onmouseout="this.style.color='rgba(255,255,255,0.35)'">
           Full results ↗
         </a>`
      : "";

    return `
      <div class="spt-card" data-node="${escH(node.name)}">
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="width:8px;height:8px;border-radius:50%;flex-shrink:0;background:${escH(dotColor)};${dotAnimation}display:inline-block;box-shadow:0 0 6px ${escH(dotColor)}90;"></span>
            <span style="font-size:0.88rem;font-weight:700;color:rgba(255,255,255,0.90);">${escH(node.name)}</span>
          </div>
          <a href="${escH(node.url)}" target="_blank" rel="noopener" class="spt-open-link">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
              <polyline points="15 3 21 3 21 9"></polyline>
              <line x1="10" y1="14" x2="21" y2="3"></line>
            </svg>
            Open
          </a>
        </div>

        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;">
          <div style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:10px 8px;text-align:center;">
            <div style="font-size:1.1rem;font-weight:750;color:#22c55e;font-variant-numeric:tabular-nums;white-space:nowrap;line-height:1.1;">${fmtSpeed(dl)}</div>
            <div style="font-size:0.62rem;color:rgba(255,255,255,0.38);margin-top:2px;">${speedUnit(dl)}</div>
            <div style="font-size:0.60rem;color:rgba(255,255,255,0.25);text-transform:uppercase;letter-spacing:0.05em;">download</div>
          </div>
          <div style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:10px 8px;text-align:center;">
            <div style="font-size:1.1rem;font-weight:750;color:#3b82f6;font-variant-numeric:tabular-nums;white-space:nowrap;line-height:1.1;">${fmtSpeed(ul)}</div>
            <div style="font-size:0.62rem;color:rgba(255,255,255,0.38);margin-top:2px;">${speedUnit(ul)}</div>
            <div style="font-size:0.60rem;color:rgba(255,255,255,0.25);text-transform:uppercase;letter-spacing:0.05em;">upload</div>
          </div>
          <div style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:10px 8px;text-align:center;">
            <div style="font-size:1.1rem;font-weight:750;color:#f59e0b;font-variant-numeric:tabular-nums;white-space:nowrap;line-height:1.1;">${ping != null && !isNaN(ping) ? Math.round(ping) : "—"}</div>
            <div style="font-size:0.62rem;color:rgba(255,255,255,0.38);margin-top:2px;">ms</div>
            <div style="font-size:0.60rem;color:rgba(255,255,255,0.25);text-transform:uppercase;letter-spacing:0.05em;">ping</div>
          </div>
        </div>

        <div style="display:flex;gap:3px;align-items:flex-end;height:32px;" title="Recent download speeds (oldest → newest)">
          ${barHtml}
        </div>

        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span style="display:inline-flex;align-items:center;gap:4px;padding:2px 9px;
                       border-radius:20px;font-size:0.68rem;font-weight:600;
                       background:${escH(badgeBg)};color:${escH(badgeColor)};
                       border:1px solid ${escH(badgeBorder)};">
            ${escH(badgeTxt)}
          </span>
          ${detailRows}
        </div>

        <div style="display:flex;align-items:flex-end;justify-content:space-between;
                    padding-top:8px;border-top:1px solid rgba(255,255,255,0.07);gap:8px;">
          <div style="min-width:0;display:flex;flex-direction:column;gap:2px;">
            ${result?.isp ? `<div style="font-size:0.72rem;color:rgba(255,255,255,0.50);">${escH(result.isp)}</div>` : ""}
            ${resultLink}
          </div>
          <button class="spt-run-btn" data-run="${escH(node.name)}" ${btnDisabled}
                  style="${btnStyle}${btnDisabled ? "opacity:.45;cursor:not-allowed;" : ""}">
            ${running
        ? `<svg style="animation:spt-pulse 1s ease-in-out infinite;flex-shrink:0;" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>`
        : `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`}
            ${escH(btnText)}
          </button>
        </div>
      </div>`;
  }

  function buildShell() {
    // FIX: show "Refreshing…" during active poll so the timestamp isn't silently stale
    const ts = _refreshing
      ? "Refreshing…"
      : _lastUpdated
        ? `Updated ${_lastUpdated.toLocaleTimeString()}`
        : "Loading…";

    const cards = SPT_CONFIG.nodes.map(buildCard).join("");

    return `
      <div class="spt-shell">
        <div class="spt-header">
          <div class="spt-header-left">
            <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/webp/speedtest-tracker.webp"
                 alt="Speedtest Tracker" class="spt-icon">
            <span class="spt-title">Speedtest Tracker</span>
          </div>
          <div style="display:flex;align-items:center;gap:10px;">
            <span id="spt-ts" class="spt-timestamp">${escH(ts)}</span>
            <button id="spt-run-all" class="spt-run-all-btn">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
              Run all
            </button>
          </div>
        </div>

        <div class="spt-grid" id="spt-grid">
          ${cards}
        </div>

        <div class="spt-footer">Speedtest Tracker · ${escH(ts)}</div>
      </div>`;
  }

  // FIX: accept an optional pre-resolved host element to avoid a redundant DOM re-query
  function paint(host) {
    const el = host || getHost();
    if (!el) return;
    el.innerHTML = buildShell();
    bindEvents(el);
  }

  function bindEvents(host) {
    // Note: _sptBound guard removed — paint() replaces innerHTML each time so
    // every button here is always a fresh node; the guard was always a no-op.
    host.querySelectorAll(".spt-run-btn[data-run]").forEach(btn => {
      btn.addEventListener("click", () => {
        const name = btn.dataset.run;
        const node = SPT_CONFIG.nodes.find(n => n.name === name);
        if (node) runNodeTest(node);
      });
    });

    const allBtn = host.querySelector("#spt-run-all");
    if (allBtn) {
      allBtn.addEventListener("click", () => runAllTests());
    }
  }

  /* ── Run a single node test ── */
  async function runNodeTest(node) {
    if (_nodeState[node.name] === "running") return;
    _nodeState[node.name] = "running";
    paint();

    try {
      const raw = await triggerTest(node);
      const result = parseResult(raw);
      if (result) {
        _nodeData[node.name] = result;
        if (!_nodeHist[node.name]) _nodeHist[node.name] = [];
        if (result.download > 0) {
          _nodeHist[node.name].push(result.download);
          if (_nodeHist[node.name].length > 10) _nodeHist[node.name].shift();
        }
      }
      _nodeState[node.name] = "idle";
      _lastUpdated = new Date();
    } catch (err) {
      console.error(`[SptWidget] ${node.name} test failed:`, err);
      _nodeState[node.name] = "err";

      // FIX: cancel any existing error-reset timer before starting a new one
      // so a rapid re-trigger can't corrupt a legitimate "running" state
      if (_errTimers[node.name]) clearTimeout(_errTimers[node.name]);
      _errTimers[node.name] = setTimeout(() => {
        delete _errTimers[node.name];
        if (_nodeState[node.name] === "err") {
          _nodeState[node.name] = "idle";
          paint();
        }
      }, 5000);
    }

    paint();
  }

  /* ── Run all tests (staggered by 2 s) ── */
  function runAllTests() {
    SPT_CONFIG.nodes.forEach((node, i) => {
      if (_nodeState[node.name] === "running") return;
      setTimeout(() => runNodeTest(node), i * 2000);
    });
  }

  /* ── Refresh all data (poll) ── */
  async function refreshAll() {
    _refreshing = true;
    paint();

    await Promise.allSettled(SPT_CONFIG.nodes.map(async node => {
      try {
        const backoffUntil = _nodeBackoffUntil[node.name] || 0;
        if (backoffUntil > Date.now()) {
          const mins = Math.ceil((backoffUntil - Date.now()) / 60000);
          throw new Error(`rate-limit cooldown ${mins}m`);
        }
        const [raw, hist] = await Promise.all([
          fetchLatestResult(node),
          fetchHistory(node)
        ]);
        const result = parseResult(raw);
        if (result) _nodeData[node.name] = result;
        if (hist.length) _nodeHist[node.name] = hist.slice(-10);
        if (_nodeState[node.name] !== "running") _nodeState[node.name] = "idle";
      } catch (err) {
        console.warn(`[SptWidget] ${node.name} fetch failed:`, err.message);
        if (_nodeState[node.name] !== "running") _nodeState[node.name] = "err";
        // FIX: cancel any existing timer before setting a new one
        if (_errTimers[node.name]) clearTimeout(_errTimers[node.name]);
        _errTimers[node.name] = setTimeout(() => {
          delete _errTimers[node.name];
          if (_nodeState[node.name] === "err") {
            _nodeState[node.name] = "idle";
            paint();
          }
        }, 30000);
      }
    }));

    _lastUpdated = new Date();
    _refreshing = false;
    paint();
  }

  /* ── Render entrypoint ── */
  async function render() {
    if (_rendering) return;
    _rendering = true;
    try {
      const group = findGroupContainer();
      if (!group) return;
      // FIX: pass the resolved host directly into paint() to avoid a redundant DOM re-query
      const host = ensureHost(group);
      paint(host);
      await refreshAll();
    } catch (err) {
      console.error("[SptWidget] Render error:", err);
    } finally {
      setTimeout(() => { _rendering = false; }, 2000);
    }
  }

  /* ── Init ── */
  function init() {
    const start = () => {
      setTimeout(render, 1200);
      setInterval(refreshAll, SPT_CONFIG.pollMs);
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }

    new MutationObserver(() => {
      if (_obsDelay || document.querySelector(".spt-monitor-host .spt-card")) return;
      _obsDelay = setTimeout(() => { _obsDelay = null; render(); }, 700);
    }).observe(document.body, { childList: true, subtree: true });
  }

  init();
})();
