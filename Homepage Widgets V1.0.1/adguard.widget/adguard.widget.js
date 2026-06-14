/* =====================================================
   ADGUARD CONTROL WIDGET
   — Per-instance stats + filtering/safebrowsing/parental toggles
   — Disable protection with duration selector
   — Group name: ADGUARD - CONTROL
===================================================== */
(function () {
  const AGH_CONFIG = {
    groupName: "ADGUARD - CONTROL",
    pollMs: 120 * 1000,
    debug: false,
    instances: [
      {
        id: "agh1",
        label: "AdGuard Home 1",
        primaryUrl: "http://YOUR_LOCAL_IP:PORT",
        fallbackUrl: "https://YOUR_TUNNEL_URL", // or null if not using a tunnel
        user: "YOUR_USERNAME",
        pass: "YOUR_PASSWORD",
        hrefPrimary: "http://YOUR_LOCAL_IP:PORT", // or your TUNNEL_URL
        hrefFallback: "http://YOUR_TUNNEL_URL", // or your LOCAL_IP:PORT
        activeUrl: null,
        activeHref: null
      },
    ],
    pauseDurations: [
      { label: "30 sec", ms: 30 * 1000 },
      { label: "1 min", ms: 60 * 1000 },
      { label: "5 min", ms: 5 * 60 * 1000 },
      { label: "15 min", ms: 15 * 60 * 1000 },
      { label: "30 min", ms: 30 * 60 * 1000 },
      { label: "1 hour", ms: 60 * 60 * 1000 },
      { label: "Until re-enabled", ms: 0 }
    ]
  };

  const _pauseTimers = {};
  const _pauseEndsAt = {};

  function log(...a) {
    if (AGH_CONFIG.debug) console.log("[AGH]", ...a);
  }

  function escH(s = "") {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function normText(v) {
    return (v || "").replace(/\s+/g, " ").trim();
  }

  function authHeader(inst) {
    return {
      Authorization: "Basic " + btoa(`${inst.user}:${inst.pass}`),
      "Content-Type": "application/json"
    };
  }

  function getInstKey(inst) {
    return inst.id || inst.label;
  }

  function getInstHref(inst) {
    return inst.activeHref || inst.hrefPrimary || inst.hrefFallback || "#";
  }

  function getInstanceTargets(inst) {
    const targets = [];

    if (inst.activeUrl) {
      targets.push({
        url: inst.activeUrl,
        href: inst.activeHref || inst.hrefPrimary || inst.hrefFallback || inst.activeUrl
      });
    }

    if (inst.primaryUrl && inst.primaryUrl !== inst.activeUrl) {
      targets.push({
        url: inst.primaryUrl,
        href: inst.hrefPrimary || inst.primaryUrl
      });
    }

    if (inst.fallbackUrl && inst.fallbackUrl !== inst.activeUrl) {
      targets.push({
        url: inst.fallbackUrl,
        href: inst.hrefFallback || inst.fallbackUrl
      });
    }

    return targets;
  }

  async function aghRequest(inst, path, options = {}) {
    const targets = getInstanceTargets(inst);
    let lastErr = null;

    for (const target of targets) {
      try {
        const res = await fetch(`${target.url}${path}`, {
          ...options,
          headers: {
            ...authHeader(inst),
            ...(options.headers || {})
          },
          signal: (() => { const c = new AbortController(); setTimeout(() => c.abort(), 8000); return c.signal; })()
        });

        if (!res.ok) throw new Error(`${res.status} ${path}`);

        inst.activeUrl = target.url;
        inst.activeHref = target.href;
        return res;
      } catch (err) {
        lastErr = err;
      }
    }

    throw lastErr || new Error(`Request failed: ${path}`);
  }

  async function aghGet(inst, path) {
    const res = await aghRequest(inst, path);
    const text = await res.text();
    if (!text || !text.trim()) return {};
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  }

  async function aghPost(inst, path, body = {}) {
    const hasBody = body && Object.keys(body).length > 0;
    await aghRequest(inst, path, {
      method: "POST",
      body: hasBody ? JSON.stringify(body) : undefined
    });
    return true;
  }

  function findGroupContainer() {
    const hd = Array.from(document.querySelectorAll("h2,h3,.group-title,.service-group-name"))
      .find(el => normText(el.textContent) === AGH_CONFIG.groupName);
    if (!hd) return null;
    return hd.closest("section")
      || hd.closest("div[class*='group']")
      || hd.parentElement?.parentElement
      || hd.parentElement;
  }

  function ensureHost(group) {
    let row = group.querySelector(".agh-flex-row");
    if (!row) {
      const list = group.querySelector("ul.services-list, ul");
      if (list) list.style.display = "none";
      row = document.createElement("div");
      row.className = "agh-flex-row";
      group.appendChild(row);
    }
    let host = row.querySelector(".agh-control-host");
    if (host) return host;
    host = document.createElement("div");
    host.className = "agh-control-host";
    row.appendChild(host);
    return host;
  }

  function pct(a, b) {
    return b ? ((a / b) * 100).toFixed(1) : "0.0";
  }

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
        `.agh-instance-card[data-inst-key="${CSS.escape(instKey)}"] .agh-pause-countdown`
      );
      if (!el) {
        clearInterval(_pauseTimers[instKey]);
        return;
      }

      const remaining = (_pauseEndsAt[instKey] || 0) - Date.now();
      if (remaining <= 0) {
        clearInterval(_pauseTimers[instKey]);
        delete _pauseEndsAt[instKey];
        el.textContent = "";
        renderAghControl();
      } else {
        el.textContent = `Re-enables in ${fmtRemaining(remaining)}`;
      }
    }, 1000);
  }

  async function fetchInstance(inst) {
    const status = await aghGet(inst, "/control/status");
    const [stats, safeBrowsing, parental] = await Promise.all([
      aghGet(inst, "/control/stats").catch(() => ({})),
      aghGet(inst, "/control/safebrowsing/status").catch(() => ({})),
      aghGet(inst, "/control/parental/status").catch(() => ({}))
    ]);
    log(`${inst.label} status:`, status);
    return { status, stats, safeBrowsing, parental };
  }

  async function applyToggle(inst, toggleId, enabled) {
    switch (toggleId) {
      case "filtering":
        await aghPost(inst, "/control/protection", { enabled });
        break;
      case "safebrowsing":
        await aghPost(inst, enabled
          ? "/control/safebrowsing/enable"
          : "/control/safebrowsing/disable");
        break;
      case "parental":
        await aghPost(inst, enabled
          ? "/control/parental/enable"
          : "/control/parental/disable");
        break;
    }
  }

  function buildToggle(id, label, checked) {
    return `
      <div class="agh-toggle-row">
        <span class="agh-toggle-label">${escH(label)}</span>
        <button
          class="agh-toggle-btn${checked ? " agh-toggle-btn--on" : ""}"
          data-toggle-id="${escH(id)}"
          aria-pressed="${checked}"
          title="${checked ? "Enabled — click to disable" : "Disabled — click to enable"}"
        ><span class="agh-toggle-knob"></span></button>
      </div>`;
  }

  function buildPauseControl(instKey, protectionOn) {
    const isPaused = !!_pauseEndsAt[instKey] || !protectionOn;
    const durOptions = AGH_CONFIG.pauseDurations.map((d, i) =>
      `<option value="${i}">${escH(d.label)}</option>`
    ).join("");

    if (isPaused && _pauseEndsAt[instKey]) {
      const remaining = _pauseEndsAt[instKey] - Date.now();
      return `
        <div class="agh-pause-section">
          <div class="agh-pause-active">
            <span class="agh-pause-dot"></span>
            <span class="agh-pause-countdown">Re-enables in ${fmtRemaining(remaining)}</span>
          </div>
          <button class="agh-pause-resume-btn" data-inst-key="${escH(instKey)}">
            Re-enable now
          </button>
        </div>`;
    }

    if (!protectionOn && !_pauseEndsAt[instKey]) {
      return `
        <div class="agh-pause-section">
          <div class="agh-pause-active">
            <span class="agh-pause-dot"></span>
            <span class="agh-pause-countdown">Protection disabled</span>
          </div>
          <button class="agh-pause-resume-btn" data-inst-key="${escH(instKey)}">
            Re-enable now
          </button>
        </div>`;
    }

    return `
      <div class="agh-pause-section">
        <div class="agh-pause-row">
          <span class="agh-pause-label">Disable protection</span>
          <div class="agh-pause-controls">
            <select class="agh-pause-select" data-inst-key="${escH(instKey)}">${durOptions}</select>
            <button class="agh-pause-btn" data-inst-key="${escH(instKey)}">Pause</button>
          </div>
        </div>
      </div>`;
  }

  function buildInstanceCard(inst, data) {
    const instKey = getInstKey(inst);
    const instHref = getInstHref(inst);

    if (!data) {
      return `
        <div class="agh-instance-card agh-instance-card--offline" data-inst-key="${escH(instKey)}">
          <div class="agh-inst-header">
            <div class="agh-inst-left">
              <span class="agh-inst-dot agh-inst-dot--off"></span>
              <span class="agh-inst-name">${escH(inst.label)}</span>
            </div>
            <a class="agh-inst-link" href="${escH(instHref)}" target="_blank" rel="noopener noreferrer">Open ↗</a>
          </div>
          <div class="agh-inst-error">Offline or unreachable</div>
        </div>`;
    }

    const { status, stats, safeBrowsing, parental } = data;
    const total = stats.num_dns_queries || 0;
    const blocked = stats.num_blocked_filtering || 0;
    const rate = pct(blocked, total);
    const rps = (total / 86400).toFixed(1);

    const filteringOn = status.protection_enabled ?? false;
    const safeBrowsingOn = safeBrowsing.enabled ?? false;
    const parentalOn = parental.enabled ?? false;

    return `
      <div class="agh-instance-card${!filteringOn ? " agh-instance-card--paused" : ""}" data-inst-key="${escH(instKey)}">
        <div class="agh-inst-header">
          <div class="agh-inst-left">
            <span class="agh-inst-dot ${filteringOn ? "agh-inst-dot--on" : "agh-inst-dot--paused"}"></span>
            <span class="agh-inst-name">${escH(inst.label)}</span>
          </div>
          <a class="agh-inst-link" href="${escH(instHref)}" target="_blank" rel="noopener noreferrer">Open ↗</a>
        </div>

        <div class="agh-stats-row">
          <div class="agh-stat">
            <div class="agh-stat-val">${total.toLocaleString()}</div>
            <div class="agh-stat-lbl">Queries</div>
          </div>
          <div class="agh-stat">
            <div class="agh-stat-val" style="color:#f87171;">${blocked.toLocaleString()}</div>
            <div class="agh-stat-lbl">Blocked</div>
          </div>
          <div class="agh-stat">
            <div class="agh-stat-val" style="color:#fb923c;">${rate}%</div>
            <div class="agh-stat-lbl">Block Rate</div>
          </div>
          <div class="agh-stat">
            <div class="agh-stat-val" style="color:#6ee7b7;">${rps}/s</div>
            <div class="agh-stat-lbl">Avg Rate</div>
          </div>
        </div>

        <div class="agh-divider"></div>

        <div class="agh-toggles">
          ${buildToggle("filtering", "DNS Filtering", filteringOn)}
          ${buildToggle("safebrowsing", "Safe Browsing", safeBrowsingOn)}
          ${buildToggle("parental", "Parental Control", parentalOn)}
        </div>

        <div class="agh-divider"></div>

        ${buildPauseControl(instKey, filteringOn)}
      </div>`;
  }

  function buildShell(inner) {
    return `
      <div class="agh-shell">
        <div class="agh-shell-header">
          <div class="agh-shell-header-left">
            <img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/webp/adguard-home.webp"
                 alt="AdGuard Home" class="agh-icon">
            <div>
              <div class="agh-shell-title">AdGuard Home</div>
            </div>
          </div>
          <div class="agh-shell-footer-ts" id="agh-ts"></div>
        </div>
        <div class="agh-cards-grid">${inner}</div>
      </div>`;
  }

  function buildSkeleton() {
    return `<div class="agh-skeleton-wrap">${[1, 2].map(() =>
      `<div class="agh-skeleton-card"></div>`).join("")}</div>`;
  }

  async function renderAghControl() {
    const group = findGroupContainer();
    if (!group) return;
    const host = ensureHost(group);

    if (!host.querySelector(".agh-shell")) {
      host.innerHTML = buildShell(buildSkeleton());
    }

    const results = await Promise.allSettled(
      AGH_CONFIG.instances.map(inst => fetchInstance(inst))
    );

    const cards = AGH_CONFIG.instances.map((inst, i) => {
      const r = results[i];
      if (r.status === "fulfilled") return buildInstanceCard(inst, r.value);
      console.error("[AGH] fetch failed:", inst.label, r.reason);
      return buildInstanceCard(inst, null);
    }).join("");

    host.innerHTML = buildShell(cards);

    const ts = host.querySelector("#agh-ts");
    if (ts) ts.textContent = `Updated ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true })}`;

    bindToggles(host);
    bindPauseControls(host);

    AGH_CONFIG.instances.forEach(inst => {
      const instKey = getInstKey(inst);
      if (_pauseEndsAt[instKey]) startCountdown(instKey);
    });
  }

  function bindToggles(host) {
    host.querySelectorAll(".agh-toggle-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const card = btn.closest(".agh-instance-card");
        const instKey = card?.dataset.instKey;
        const inst = AGH_CONFIG.instances.find(i => getInstKey(i) === instKey);
        if (!inst) return;

        const toggleId = btn.dataset.toggleId;
        const isOn = btn.getAttribute("aria-pressed") === "true";
        const newState = !isOn;

        btn.setAttribute("aria-pressed", String(newState));
        btn.classList.toggle("agh-toggle-btn--on", newState);
        btn.disabled = true;

        try {
          await applyToggle(inst, toggleId, newState);
          if (toggleId === "filtering" && newState) {
            clearInterval(_pauseTimers[instKey]);
            delete _pauseEndsAt[instKey];
          }
          log(`✓ ${inst.label} ${toggleId} → ${newState}`);
          await renderAghControl();
        } catch (err) {
          console.error("[AGH] Toggle failed:", inst.label, toggleId, err);
          btn.setAttribute("aria-pressed", String(isOn));
          btn.classList.toggle("agh-toggle-btn--on", isOn);
        } finally {
          btn.disabled = false;
        }
      });
    });
  }

  function bindPauseControls(host) {
    host.querySelectorAll(".agh-pause-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const instKey = btn.dataset.instKey;
        const inst = AGH_CONFIG.instances.find(i => getInstKey(i) === instKey);
        if (!inst) return;

        const select = host.querySelector(`.agh-pause-select[data-inst-key="${CSS.escape(instKey)}"]`);
        const durIdx = select ? parseInt(select.value, 10) : 0;
        const dur = AGH_CONFIG.pauseDurations[durIdx];

        btn.disabled = true;
        btn.textContent = "Pausing…";

        try {
          await aghPost(inst, "/control/protection", {
            enabled: false,
            duration: dur.ms
          });
          log(`✓ ${inst.label} paused for ${dur.label}`);

          if (dur.ms > 0) {
            _pauseEndsAt[instKey] = Date.now() + dur.ms;
            startCountdown(instKey);
          } else {
            delete _pauseEndsAt[instKey];
          }

          await renderAghControl();
        } catch (err) {
          console.error("[AGH] Pause failed:", inst.label, err);
          btn.disabled = false;
          btn.textContent = "Pause";
        }
      });
    });

    host.querySelectorAll(".agh-pause-resume-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const instKey = btn.dataset.instKey;
        const inst = AGH_CONFIG.instances.find(i => getInstKey(i) === instKey);
        if (!inst) return;

        btn.disabled = true;
        btn.textContent = "Enabling…";

        try {
          await aghPost(inst, "/control/protection", { enabled: true });
          clearInterval(_pauseTimers[instKey]);
          delete _pauseEndsAt[instKey];
          log(`✓ ${inst.label} protection re-enabled`);
          await renderAghControl();
        } catch (err) {
          console.error("[AGH] Resume failed:", inst.label, err);
          btn.disabled = false;
          btn.textContent = "Re-enable now";
        }
      });
    });
  }

  function init() {
    const start = () => {
      setTimeout(renderAghControl, 1800);
      setInterval(() => {
        if (document.hidden) return;
        renderAghControl();
      }, AGH_CONFIG.pollMs);
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }

    const observer = new MutationObserver(() => {
      if (!document.querySelector(".agh-control-host .agh-shell")) {
        setTimeout(renderAghControl, 500);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  init();
})();