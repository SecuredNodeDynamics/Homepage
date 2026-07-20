/* =====================================================
   HOME ASSISTANT CUSTOM WIDGET
   Group name: HOME-ASSISTANT-WIDGET
===================================================== */
(function () {
  const HA_CONFIG = {
    groupName: "HOME-ASSISTANT-WIDGET",
    pollMs: 60 * 1000,
    url: "https://homeassist.YOUR_URL_HERE.com",
    fallbackUrl: "http://YOUR_IPADDRESS:8123",
    activeUrl: null,
    token: "PASTE_HOME_ASSISTANT_LONG_LIVED_ACCESS_TOKEN_HERE",
  };

  const DEVICE_GLYPHS = {
    ring: `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3v2M6.5 8.5 5 10M17.5 8.5 19 10M6 14a6 6 0 1 1 12 0v3H6v-3zM9 20h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    washer: `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="13" r="4" stroke="currentColor" stroke-width="1.5"/><path d="M8 6h.01M11 6h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
    printer: `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 9V3h12v6M6 14h12v7H6v-7zM6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    tv: `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="5" width="18" height="12" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M8 21h8M12 17v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  };

  const DOMAIN_META = {
    light: { icon: "💡", label: "Light" },
    switch: { icon: "🔌", label: "Switch" },
    fan: { icon: "🌀", label: "Fan" },
    cover: { icon: "🪟", label: "Cover" },
    lock: { icon: "🔒", label: "Lock" },
    climate: { icon: "🌡", label: "Climate" },
    camera: { icon: "📷", label: "Camera" },
    button: { icon: "🔘", label: "Button" },
    media_player: { icon: "🎵", label: "Media" },
    siren: { icon: "🚨", label: "Siren" },
    input_boolean: { icon: "⏻", label: "Toggle" },
    sensor: { icon: "📊", label: "Sensor" },
    binary_sensor: { icon: "◎", label: "Sensor" },
  };

  let _data = null;
  let _error = null;
  let _rendered = false;
  let _pollTimer = null;
  let _snapshotTimer = null;
  let _host = null;
  let _ui = { modalEntityId: null };
  let _busy = new Set();
  let _haWs = null;
  let _haWsPromise = null;
  let _webrtcSession = null;

  function normText(v) { return (v || "").replace(/\s+/g, " ").trim(); }
  function escH(s = "") {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function escA(s = "") { return escH(s).replace(/`/g, "&#96;"); }
  function isConfigured() {
    return HA_CONFIG.token && !HA_CONFIG.token.includes("PASTE_HOME_ASSISTANT");
  }
  function makeSignal(ms = 8000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    return { signal: ctrl.signal, clear: () => clearTimeout(timer) };
  }
  function findGroupContainer() {
    const hd = Array.from(document.querySelectorAll("h2,h3,.group-title,.service-group-name"))
      .find(el => normText(el.textContent) === HA_CONFIG.groupName);
    if (!hd) return null;
    return hd.closest("section") || hd.closest("div[class*='group']") || hd.parentElement?.parentElement || hd.parentElement;
  }
  function ensureHost(group) {
    let row = group.querySelector(".hp-widget-row, .ha-flex-row");
    if (!row) {
      const list = group.querySelector("ul.services-list, ul");
      if (list) list.style.display = "none";
      row = document.createElement("div");
      row.className = "hp-widget-row ha-flex-row";
      group.appendChild(row);
    } else {
      row.classList.add("hp-widget-row", "ha-flex-row");
    }
    let host = row.querySelector(".ha-host");
    if (!host) {
      host = document.createElement("div");
      host.className = "ha-host";
      row.appendChild(host);
    }
    return host;
  }
  function haBase() {
    return HA_CONFIG.activeUrl || HA_CONFIG.url || HA_CONFIG.fallbackUrl;
  }
  function cameraStreamUrl(entityId) {
    const token = encodeURIComponent(HA_CONFIG.token);
    return `${haBase()}/api/camera_proxy_stream/${encodeURIComponent(entityId)}?access_token=${token}`;
  }
  function entityStem(entityId) {
    const slug = (entityId || "").split(".").pop() || "";
    return slug.replace(/_live_view$|_live$|_stream$/i, "");
  }
  function isRecentActivity(e, minutes = 8) {
    if (!e) return false;
    const d = domainOf(e);
    if (d === "binary_sensor") return e.state === "on";
    if (d === "event") {
      const t = Date.parse(e.state);
      return Number.isFinite(t) && Date.now() - t < minutes * 60 * 1000;
    }
    return false;
  }
  function cameraSnapshotUrl(entityId) {
    const token = encodeURIComponent(HA_CONFIG.token);
    return `${haBase()}/api/camera_proxy/${encodeURIComponent(entityId)}?access_token=${token}&t=${Date.now()}`;
  }
  function haEntityUrl(entityId) {
    return `${haBase()}/?entity=${encodeURIComponent(entityId)}`;
  }
  function primeCameraImg(img) {
    const entityId = img?.dataset?.cameraId;
    if (!img || !entityId) return;
    const frame = img.closest(".ha-cam-frame, .ha-camera-modal-feed, .ha-grid-card-visual");
    const ph = frame?.querySelector(".ha-cam-placeholder, .ha-cam-fallback, .ha-grid-card-glyph");
    const showPh = () => {
      img.classList.remove("ha-cam-img--loaded");
      ph?.classList.remove("ha-cam-placeholder--hidden");
    };
    const showImg = () => {
      img.classList.add("ha-cam-img--loaded");
      ph?.classList.add("ha-cam-placeholder--hidden");
    };
    img.onload = showImg;
    img.onerror = () => {
      if (img.dataset.triedStream === "1") { showPh(); return; }
      img.dataset.triedStream = "1";
      img.src = cameraStreamUrl(entityId);
    };
    img.referrerPolicy = "no-referrer";
    img.src = cameraSnapshotUrl(entityId);
  }
  function primeAllCameraImgs(root) {
    (root || document).querySelectorAll("img[data-camera-id]").forEach(primeCameraImg);
  }

  function wsBase() {
    return haBase().replace(/^http/i, (m) => (m.toLowerCase() === "https" ? "wss" : "ws"));
  }

  function connectHaWs() {
    if (_haWs?.ready) return Promise.resolve(_haWs);
    if (_haWsPromise) return _haWsPromise;
    _haWsPromise = new Promise((resolve, reject) => {
      const ws = new WebSocket(`${wsBase()}/api/websocket`);
      const conn = { ws, nextId: 1, subs: new Map(), ready: false };
      const fail = (err) => {
        _haWsPromise = null;
        reject(err);
      };
      ws.onerror = () => fail(new Error("WebSocket connection failed"));
      ws.onclose = () => {
        conn.ready = false;
        _haWs = null;
        _haWsPromise = null;
      };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === "auth_required") {
          ws.send(JSON.stringify({ type: "auth", access_token: HA_CONFIG.token }));
          return;
        }
        if (msg.type === "auth_invalid") { fail(new Error("WebSocket auth failed")); return; }
        if (msg.type === "auth_ok") {
          conn.ready = true;
          _haWs = conn;
          resolve(conn);
          return;
        }
        if (msg.type === "event" && conn.subs.has(msg.id)) {
          conn.subs.get(msg.id)?.onEvent?.(msg.event);
        }
        if (msg.type === "result" && conn.subs.has(msg.id)) {
          const sub = conn.subs.get(msg.id);
          if (!msg.success) sub?.onError?.(new Error(msg.error?.message || "Request failed"));
          else sub?.onResult?.(msg.result);
        }
      };
    });
    return _haWsPromise;
  }

  function stopWebRtc() {
    if (_webrtcSession?.pc) {
      try { _webrtcSession.pc.close(); } catch (_) {}
    }
    if (_webrtcSession?.msgId && _haWs?.subs) {
      _haWs.subs.delete(_webrtcSession.msgId);
    }
    _webrtcSession = null;
    const video = document.getElementById("ha-camera-modal-video");
    if (video) {
      video.srcObject = null;
      video.classList.remove("ha-cam-video--active");
    }
  }

  async function wakeCamera(entityId) {
    try {
      await callService("camera", "turn_on", entityId);
      await new Promise(r => setTimeout(r, 800));
    } catch (_) { /* continue to stream attempts */ }
  }

  function setFeedMode(mode) {
    const video = document.getElementById("ha-camera-modal-video");
    const img = document.getElementById("ha-camera-modal-img");
    const fallback = document.querySelector("#ha-camera-modal-overlay .ha-cam-fallback");
    video?.classList.toggle("ha-cam-video--active", mode === "webrtc");
    img?.classList.toggle("ha-cam-img--loaded", mode === "mjpeg" || mode === "snapshot");
    fallback?.classList.toggle("ha-cam-placeholder--hidden", mode === "webrtc" || mode === "mjpeg" || mode === "snapshot");
  }

  async function startWebRtcFeed(video, entityId) {
    const conn = await connectHaWs();
    stopWebRtc();
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
    });
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" });
    let sessionId = null;
    let gotTrack = false;
    pc.ontrack = (ev) => {
      gotTrack = true;
      video.srcObject = ev.streams[0];
      video.play().catch(() => {});
      setFeedMode("webrtc");
    };
    const msgId = conn.nextId++;
    pc.onicecandidate = (ev) => {
      if (!ev.candidate || !sessionId) return;
      conn.ws.send(JSON.stringify({
        id: conn.nextId++,
        type: "camera/webrtc/candidate",
        entity_id: entityId,
        session_id: sessionId,
        candidate: ev.candidate.candidate,
        sdp_mid: ev.candidate.sdpMid,
        sdp_m_line_index: ev.candidate.sdpMLineIndex,
      }));
    };
    conn.subs.set(msgId, {
      onEvent: (event) => {
        if (!event) return;
        if (event.type === "session") sessionId = event.session_id;
        if (event.type === "answer" && event.answer) {
          pc.setRemoteDescription({ type: "answer", sdp: event.answer }).catch(() => {});
        }
        if (event.type === "candidate" && event.candidate) {
          pc.addIceCandidate({
            candidate: event.candidate,
            sdpMid: event.sdp_mid ?? "0",
            sdpMLineIndex: event.sdp_m_line_index ?? 0,
          }).catch(() => {});
        }
        if (event.type === "error") console.warn("[HomeAssistantWidget] WebRTC:", event.message);
      },
      onError: (err) => console.warn("[HomeAssistantWidget] WebRTC offer:", err.message),
    });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    conn.ws.send(JSON.stringify({
      id: msgId,
      type: "camera/webrtc/offer",
      entity_id: entityId,
      offer: offer.sdp,
    }));
    _webrtcSession = { pc, msgId, entityId };
    await new Promise(r => setTimeout(r, 4000));
    return gotTrack;
  }

  async function startMjpegFeed(img, entityId) {
    return new Promise((resolve) => {
      img.dataset.triedStream = "";
      img.onload = () => { setFeedMode("mjpeg"); resolve(true); };
      img.onerror = () => resolve(false);
      img.src = cameraStreamUrl(entityId);
      setTimeout(() => resolve(img.classList.contains("ha-cam-img--loaded")), 5000);
    });
  }

  async function startCameraFeed(entityId) {
    const video = document.getElementById("ha-camera-modal-video");
    const img = document.getElementById("ha-camera-modal-img");
    if (!video || !img) return;
    setFeedMode("none");
    img.dataset.cameraId = entityId;
    await wakeCamera(entityId);
    try {
      if (await startWebRtcFeed(video, entityId)) return;
    } catch (err) {
      console.warn("[HomeAssistantWidget] WebRTC unavailable:", err.message);
    }
    stopWebRtc();
    if (await startMjpegFeed(img, entityId)) return;
    primeCameraImg(img);
    if (img.complete && img.naturalWidth > 0) setFeedMode("snapshot");
  }

  async function haFetch(path, options = {}) {
    const candidates = [];
    if (HA_CONFIG.activeUrl) candidates.push(HA_CONFIG.activeUrl);
    if (!candidates.includes(HA_CONFIG.url)) candidates.push(HA_CONFIG.url);
    if (HA_CONFIG.fallbackUrl && !candidates.includes(HA_CONFIG.fallbackUrl)) candidates.push(HA_CONFIG.fallbackUrl);
    let lastErr = null;
    for (const base of candidates) {
      const { signal, clear } = makeSignal(options.timeout || 8000);
      try {
        const res = await fetch(`${base}${path}`, {
          method: options.method || "GET",
          signal,
          headers: {
            Authorization: `Bearer ${HA_CONFIG.token}`,
            Accept: "application/json",
            ...(options.body ? { "Content-Type": "application/json" } : {}),
            ...(options.headers || {}),
          },
          body: options.body,
        });
        clear();
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        HA_CONFIG.activeUrl = base;
        const text = await res.text();
        if (!text) return null;
        try { return JSON.parse(text); } catch { return text; }
      } catch (err) {
        clear();
        lastErr = err;
        HA_CONFIG.activeUrl = null;
      }
    }
    throw lastErr || new Error("Home Assistant unavailable");
  }

  async function haFetchTemplate(template) {
    const result = await haFetch("/api/template", {
      method: "POST",
      body: JSON.stringify({ template }),
      timeout: 12000,
    });
    if (typeof result === "string") {
      try { return JSON.parse(result.trim()); } catch { return null; }
    }
    return result;
  }

  function friendly(entity) {
    return entity?.attributes?.friendly_name || entity?.entity_id?.split(".").pop()?.replace(/_/g, " ") || "Unknown";
  }
  function domainOf(entity) {
    return (entity?.entity_id || "").split(".")[0] || "unknown";
  }
  function timeAgo(iso) {
    if (!iso) return "";
    const diff = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }
  function isUnavailable(e) {
    return ["unavailable", "unknown"].includes(e?.state);
  }
  function stateIsProblem(e) {
    if (isUnavailable(e)) return false;
    const devClass = e.attributes?.device_class || "";
    if (domainOf(e) === "lock") return ["unlocked", "open"].includes(e.state);
    if (domainOf(e) === "cover") return e.state === "open";
    if (domainOf(e) === "alarm_control_panel") return !["disarmed", "armed_home", "armed_away"].includes(e.state);
    if (domainOf(e) === "binary_sensor") {
      return e.state === "on" && ["problem", "safety", "smoke", "gas", "moisture", "tamper"].includes(devClass);
    }
    return false;
  }
  function findWeather(states) {
    const w = states.find(e => domainOf(e) === "weather");
    if (w) return w;
    const t = states.find(e => domainOf(e) === "sensor" && (e.attributes?.device_class === "temperature" || /outdoor.*temp|weather.*temp/i.test(e.entity_id)));
    if (t) return { state: "Temp", attributes: { temperature: parseFloat(t.state) || t.state } };
    return null;
  }
  function isControllable(e) {
    return HA_CONFIG.controllableDomains.includes(domainOf(e)) && !isUnavailable(e);
  }
  function isUsefulSensor(e) {
    if (!HA_CONFIG.sensorDomains.includes(domainOf(e)) || isUnavailable(e)) return false;
    const dc = e.attributes?.device_class || "";
    if (domainOf(e) === "event") return /motion|ding|doorbell/i.test(e.entity_id);
    return ["temperature", "humidity", "illuminance", "power", "energy", "battery", "occupancy", "motion", "door", "window", "moisture"].includes(dc)
      || /temp|humid|battery|motion|door|occupancy/i.test(e.entity_id);
  }
  function entityIcon(e) {
    return DOMAIN_META[domainOf(e)]?.icon || "•";
  }
  function isDoorLikeEntity(e) {
    const dc = e.attributes?.device_class || "";
    if (domainOf(e) !== "binary_sensor") return false;
    return dc === "door" || dc === "window" || /door|lid/i.test(e.entity_id);
  }
  function doorWindowLabel(e) {
    if (e.state === "on") return "Open";
    if (e.state === "off") return "Closed";
    if (isUnavailable(e)) return "Unknown";
    return e.state;
  }
  function stateLabel(e) {
    const d = domainOf(e);
    if (d === "climate") {
      const t = e.attributes?.current_temperature ?? e.attributes?.temperature;
      return t != null ? `${t}°` : e.state;
    }
    if (d === "sensor") {
      const u = e.attributes?.unit_of_measurement || "";
      return `${e.state}${u}`;
    }
    if (d === "event") return isRecentActivity(e) ? "Recent" : timeAgo(e.state) || "—";
    if (d === "cover") return e.state;
    if (d === "lock") return e.state;
    if (d === "binary_sensor" && isDoorLikeEntity(e)) return doorWindowLabel(e);
    return e.state;
  }
  function tileActive(e) {
    const d = domainOf(e);
    if (["light", "switch", "fan", "input_boolean", "siren"].includes(d)) return e.state === "on";
    if (d === "media_player") return !["off", "idle", "standby"].includes(e.state);
    if (d === "lock") return e.state === "locked";
    if (d === "cover") return e.state === "open";
    return false;
  }

  function buildRegistryMaps(areas, registry) {
    const areaById = {};
    (areas || []).forEach(a => { areaById[a.area_id] = { id: a.area_id, name: a.name, entities: [], cameras: [], sensors: [], controls: [] }; });
    const unassigned = { id: "_other", name: "Other", entities: [], cameras: [], sensors: [], controls: [] };
    const regByEntity = {};
    (registry || []).forEach(r => { regByEntity[r.entity_id] = r; });
    return { areaById, unassigned, regByEntity };
  }

  async function loadAreasAndRegistry() {
    try {
      const [areas, registry] = await Promise.all([
        haFetch("/api/config/area_registry/list"),
        haFetch("/api/config/entity_registry/list"),
      ]);
      if (Array.isArray(areas) && Array.isArray(registry)) return { areas, registry };
    } catch (_) { /* fall through */ }

    try {
      const tpl = `{%- set ns = namespace(areas=[], registry=[]) -%}
{%- for area in areas() -%}
{%- set ns.areas = ns.areas + [{"area_id": area.id, "name": area.name}] -%}
{%- endfor -%}
{%- for state in states -%}
{%- set ns.registry = ns.registry + [{"entity_id": state.entity_id, "area_id": area_id(state.entity_id), "device_id": device_id(state.entity_id), "entity_category": none}] -%}
{%- endfor -%}
{{ {"areas": ns.areas, "registry": ns.registry} | tojson }}`;
      const parsed = await haFetchTemplate(tpl);
      if (parsed?.areas && parsed?.registry) return parsed;
    } catch (_) { /* fall through */ }

    return { areas: [], registry: [] };
  }

  function organizeRooms(states, areas, registry) {
    const { areaById, unassigned, regByEntity } = buildRegistryMaps(areas, registry);
    const stateMap = Object.fromEntries(states.map(s => [s.entity_id, s]));
    const deviceEntities = {};

    (registry || []).forEach(r => {
      if (HA_CONFIG.hideEntityCategories.includes(r.entity_category)) return;
      const state = stateMap[r.entity_id];
      if (!state) return;
      if (r.device_id) {
        if (!deviceEntities[r.device_id]) deviceEntities[r.device_id] = [];
        deviceEntities[r.device_id].push({ state, registry: r });
      }
      const room = r.area_id && areaById[r.area_id] ? areaById[r.area_id] : unassigned;
      room.entities.push({ state, registry: r });
      if (domainOf(state) === "camera") room.cameras.push(state);
      else if (isControllable(state)) room.controls.push(state);
      else if (isUsefulSensor(state)) room.sensors.push(state);
    });

    states.forEach(state => {
      if (regByEntity[state.entity_id]) return;
      const room = unassigned;
      room.entities.push({ state, registry: null });
      if (domainOf(state) === "camera") room.cameras.push(state);
      else if (isControllable(state)) room.controls.push(state);
      else if (isUsefulSensor(state)) room.sensors.push(state);
    });

    const rooms = [...Object.values(areaById), unassigned]
      .filter(r => r.entities.length)
      .sort((a, b) => a.name.localeCompare(b.name));
    if (unassigned.entities.length) {
      const idx = rooms.findIndex(r => r.id === "_other");
      if (idx >= 0) { const [u] = rooms.splice(idx, 1); rooms.push(u); }
    }
    return { rooms, deviceEntities, stateMap, regByEntity };
  }

  function findRoomByName(rooms, name) {
    if (!name) return null;
    const key = name.toLowerCase();
    return rooms.find(r => r.name.toLowerCase() === key) || null;
  }

  function pushEntityToRoom(room, state, registry = null) {
    if (room.entities.some(e => (e.state || e).entity_id === state.entity_id)) return;
    room.entities.push({ state, registry });
    if (domainOf(state) === "camera") room.cameras.push(state);
    else if (isControllable(state)) room.controls.push(state);
    else if (isUsefulSensor(state)) room.sensors.push(state);
  }

  function pullEntityFromRoom(room, entityId) {
    room.entities = room.entities.filter(e => (e.state || e).entity_id !== entityId);
    room.cameras = room.cameras.filter(e => e.entity_id !== entityId);
    room.controls = room.controls.filter(e => e.entity_id !== entityId);
    room.sensors = room.sensors.filter(e => e.entity_id !== entityId);
  }

  function ensureFeaturedInArea(layout, featured, states) {
    const areaName = HA_CONFIG.defaultArea;
    if (!areaName || !featured.length) return;

    let target = findRoomByName(layout.rooms, areaName);
    if (!target) {
      target = { id: `_area_${areaName.toLowerCase().replace(/\s+/g, "_")}`, name: areaName, entities: [], cameras: [], sensors: [], controls: [] };
      layout.rooms.unshift(target);
    }

    const cam = featured[0].entity;
    const stem = entityStem(cam.entity_id);
    const belongs = (state) => state.entity_id === cam.entity_id || state.entity_id.includes(stem);

    layout.rooms.forEach(room => {
      if (room.id === target.id) return;
      [...room.cameras, ...room.controls, ...room.sensors].forEach(state => {
        if (belongs(state)) {
          pullEntityFromRoom(room, state.entity_id);
          pushEntityToRoom(target, state, layout.regByEntity[state.entity_id] || null);
        }
      });
    });

    (states || []).forEach(state => {
      if (belongs(state)) pushEntityToRoom(target, state, layout.regByEntity[state.entity_id] || null);
    });

    layout.rooms = layout.rooms.filter(r => r.id === "_other" ? r.entities.length > 0 : r.entities.length > 0 || r.id === target.id);
    const otherIdx = layout.rooms.findIndex(r => r.id === "_other");
    if (otherIdx >= 0) {
      const [other] = layout.rooms.splice(otherIdx, 1);
      layout.rooms.push(other);
    }
  }

  function entityMatches(entity, cfg) {
    if (!entity || !cfg?.match) return false;
    const slug = entity.entity_id.split(".").pop() || "";
    const name = friendly(entity).toLowerCase();
    return cfg.match.test(entity.entity_id) || cfg.match.test(slug) || cfg.match.test(name);
  }

  function resolveDeviceEntity(cfg, states) {
    if (cfg.entityId) {
      const hit = states.find(s => s.entity_id === cfg.entityId);
      if (hit) return hit;
    }
    const domains = cfg.domains || (cfg.kind === "camera" ? ["camera"] : cfg.kind === "media" ? ["media_player"] : null);
    const candidates = states.filter(s => {
      if (domains && !domains.includes(domainOf(s))) return false;
      if (isUnavailable(s)) return false;
      return entityMatches(s, cfg);
    });
    if (!candidates.length) return null;
    if (cfg.kind === "camera") return candidates.find(c => domainOf(c) === "camera") || candidates[0];
    if (cfg.kind === "media") return candidates.find(c => domainOf(c) === "media_player") || candidates[0];
    return candidates.find(c => domainOf(c) === "sensor" && /cycle|state|status|job|mode|run/i.test(c.entity_id))
      || candidates.find(c => domainOf(c) === "binary_sensor")
      || candidates.find(c => domainOf(c) === "sensor")
      || candidates.find(c => domainOf(c) === "switch")
      || candidates[0];
  }

  function findConfiguredDevices(states) {
    return (HA_CONFIG.devices || []).map(cfg => ({
      ...cfg,
      entity: resolveDeviceEntity(cfg, states),
    }));
  }

  function getDeviceConfig(entityId) {
    return (_data?.devices || []).find(d => d.entity?.entity_id === entityId);
  }

  function relatedEntities(primaryEntity, layout) {
    const reg = layout.regByEntity[primaryEntity.entity_id];
    const deviceId = reg?.device_id;
    const stem = entityStem(primaryEntity.entity_id);
    const related = [];
    const seen = new Set([primaryEntity.entity_id]);

    const consider = (state) => {
      if (!state || seen.has(state.entity_id) || isUnavailable(state)) return;
      seen.add(state.entity_id);
      related.push(state);
    };

    if (deviceId && layout.deviceEntities[deviceId]) {
      layout.deviceEntities[deviceId].forEach(({ state }) => consider(state));
    }
    (_data?.states || []).forEach(state => {
      if (state.entity_id === primaryEntity.entity_id) return;
      const slug = state.entity_id.split(".").pop() || "";
      if (slug.includes(stem) || stem.includes(slug.split("_")[0])) consider(state);
      else if (/dcp_l2640dw/i.test(stem) && /dcp_l2640dw|brother_dcp/i.test(slug)) consider(state);
    });
    return related.slice(0, 12);
  }

  function shortName(entity) {
    return friendly(entity).replace(/^Front Door\s*/i, "").trim() || friendly(entity);
  }
  function isModalHiddenEntity(e) {
    return /wifi|signal_strength|signal category|volume/i.test(e.entity_id);
  }
  function isReadOnlyStatusEntity(e) {
    return /motion_detection/i.test(e.entity_id);
  }
  function formatModalStat(e) {
    const id = e.entity_id;
    if (id.includes("battery")) return { label: "Battery", value: `${e.state}%` };
    if (/motion_detection/i.test(id)) return { label: "Motion Detection", value: e.state === "on" ? "Enabled" : "Disabled" };
    if (domainOf(e) === "event" && /ding/i.test(id)) {
      return { label: "Last Ding", value: isRecentActivity(e) ? "Just now" : timeAgo(e.state) || "—" };
    }
    if (domainOf(e) === "event" && /motion/i.test(id)) {
      return { label: "Last Motion", value: isRecentActivity(e) ? "Recent" : timeAgo(e.state) || "—" };
    }
    if (id.includes("last_activity")) return { label: "Last Activity", value: timeAgo(e.state) || "—" };
    if (domainOf(e) === "media_player") {
      if (e.attributes?.media_title) return { label: "Now Playing", value: e.attributes.media_title };
      if (e.attributes?.app_name) return { label: "App", value: e.attributes.app_name };
    }
    if (isDoorLikeEntity(e)) {
      const label = (e.attributes?.device_class === "window" || /window/i.test(e.entity_id)) ? "Window" : "Door";
      return { label, value: doorWindowLabel(e) };
    }
    if (domainOf(e) === "sensor" || domainOf(e) === "binary_sensor") {
      return { label: shortName(e), value: stateLabel(e) };
    }
    return null;
  }
  function modalRelatedEntities(entity, layout) {
    return relatedEntities(entity, layout).filter(e => !isModalHiddenEntity(e));
  }
  function buildModalStats(related, primary) {
    const stats = [];
    const used = new Set();
    const order = [/battery/i, /motion_detection/i, /ding/i, /motion/i, /last_activity/i, /cycle|status|state|job|mode/i];
    order.forEach(rx => {
      const hit = related.find(e => rx.test(e.entity_id));
      if (!hit || used.has(hit.entity_id)) return;
      const s = formatModalStat(hit);
      if (!s) return;
      used.add(hit.entity_id);
      stats.push(s);
    });
    related.forEach(e => {
      if (used.has(e.entity_id) || isReadOnlyStatusEntity(e)) return;
      if (domainOf(e) !== "sensor" && domainOf(e) !== "binary_sensor") return;
      const s = formatModalStat(e);
      if (!s) return;
      used.add(e.entity_id);
      stats.push(s);
    });
    if (primary && domainOf(primary) === "media_player" && primary.attributes?.media_title) {
      stats.unshift({ label: "Now Playing", value: primary.attributes.media_title });
    }
    if (!stats.length) return "";
    return `<div class="ha-modal-stats">${stats.slice(0, 6).map(s => `
      <div class="ha-modal-stat">
        <span class="ha-modal-stat-label">${escH(s.label)}</span>
        <span class="ha-modal-stat-value">${escH(s.value)}</span>
      </div>`).join("")}</div>`;
  }
  function buildModalToggles(related) {
    const toggles = related.filter(e => isControllable(e)
      && ["switch", "light", "input_boolean"].includes(domainOf(e))
      && !isReadOnlyStatusEntity(e));
    if (!toggles.length) return "";
    return `<div class="ha-modal-toggles">${toggles.map(e => {
      const on = tileActive(e);
      return `<button type="button" class="ha-modal-toggle${on ? " ha-modal-toggle--on" : ""}${_busy.has(e.entity_id) ? " ha-modal-toggle--busy" : ""}" data-ha-action="toggle" data-entity-id="${escA(e.entity_id)}">
        <span class="ha-modal-toggle-info">
          <span class="ha-modal-toggle-name">${escH(shortName(e))}</span>
          <span class="ha-modal-toggle-state">${escH(e.state)}</span>
        </span>
        <span class="ha-modal-toggle-track" aria-hidden="true"><span class="ha-modal-toggle-thumb"></span></span>
      </button>`;
    }).join("")}</div>`;
  }

  function buildModalActions(primary) {
    if (!primary || domainOf(primary) !== "media_player") return "";
    const playing = !["off", "idle", "standby", "paused"].includes(primary.state);
    return `<div class="ha-modal-actions-row">
      <button type="button" class="ha-btn ha-btn--primary" data-ha-action="media-playpause" data-entity-id="${escA(primary.entity_id)}">${playing ? "Pause" : "Play"}</button>
      <button type="button" class="ha-btn ha-btn--ghost" data-ha-action="media-stop" data-entity-id="${escA(primary.entity_id)}">Stop</button>
    </div>`;
  }

  function pickDefaultRoom(rooms, featured) {
    const byName = findRoomByName(rooms, HA_CONFIG.defaultArea);
    if (byName) return byName.id;
    if (featured.length) {
      const camId = featured[0].entity.entity_id;
      const room = rooms.find(r => r.cameras.some(c => c.entity_id === camId));
      if (room) return room.id;
    }
    return rooms[0]?.id || null;
  }

  function summarize(states) {
    const lights = states.filter(e => domainOf(e) === "light");
    const switches = states.filter(e => domainOf(e) === "switch");
    const climate = states.filter(e => domainOf(e) === "climate");
    const alerts = states.filter(stateIsProblem);
    const weather = findWeather(states);
    return {
      total: states.length,
      lightsOn: lights.filter(e => e.state === "on").length,
      lightsTotal: lights.length,
      switchesOn: switches.filter(e => e.state === "on").length,
      switchesTotal: switches.length,
      climateTotal: climate.length,
      alerts,
      weather,
      recent: states.filter(e => e.last_changed).sort((a, b) => new Date(b.last_changed) - new Date(a.last_changed)).slice(0, 6),
    };
  }

  async function fetchAll() {
    if (!isConfigured()) {
      _data = null;
      _error = null;
      return;
    }
    const [config, statesRaw, areaData] = await Promise.all([
      haFetch("/api/config"),
      haFetch("/api/states"),
      loadAreasAndRegistry(),
    ]);
    const states = Array.isArray(statesRaw) ? statesRaw : [];
    const layout = organizeRooms(states, areaData.areas, areaData.registry);
    _data = {
      config,
      states,
      summary: summarize(states),
      layout,
      devices: findConfiguredDevices(states),
      updated: new Date(),
    };
    _error = null;
  }

  async function callService(domain, service, entityId, extra = {}) {
    const body = entityId != null
      ? { entity_id: entityId, ...extra }
      : { ...extra };
    await haFetch(`/api/services/${domain}/${service}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  function patchEntityState(entityId, newState) {
    const state = _data?.layout?.stateMap?.[entityId] || _data?.states?.find(s => s.entity_id === entityId);
    if (state) state.state = newState;
  }

  async function toggleEntity(entityId) {
    if (_busy.has(entityId)) return;
    const state = _data?.layout?.stateMap?.[entityId] || _data?.states?.find(s => s.entity_id === entityId);
    if (!state) return;
    const domain = domainOf(state);
    const prev = state.state;
    _busy.add(entityId);
    let next = prev;
    if (domain === "lock") next = prev === "locked" ? "unlocked" : "locked";
    else if (domain === "cover") next = ["open", "opening"].includes(prev) ? "closed" : "open";
    else if (domain === "switch" || domain === "light" || domain === "fan" || domain === "input_boolean" || domain === "siren") {
      next = prev === "on" ? "off" : "on";
    }
    patchEntityState(entityId, next);
    if (_ui.modalEntityId) updateModal(true);
    else if (_host) render(_host, { soft: true });
    try {
      if (domain === "lock") {
        await callService(domain, prev === "locked" ? "unlock" : "lock", entityId);
      } else if (domain === "cover") {
        await callService(domain, ["open", "opening"].includes(prev) ? "close_cover" : "open_cover", entityId);
      } else if (domain === "button") {
        await callService(domain, "press", entityId);
      } else if (domain === "media_player") {
        await callService(domain, "media_play_pause", entityId);
      } else if (domain === "switch" || domain === "light" || domain === "fan" || domain === "input_boolean" || domain === "siren") {
        await callService(domain, prev === "on" ? "turn_off" : "turn_on", entityId);
      } else {
        await callService(domain, "toggle", entityId);
      }
      await fetchAll();
      if (_host) render(_host, { soft: true });
      if (_ui.modalEntityId) updateModal(true);
    } catch (err) {
      console.error("[HomeAssistantWidget] toggle failed", err);
      patchEntityState(entityId, prev);
      if (_ui.modalEntityId) updateModal(true);
      else if (_host) render(_host, { soft: true });
    } finally {
      _busy.delete(entityId);
    }
  }

  function openLinkHtml(href) {
    return `<a class="ha-open-link" href="${escH(href)}" target="_blank" rel="noopener noreferrer">
      Open
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
        <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
      </svg>
    </a>`;
  }

  function buildSetup() {
    return `
      <div class="ha-shell">
        <div class="ha-header">
          <div class="ha-header-left">
            <img class="ha-icon" src="/icons/homeassistant.png" alt="Home Assistant">
            <div class="ha-brand">
              <div class="ha-title">Home Assistant</div>
              <div class="ha-subtitle">Token required</div>
            </div>
          </div>
          <div class="ha-header-right">
            ${openLinkHtml(HA_CONFIG.url)}
          </div>
        </div>
        <div class="ha-setup">Add a long-lived access token in <span>HA_CONFIG.token</span> to enable rooms and controls.</div>
      </div>`;
  }

  function buildChip(label, value, cls = "") {
    return `<div class="ha-chip ${cls}"><span class="ha-chip-value">${escH(value)}</span><span class="ha-chip-label">${escH(label)}</span></div>`;
  }

  async function mediaAction(entityId, action) {
    if (_busy.has(entityId)) return;
    _busy.add(entityId);
    try {
      if (action === "playpause") await callService("media_player", "media_play_pause", entityId);
      else if (action === "stop") await callService("media_player", "media_stop", entityId);
      await fetchAll();
      if (_host) render(_host, { soft: true });
      if (_ui.modalEntityId) updateModal(true);
    } catch (err) {
      console.error("[HomeAssistantWidget] media action failed", err);
    } finally {
      _busy.delete(entityId);
    }
  }

  function cardStatusLine(device) {
    const { entity, kind } = device;
    if (!entity) return "Not linked in HA";
    const related = _data?.layout ? relatedEntities(entity, _data.layout) : [];
    if (kind === "camera") {
      const stem = entityStem(entity.entity_id);
      const battery = related.find(s => s.entity_id === `sensor.${stem}_battery`) || related.find(s => /battery/i.test(s.entity_id));
      const motionSw = related.find(s => /motion_detection/i.test(s.entity_id));
      const parts = [];
      if (battery?.state != null) parts.push(`🔋 ${battery.state}%`);
      if (motionSw) parts.push(`Motion ${motionSw.state}`);
      const motionEvt = related.find(s => domainOf(s) === "event" && /motion/i.test(s.entity_id));
      if (motionEvt) {
        const v = isRecentActivity(motionEvt) ? "Just now" : timeAgo(motionEvt.state);
        if (v) parts.push(`Activity ${v}`);
      }
      if (!parts.length) parts.push(stateLabel(entity));
      return parts.join(" · ");
    }
    if (kind === "media") {
      if (isUnavailable(entity)) return "Offline";
      const title = entity.attributes?.media_title;
      const app = entity.attributes?.app_name;
      if (title && entity.attributes?.media_artist) return `${title} · ${entity.attributes.media_artist}`;
      if (title) return title;
      if (app) return app;
      return stateLabel(entity);
    }
    if (kind === "appliance") {
      const toner = related.find(s => /_bk$|black_toner|toner_remaining/i.test(s.entity_id));
      const parts = [stateLabel(entity)];
      if (toner?.state != null) parts.push(`Toner ${toner.state}%`);
      return parts.join(" · ");
    }
    return stateLabel(entity);
  }

  function cardBadge(device) {
    const { entity, kind } = device;
    if (!entity) return { text: "Setup", cls: "muted" };
    if (isUnavailable(entity)) return { text: "Offline", cls: "muted" };
    if (kind === "camera") {
      const related = _data?.layout ? relatedEntities(entity, _data.layout) : [];
      const motionEvt = related.find(e => domainOf(e) === "event" && /motion|ding/i.test(e.entity_id));
      if (motionEvt && isRecentActivity(motionEvt)) return { text: "Motion", cls: "active" };
      return { text: "Live", cls: "live" };
    }
    if (kind === "media" && tileActive(entity)) return { text: "On", cls: "active" };
    if (kind === "appliance" && (tileActive(entity) || entity.state === "running")) return { text: "Active", cls: "active" };
    return { text: stateLabel(entity), cls: "muted" };
  }

  function buildDeviceGlyph(deviceId) {
    return DEVICE_GLYPHS[deviceId] || DEVICE_GLYPHS.tv;
  }

  function buildGridCardVisual(device) {
    const { entity, kind, id } = device;
    const glyph = `<span class="ha-grid-card-glyph">${buildDeviceGlyph(id)}</span>`;
    const glow = `<span class="ha-grid-card-glow" aria-hidden="true"></span>`;
    if (!entity) {
      return `<div class="ha-grid-card-visual ha-grid-card-visual--${escA(id)}">${glow}${glyph}</div>`;
    }
    if (kind === "camera") {
      const eid = escA(entity.entity_id);
      return `<div class="ha-grid-card-visual ha-grid-card-visual--camera ha-grid-card-visual--${escA(id)}">${glow}<img class="ha-grid-card-preview ha-cam-img" data-camera-id="${eid}" alt="">${glyph}</div>`;
    }
    const art = kind === "media" && entity.attributes?.entity_picture
      ? `<img class="ha-grid-card-art" src="${escH(entity.attributes.entity_picture)}" alt="">`
      : "";
    return `<div class="ha-grid-card-visual ha-grid-card-visual--${escA(kind)} ha-grid-card-visual--${escA(id)}">${glow}${art}${glyph}</div>`;
  }

  function buildGridCard(device) {
    const { entity, label, kind, id } = device;
    const badge = cardBadge(device);
    const missing = !entity;
    const eid = entity ? escA(entity.entity_id) : "";
    const tag = missing ? "div" : "button";
    const attrs = missing
      ? ` class="ha-grid-card ha-grid-card--${escA(id)} ha-grid-card--missing"`
      : ` type="button" class="ha-grid-card ha-grid-card--${escA(kind)} ha-grid-card--${escA(id)}" data-ha-action="device" data-entity-id="${eid}" aria-label="Open ${escA(label)}"`;
    return `<${tag}${attrs}>
      ${buildGridCardVisual(device)}
      <div class="ha-grid-card-body">
        <div class="ha-grid-card-title">${escH(label)}</div>
        <div class="ha-grid-card-status">${escH(cardStatusLine(device))}</div>
      </div>
      <span class="ha-grid-card-badge ha-grid-card-badge--${escA(badge.cls)}">${escH(badge.text)}</span>
    </${tag}>`;
  }

  function buildModalHero(device, entity) {
    const glyph = buildDeviceGlyph(device?.id || "tv");
    const kind = device?.kind || "device";
    if (kind === "media") {
      const title = entity.attributes?.media_title || friendly(entity);
      const sub = entity.attributes?.media_artist
        ? `${entity.attributes.media_artist}${entity.attributes.app_name ? ` · ${entity.attributes.app_name}` : ""}`
        : (entity.attributes?.app_name || stateLabel(entity));
      const art = entity.attributes?.entity_picture
        ? `<img class="ha-device-hero-art" src="${escH(entity.attributes.entity_picture)}" alt="">`
        : `<span class="ha-device-hero-glyph">${glyph}</span>`;
      return `<div class="ha-device-hero ha-device-hero--media ha-device-hero--${escA(device?.id || "tv")}">${art}<div class="ha-device-hero-text"><div class="ha-device-hero-title">${escH(title)}</div><div class="ha-device-hero-sub">${escH(sub)}</div></div></div>`;
    }
    return `<div class="ha-device-hero ha-device-hero--${escA(kind)} ha-device-hero--${escA(device?.id || "device")}"><span class="ha-device-hero-glyph">${glyph}</span><div class="ha-device-hero-text"><div class="ha-device-hero-title">${escH(device?.label || friendly(entity))}</div><div class="ha-device-hero-sub">${escH(stateLabel(entity))}</div></div></div>`;
  }

  function buildWidget() {
    if (!isConfigured()) return buildSetup();
    if (_error && !_data) {
      return `<div class="ha-shell"><div class="ha-error">Unable to load Home Assistant: ${escH(_error)}</div></div>`;
    }
    const s = _data?.summary;
    if (!s) return `<div class="ha-shell"><div class="ha-loading">Loading Home Assistant…</div></div>`;

    const temp = s.weather?.attributes?.temperature;
    const weatherTxt = s.weather ? `${temp != null ? `${temp}°` : ""}${temp != null && s.weather.state ? " · " : ""}${s.weather.state || ""}`.trim() : null;
    const devices = _data.devices || [];
    const alertCount = s.alerts.length;
    const weatherChip = weatherTxt ? buildChip("Weather", weatherTxt, "ha-chip--cyan") : "";
    const alertChip = alertCount ? buildChip("Alerts", String(alertCount), "ha-chip--red") : "";
    const statsHtml = (weatherChip || alertChip)
      ? `<div class="ha-header-stats">${weatherChip}${alertChip}</div>`
      : "";
    const grid = devices.map(buildGridCard).join("");

    return `
      <div class="ha-shell">
        <div class="ha-header">
          <div class="ha-header-left">
            <img class="ha-icon" src="/icons/homeassistant.png" alt="Home Assistant">
            <div class="ha-brand">
              <div class="ha-title">Home Assistant</div>
              <div class="ha-subtitle">${escH(_data.config?.location_name || "Smart Home")}</div>
            </div>
          </div>
          <div class="ha-header-right">
            <span class="ha-status ${_error ? "ha-status--warn" : "ha-status--ok"}">${_error ? "Degraded" : "Online"}</span>
            ${openLinkHtml(HA_CONFIG.activeUrl || HA_CONFIG.url)}
          </div>
        </div>
        ${statsHtml}

        <div class="ha-main">
          ${grid ? `<div class="ha-device-grid">${grid}</div>` : `<div class="ha-empty">No devices configured.</div>`}
        </div>

        <div class="ha-footer">Updated ${_data.updated.toLocaleTimeString()}</div>
      </div>`;
  }

  function ensureModal() {
    const existing = document.getElementById("ha-camera-modal-overlay");
    if (existing && !existing.querySelector("#ha-device-modal-hero")) existing.remove();
    if (document.getElementById("ha-camera-modal-overlay")) return;
    const overlay = document.createElement("div");
    overlay.id = "ha-camera-modal-overlay";
    overlay.innerHTML = `
      <div class="ha-camera-modal" role="dialog" aria-modal="true" aria-label="Device details">
        <button type="button" class="ha-camera-modal-close" data-ha-action="close-modal" aria-label="Close">✕</button>
        <div class="ha-camera-modal-head">
          <div class="ha-camera-modal-head-text">
            <div class="ha-camera-modal-title" id="ha-camera-modal-title"></div>
            <div class="ha-camera-modal-sub" id="ha-camera-modal-sub"></div>
          </div>
          <span class="ha-camera-modal-badge" id="ha-camera-modal-badge"></span>
        </div>
        <div id="ha-device-modal-hero"></div>
        <div class="ha-camera-modal-feed" id="ha-device-modal-feed">
          <div class="ha-cam-fallback">
            <span class="ha-cam-fallback-icon">📷</span>
            <p class="ha-cam-fallback-title">Connecting…</p>
            <p class="ha-cam-fallback-note">Starting live stream via Home Assistant.</p>
            <a class="ha-btn ha-btn--primary" id="ha-camera-modal-open-inline" target="_blank" rel="noopener">Open in HA</a>
          </div>
          <video class="ha-cam-video" id="ha-camera-modal-video" autoplay playsinline muted></video>
          <img class="ha-cam-img" id="ha-camera-modal-img" data-camera-id="" alt="">
        </div>
        <div class="ha-camera-modal-body">
          <div id="ha-device-modal-actions"></div>
          <div id="ha-camera-modal-stats"></div>
          <div id="ha-camera-modal-toggles"></div>
        </div>
        <div class="ha-camera-modal-actions">
          <a class="ha-btn ha-btn--primary ha-btn--wide" id="ha-camera-modal-open" target="_blank" rel="noopener">Open in Home Assistant</a>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", e => { if (e.target === overlay) closeModal(); });
    overlay.addEventListener("click", e => {
      const btn = e.target.closest("[data-ha-action]");
      if (!btn) return;
      if (btn.dataset.haAction === "toggle") {
        e.preventDefault();
        e.stopPropagation();
        toggleEntity(btn.dataset.entityId);
      }
      if (btn.dataset.haAction === "media-playpause") {
        e.preventDefault();
        e.stopPropagation();
        mediaAction(btn.dataset.entityId, "playpause");
      }
      if (btn.dataset.haAction === "media-stop") {
        e.preventDefault();
        e.stopPropagation();
        mediaAction(btn.dataset.entityId, "stop");
      }
    });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && _ui.modalEntityId) closeModal(); });
  }

  function stopSnapshotTimer() {
    if (_snapshotTimer) { clearInterval(_snapshotTimer); _snapshotTimer = null; }
  }

  function startSnapshotTimer(entityId) {
    stopSnapshotTimer();
    _snapshotTimer = setInterval(() => {
      if (_ui.modalEntityId !== entityId) return;
      const video = document.getElementById("ha-camera-modal-video");
      if (video?.classList.contains("ha-cam-video--active")) return;
      const img = document.getElementById("ha-camera-modal-img");
      if (img) img.src = cameraSnapshotUrl(entityId);
    }, HA_CONFIG.snapshotRefreshMs);
  }

  function updateModal(soft = false) {
    if (!_ui.modalEntityId || !_data) return;
    const entity = _data.layout?.stateMap?.[_ui.modalEntityId] || _data.states.find(s => s.entity_id === _ui.modalEntityId);
    if (!entity) return;
    ensureModal();
    const device = getDeviceConfig(entity.entity_id);
    const kind = device?.kind || (domainOf(entity) === "camera" ? "camera" : "device");
    const overlay = document.getElementById("ha-camera-modal-overlay");
    const title = document.getElementById("ha-camera-modal-title");
    const sub = document.getElementById("ha-camera-modal-sub");
    const badge = document.getElementById("ha-camera-modal-badge");
    const feedEl = document.getElementById("ha-device-modal-feed");
    const heroEl = document.getElementById("ha-device-modal-hero");
    const statsEl = document.getElementById("ha-camera-modal-stats");
    const togglesEl = document.getElementById("ha-camera-modal-toggles");
    const actionsEl = document.getElementById("ha-device-modal-actions");
    const openLink = document.getElementById("ha-camera-modal-open");
    const related = modalRelatedEntities(entity, _data.layout);
    const motionEvt = related.find(e => /motion/i.test(e.entity_id) && domainOf(e) === "event");

    title.textContent = device?.label || shortName(entity) || friendly(entity);
    sub.textContent = `${entity.state}${entity.last_changed ? ` · updated ${timeAgo(entity.last_changed)}` : ""}`;
    if (kind === "camera") {
      const hasActivity = motionEvt && isRecentActivity(motionEvt);
      badge.textContent = hasActivity ? "Motion" : "Live";
      badge.className = `ha-camera-modal-badge${hasActivity ? " ha-camera-modal-badge--active" : ""}`;
      badge.style.display = "";
    } else if (kind === "media" && tileActive(entity)) {
      badge.textContent = "Playing";
      badge.className = "ha-camera-modal-badge ha-camera-modal-badge--active";
      badge.style.display = "";
    } else {
      badge.style.display = "none";
    }

    if (kind === "camera") {
      feedEl.style.display = "";
      heroEl.innerHTML = "";
      if (!soft) {
        startCameraFeed(entity.entity_id);
        startSnapshotTimer(entity.entity_id);
      }
    } else {
      stopSnapshotTimer();
      stopWebRtc();
      feedEl.style.display = "none";
      heroEl.innerHTML = buildModalHero(device || { id: "tv", kind: "device" }, entity);
    }

    actionsEl.innerHTML = buildModalActions(entity);
    statsEl.innerHTML = buildModalStats(related, entity);
    togglesEl.innerHTML = buildModalToggles(related);
    const haUrl = haEntityUrl(entity.entity_id);
    openLink.href = haUrl;
    document.getElementById("ha-camera-modal-open-inline")?.setAttribute("href", haUrl);
    overlay.classList.add("ha-camera-modal--visible");
  }

  function openModal(entityId) {
    _ui.modalEntityId = entityId;
    updateModal(false);
  }

  function closeModal() {
    _ui.modalEntityId = null;
    stopSnapshotTimer();
    stopWebRtc();
    document.getElementById("ha-camera-modal-overlay")?.classList.remove("ha-camera-modal--visible");
  }

  function attachListeners(host) {
    if (host.__haBound) return;
    host.__haBound = true;
    host.addEventListener("click", e => {
      const btn = e.target.closest("[data-ha-action]");
      if (!btn || !host.contains(btn)) return;
      const action = btn.dataset.haAction;
      if (action === "toggle") {
        e.preventDefault();
        e.stopPropagation();
        toggleEntity(btn.dataset.entityId);
        return;
      }
      if (action === "device" || action === "camera") {
        e.preventDefault();
        openModal(btn.dataset.entityId);
      }
    });
  }

  function bindGlobalHaActions() {
    if (document.body.dataset.haGlobalBound) return;
    document.body.dataset.haGlobalBound = "1";
    document.addEventListener("click", e => {
      const btn = e.target.closest("[data-ha-action]");
      if (!btn) return;
      if (btn.dataset.haAction === "close-modal") closeModal();
    });
  }

  function render(host, opts = {}) {
    if (!host) return;
    _host = host;
    const scrollY = window.scrollY;
    host.innerHTML = buildWidget();
    attachListeners(host);
    primeAllCameraImgs(host);
    _rendered = true;
    if (_ui.modalEntityId) updateModal(true);
    if (!opts.soft) window.scrollTo({ top: scrollY, behavior: "instant" });
  }

  async function refresh() {
    const group = findGroupContainer();
    if (!group) return;
    const host = ensureHost(group);
    try {
      await fetchAll();
    } catch (err) {
      console.error("[HomeAssistantWidget]", err);
      _error = err.message || String(err);
    }
    render(host, { soft: true });
  }

  function startPolling() {
    if (_pollTimer) clearInterval(_pollTimer);
    _pollTimer = setInterval(refresh, HA_CONFIG.pollMs);
  }

  function init() {
    bindGlobalHaActions();
    HpWidgetBoot.watch("homeassistant", {
      ready: () => !!document.querySelector(".ha-host .ha-shell"),
      setup: () => startPolling(),
      mount: () => refresh(),
    });
  }

  init();
})();
