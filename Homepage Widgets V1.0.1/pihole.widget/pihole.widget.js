/* =====================================================
   PI-HOLE CONTROL WIDGET
   - Per-instance DNS stats + enable/disable controls
   - Group name: PIHOLE-CONTROL
===================================================== */
(function () {
  const PH_CONFIG = {
    groupName: "PIHOLE-CONTROL",
    pollMs: 120 * 1000,
    debug: false,
    instances: [
      {
        id: "pihole1",
        label: "Pi-hole",
        primaryUrl: "http://YOUR_PIHOLE_IP",
        fallbackUrl: null, // or "https://YOUR_TUNNEL_URL" if using a tunnel
        password: "YOUR_PIHOLE_WEB_OR_APP_PASSWORD",
        hrefPrimary: "http://YOUR_PIHOLE_IP/admin",
        hrefFallback: null,
        activeUrl: null,
        activeHref: null
      }
    ],
    pauseDurations: [
      { label: "30 sec", seconds: 30 },
      { label: "1 min", seconds: 60 },
      { label: "5 min", seconds: 5 * 60 },
      { label: "15 min", seconds: 15 * 60 },
      { label: "30 min", seconds: 30 * 60 },
      { label: "1 hour", seconds: 60 * 60 },
      { label: "Until re-enabled", seconds: 0 }
    ]
  };

  const _pauseTimers = {};
  const _pauseEndsAt = {};
  const _sessions = {};
  const _authBackoffUntil = {};
  const _authInFlight = {};

  function log(...a) { if (PH_CONFIG.debug) console.log("[PiHole]", ...a); }

  function esc(s = "") {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function normText(v) { return (v || "").replace(/\s+/g, " ").trim(); }
  function getInstKey(inst) { return inst.id || inst.label; }
  function getInstHref(inst) { return inst.activeHref || inst.hrefPrimary || inst.hrefFallback || "#"; }
  function backoffKey(instKey) { return `ph-auth-backoff:${instKey}`; }

  function getAuthBackoff(instKey) {
    const mem = _authBackoffUntil[instKey] || 0;
    const stored = Number(localStorage.getItem(backoffKey(instKey)) || 0);
    return Math.max(mem, Number.isFinite(stored) ? stored : 0);
  }

  function setAuthBackoff(instKey, until) {
    _authBackoffUntil[instKey] = until;
    localStorage.setItem(backoffKey(instKey), String(until));
  }

  function clearAuthBackoff(instKey) {
    delete _authBackoffUntil[instKey];
    localStorage.removeItem(backoffKey(instKey));
  }

  function apiBase(url) {
    return String(url || "").replace(/\/admin\/?$/, "").replace(/\/$/, "") + "/api";
  }

  function getTargets(inst) {
    const targets = [];
    if (inst.activeUrl) targets.push({ url: inst.activeUrl, href: inst.activeHref || inst.activeUrl });
    if (inst.primaryUrl && inst.primaryUrl !== inst.activeUrl) targets.push({ url: inst.primaryUrl, href: inst.hrefPrimary || inst.primaryUrl });
    if (inst.fallbackUrl && inst.fallbackUrl !== inst.activeUrl) targets.push({ url: inst.fallbackUrl, href: inst.hrefFallback || inst.fallbackUrl });
    return targets;
  }

  async function phAuth(inst, timeout = 8000) {
    const instKey = getInstKey(inst);
    const current = _sessions[instKey];
    if (current?.sid && current.expiresAt > Date.now() + 30 * 1000) return current;
    const backoffUntil = getAuthBackoff(instKey);
    if (backoffUntil > Date.now()) {
      const mins = Math.ceil((backoffUntil - Date.now()) / 60000);
      throw new Error(`Pi-hole auth rate limited; retrying in ${mins}m`);
    }
    if (_authInFlight[instKey]) return _authInFlight[instKey];

    _authInFlight[instKey] = phAuthFresh(inst, timeout).finally(() => {
      delete _authInFlight[instKey];
    });
    return _authInFlight[instKey];
  }

  async function phAuthFresh(inst, timeout = 8000) {
    const instKey = getInstKey(inst);
    const targets = getTargets(inst);
    let lastErr = null;

    for (const target of targets) {
      try {
        const res = await fetch(`${apiBase(target.url)}/auth`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: inst.password || "" }),
          signal: AbortSignal.timeout(timeout)
        });
        if (res.status === 429) {
          setAuthBackoff(instKey, Date.now() + 15 * 60 * 1000);
          throw new Error("Pi-hole auth rate limited; retrying in 15m");
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const session = data?.session || {};
        if (!session.valid || !session.sid) throw new Error("Pi-hole auth failed");

        inst.activeUrl = target.url;
        inst.activeHref = target.href;
        clearAuthBackoff(instKey);
        _sessions[instKey] = {
          sid: session.sid,
          csrf: session.csrf || "",
          expiresAt: Date.now() + Math.max(60, num(session.validity || 300) - 20) * 1000
        };
        return _sessions[instKey];
      } catch (err) {
        if (err?.name === "TypeError" || /NetworkError|Failed to fetch|Load failed/i.test(err?.message || "")) {
          setAuthBackoff(instKey, Date.now() + 15 * 60 * 1000);
          err = new Error("Pi-hole auth blocked by CORS or rate limited; retrying in 15m");
        }
        lastErr = err;
      }
    }

    throw lastErr || new Error("Pi-hole auth failed");
  }

  async function phRequest(inst, path, options = {}, timeout = 8000, retry = true) {
    const session = await phAuth(inst, timeout);
    const res = await fetch(`${apiBase(inst.activeUrl || inst.primaryUrl)}${path}`, {
      ...options,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-FTL-SID": session.sid,
        ...(session.csrf ? { "X-FTL-CSRF": session.csrf } : {}),
        ...(options.headers || {})
      },
      signal: AbortSignal.timeout(timeout)
    });

    if ((res.status === 401 || res.status === 403) && retry) {
      delete _sessions[getInstKey(inst)];
      return phRequest(inst, path, options, timeout, false);
    }

    if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
    if (res.status === 204) return {};
    return res.json();
  }

  async function phGet(inst, path) {
    return phRequest(inst, path);
  }

  async function phPost(inst, path, body = {}) {
    return phRequest(inst, path, {
      method: "POST",
      body: JSON.stringify(body)
    });
  }

  function findGroupContainer() {
    const hd = Array.from(document.querySelectorAll("h2,h3,.group-title,.service-group-name"))
      .find(el => normText(el.textContent) === PH_CONFIG.groupName);
    if (!hd) return null;
    return hd.closest("section")
      || hd.closest("div[class*='group']")
      || hd.parentElement?.parentElement
      || hd.parentElement;
  }

  function ensureHost(group) {
    let row = group.querySelector(".hp-widget-row, .ph-flex-row");
    if (!row) {
      const list = group.querySelector("ul.services-list, ul");
      if (list) list.style.display = "none";
      row = document.createElement("div");
      row.className = "hp-widget-row ph-flex-row";
      group.appendChild(row);
    } else {
      row.classList.add("hp-widget-row", "ph-flex-row");
    }

    let host = row.querySelector(".ph-control-host");
    if (host) return host;
    host = document.createElement("div");
    host.className = "ph-control-host";
    row.appendChild(host);
    return host;
  }

  function num(v) {
    const n = Number(String(v ?? 0).replace(/,/g, ""));
    return Number.isFinite(n) ? n : 0;
  }

  function fmtInt(v) { return num(v).toLocaleString(); }
  function fmtPct(v) { return `${num(v).toFixed(1)}%`; }

  function fmtRemaining(ms) {
    if (ms <= 0) return "00:00";
    const s = Math.ceil(ms / 1000);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }

  function startCountdown(instKey) {
    clearInterval(_pauseTimers[instKey]);
    _pauseTimers[instKey] = setInterval(() => {
      const el = document.querySelector(
        `.ph-instance-card[data-inst-key="${CSS.escape(instKey)}"] .ph-pause-countdown`
      );
      if (!el) {
        clearInterval(_pauseTimers[instKey]);
        return;
      }
      const remaining = (_pauseEndsAt[instKey] || 0) - Date.now();
      if (remaining <= 0) {
        clearInterval(_pauseTimers[instKey]);
        delete _pauseEndsAt[instKey];
        renderPiHoleControl();
      } else {
        el.textContent = `Re-enables in ${fmtRemaining(remaining)}`;
      }
    }, 1000);
  }

  async function fetchInstance(inst) {
    const [summary, blocking, topItems, topClients] = await Promise.all([
      phGet(inst, "/stats/summary"),
      phGet(inst, "/dns/blocking").catch(() => ({})),
      phGet(inst, "/stats/top_domains?blocked=true&count=5").catch(() => ({})),
      phGet(inst, "/stats/top_clients?count=5").catch(() => ({}))
    ]);
    log(inst.label, summary);
    return { summary, blocking, topItems, topClients };
  }

  async function setFiltering(inst, enabled, seconds = 0) {
    const body = enabled
      ? { blocking: true }
      : { blocking: false, timer: seconds > 0 ? seconds : null };
    return phPost(inst, "/dns/blocking", body);
  }

  function topList(obj, key, nameKeys = []) {
    const source = obj?.[key] || obj?.domains || obj?.clients || obj?.top_domains || obj?.top_clients || {};
    if (Array.isArray(source)) {
      return source.slice(0, 5).map(item => ({
        name: nameKeys.map(k => item?.[k]).find(Boolean) || item?.name || item?.domain || item?.client || "Unknown",
        count: num(item?.count ?? item?.queries ?? item?.blocked ?? 0)
      }));
    }
    return Object.entries(source)
      .slice(0, 5)
      .map(([name, count]) => ({ name, count: num(count) }));
  }

  function buildMiniList(title, items) {
    if (!items.length) {
      return `
        <div class="ph-mini-list">
          <div class="ph-mini-title">${esc(title)}</div>
          <div class="ph-mini-empty">No data</div>
        </div>`;
    }

    const max = Math.max(...items.map(i => i.count), 1);
    return `
      <div class="ph-mini-list">
        <div class="ph-mini-title">${esc(title)}</div>
        ${items.map(item => `
          <div class="ph-mini-row" title="${esc(item.name)}">
            <span class="ph-mini-name">${esc(item.name)}</span>
            <span class="ph-mini-count">${fmtInt(item.count)}</span>
            <span class="ph-mini-bar"><span style="width:${Math.max(8, (item.count / max) * 100)}%"></span></span>
          </div>`).join("")}
      </div>`;
  }

  function buildPauseControl(instKey, enabled) {
    const durOptions = PH_CONFIG.pauseDurations.map((d, i) =>
      `<option value="${i}">${esc(d.label)}</option>`
    ).join("");

    if (!enabled) {
      const remaining = (_pauseEndsAt[instKey] || 0) - Date.now();
      return `
        <div class="ph-pause-section">
          <div class="ph-pause-active">
            <span class="ph-pause-dot"></span>
            <span class="ph-pause-countdown">${remaining > 0 ? `Re-enables in ${fmtRemaining(remaining)}` : "Filtering disabled"}</span>
          </div>
          <button class="ph-resume-btn" data-inst-key="${esc(instKey)}">Re-enable now</button>
        </div>`;
    }

    return `
      <div class="ph-pause-section">
        <div class="ph-pause-row">
          <span class="ph-pause-label">Disable filtering</span>
          <div class="ph-pause-controls">
            <select class="ph-pause-select" data-inst-key="${esc(instKey)}">${durOptions}</select>
            <button class="ph-pause-btn" data-inst-key="${esc(instKey)}">Pause</button>
          </div>
        </div>
      </div>`;
  }

  function buildInstanceCard(inst, data) {
    const instKey = getInstKey(inst);
    const instHref = getInstHref(inst);

    if (!data || data.error) {
      return `
        <div class="ph-instance-card ph-instance-card--offline" data-inst-key="${esc(instKey)}">
          <div class="ph-inst-header">
            <div class="ph-inst-left">
              <span class="ph-inst-dot ph-inst-dot--off"></span>
              <span class="ph-inst-name">${esc(inst.label)}</span>
            </div>
            <a class="ph-inst-link" href="${esc(instHref)}" target="_blank" rel="noopener noreferrer">Open</a>
          </div>
          <div class="ph-inst-error">${esc(data?.message || "Offline, blocked by CORS, or password rejected")}</div>
        </div>`;
    }

    const { summary, blocking, topItems, topClients } = data;
    const enabled = String(blocking.blocking || summary.status || "").toLowerCase() !== "disabled";
    const queries = summary.queries?.total ?? summary.dns_queries_today ?? summary.dns_queries_all_types ?? 0;
    const blocked = summary.queries?.blocked ?? summary.ads_blocked_today ?? 0;
    const pctBlocked = summary.queries?.percent_blocked ?? summary.ads_percentage_today ?? 0;
    const domains = summary.gravity?.domains_being_blocked ?? summary.domains_being_blocked ?? 0;
    const clients = summary.clients?.active ?? summary.clients?.total ?? summary.unique_clients ?? summary.clients_ever_seen ?? 0;
    const topBlocked = topList(topItems, "domains", ["domain", "name"]);
    const clientList = topList(topClients, "clients", ["client", "name", "ip"]);

    return `
      <div class="ph-instance-card${enabled ? "" : " ph-instance-card--paused"}" data-inst-key="${esc(instKey)}">
        <div class="ph-inst-header">
          <div class="ph-inst-left">
            <span class="ph-inst-dot ${enabled ? "ph-inst-dot--on" : "ph-inst-dot--paused"}"></span>
            <span class="ph-inst-name">${esc(inst.label)}</span>
          </div>
          <a class="ph-inst-link" href="${esc(instHref)}" target="_blank" rel="noopener noreferrer">Open</a>
        </div>

        <div class="ph-stats-row">
          <div class="ph-stat"><div class="ph-stat-val">${fmtInt(queries)}</div><div class="ph-stat-lbl">Queries</div></div>
          <div class="ph-stat"><div class="ph-stat-val ph-warn">${fmtInt(blocked)}</div><div class="ph-stat-lbl">Blocked</div></div>
          <div class="ph-stat"><div class="ph-stat-val ph-orange">${fmtPct(pctBlocked)}</div><div class="ph-stat-lbl">Block Rate</div></div>
          <div class="ph-stat"><div class="ph-stat-val ph-green">${fmtInt(domains)}</div><div class="ph-stat-lbl">Blocklist</div></div>
        </div>

        <div class="ph-meta-row">
          <span>${fmtInt(clients)} clients</span>
          <span>${enabled ? "Filtering enabled" : "Filtering paused"}</span>
        </div>

        <div class="ph-divider"></div>

        <div class="ph-lists-grid">
          ${buildMiniList("Top Blocked", topBlocked)}
          ${buildMiniList("Top Clients", clientList)}
        </div>

        <div class="ph-divider"></div>
        ${buildPauseControl(instKey, enabled)}
      </div>`;
  }

  function buildShell(inner) {
    return `
      <div class="ph-shell">
        <div class="ph-shell-header">
          <div class="ph-shell-header-left">
            <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/webp/pi-hole.webp"
                 alt="Pi-hole" class="ph-icon">
            <div class="ph-shell-title">Pi-hole</div>
          </div>
          <div class="ph-shell-ts" id="ph-ts"></div>
        </div>
        <div class="ph-cards-grid">${inner}</div>
      </div>`;
  }

  function buildSkeleton() {
    return `<div class="ph-skeleton-wrap">${PH_CONFIG.instances.map(() =>
      `<div class="ph-skeleton-card"></div>`).join("")}</div>`;
  }

  async function renderPiHoleControl() {
    const group = findGroupContainer();
    if (!group) return;
    const host = ensureHost(group);

    if (!host.querySelector(".ph-shell")) host.innerHTML = buildShell(buildSkeleton());

    const results = await Promise.allSettled(PH_CONFIG.instances.map(inst => fetchInstance(inst)));
    const cards = PH_CONFIG.instances.map((inst, i) => {
      const r = results[i];
      if (r.status === "fulfilled") return buildInstanceCard(inst, r.value);
      console.error("[PiHole] fetch failed:", inst.label, r.reason);
      return buildInstanceCard(inst, {
        error: true,
        message: r.reason?.message || "Offline, blocked by CORS, or password rejected"
      });
    }).join("");

    host.innerHTML = buildShell(cards);
    const ts = host.querySelector("#ph-ts");
    if (ts) ts.textContent = `Updated ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true })}`;

    bindControls(host);
    PH_CONFIG.instances.forEach(inst => {
      const instKey = getInstKey(inst);
      if (_pauseEndsAt[instKey]) startCountdown(instKey);
    });
  }

  function bindControls(host) {
    host.querySelectorAll(".ph-pause-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const instKey = btn.dataset.instKey;
        const inst = PH_CONFIG.instances.find(i => getInstKey(i) === instKey);
        if (!inst) return;

        const select = host.querySelector(`.ph-pause-select[data-inst-key="${CSS.escape(instKey)}"]`);
        const dur = PH_CONFIG.pauseDurations[parseInt(select?.value || "0", 10)] || PH_CONFIG.pauseDurations[0];

        btn.disabled = true;
        btn.textContent = "Pausing...";
        try {
          await setFiltering(inst, false, dur.seconds);
          if (dur.seconds > 0) _pauseEndsAt[instKey] = Date.now() + (dur.seconds * 1000);
          else delete _pauseEndsAt[instKey];
          await renderPiHoleControl();
        } catch (err) {
          console.error("[PiHole] pause failed:", inst.label, err);
          btn.disabled = false;
          btn.textContent = "Pause";
        }
      });
    });

    host.querySelectorAll(".ph-resume-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const instKey = btn.dataset.instKey;
        const inst = PH_CONFIG.instances.find(i => getInstKey(i) === instKey);
        if (!inst) return;

        btn.disabled = true;
        btn.textContent = "Enabling...";
        try {
          await setFiltering(inst, true);
          clearInterval(_pauseTimers[instKey]);
          delete _pauseEndsAt[instKey];
          await renderPiHoleControl();
        } catch (err) {
          console.error("[PiHole] enable failed:", inst.label, err);
          btn.disabled = false;
          btn.textContent = "Re-enable now";
        }
      });
    });
  }

  function init() {
    const start = () => {
      setTimeout(renderPiHoleControl, 1800);
      setInterval(() => {
        if (!document.hidden) renderPiHoleControl();
      }, PH_CONFIG.pollMs);
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }

    const observer = new MutationObserver(() => {
      if (!document.querySelector(".ph-control-host .ph-shell")) {
        setTimeout(renderPiHoleControl, 500);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  init();
})();
