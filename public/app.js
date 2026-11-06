(function () {
  const C = window.TrackCodec;
  const DAY = 86400000;
  const PALETTE = ["#FF3B30", "#FF9500", "#FFCC00", "#4CD964", "#5AC8FA", "#007AFF", "#5856D6", "#AF52DE", "#FF2D55", "#8E8E93", "#FF6B81", "#2ECC71", "#1ABC9C", "#3498DB", "#9B59B6", "#34495E"];
  const PRESET_DAYS = { "10y": 3652, "5y": 1826, "2y": 730, "1y": 365, "6m": 183, "3m": 91, "1m": 30 };
  const PUBLIC_BASE = "https://tkurki.github.io/trackdraw/";
  const $ = (id) => document.getElementById(id);

  const onSignalK = location.pathname.indexOf("/signalk-tracks-sharing/") === 0;
  const apiInput = $("apiBase");
  apiInput.value =
    localStorage.getItem("tracksApiBase") || (onSignalK ? location.origin : "https://demo.signalk.io");
  apiInput.addEventListener("change", () => localStorage.setItem("tracksApiBase", apiInput.value.trim()));

  const state = {
    live: true,
    drawing: false,
    serverPaths: [],
    userPaths: [],
    // [from, to] per fetched server path; the URL carries no times
    trackTimes: [],
    rangeStart: 0,
    rangeEnd: 0,
    selStart: null,
    selEnd: null,
    fetchTimer: null,
    fetchSeq: 0,
    suppressMove: false,
  };

  const map = L.map("map").setView([0, 0], 2);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);
  const layer = L.layerGroup().addTo(map);

  /* ---------- URL <-> state ---------- */

  function parseHash() {
    const params = new URLSearchParams(location.hash.substring(1));
    const [lat, lng] = (params.get("l") || "").split(",").map(parseFloat);
    const z = parseInt(params.get("z"), 10);
    return { lat, lng, z, d: params.get("d") || "" };
  }

  function writeUrl() {
    const c = map.getCenter();
    const params = new URLSearchParams();
    params.set("l", c.lat.toFixed(6) + "," + c.lng.toFixed(6));
    params.set("z", String(map.getZoom()));
    const all = state.serverPaths.concat(state.userPaths);
    if (all.length) {
      const bytes = window.UZIP.deflateRaw(C.encodePaths(all));
      params.set("d", C.toUrlSafeBase64(new Uint8Array(bytes)));
    }
    history.replaceState(null, "", location.pathname + location.search + "#" + params.toString());
  }

  /** Render whatever the URL says. The URL is the source of truth. */
  function applyHash(moveView) {
    const h = parseHash();
    let paths = [];
    if (h.d) {
      try {
        const inflated = window.UZIP.inflateRaw(C.fromUrlSafeBase64(h.d));
        paths = C.decodePaths(new Uint8Array(inflated));
      } catch (e) {
        setStatus("Could not read drawing from URL: " + e.message);
      }
    }
    state.serverPaths = paths.filter(C.isServerPath);
    state.userPaths = paths.filter((p) => !C.isServerPath(p));
    if (moveView && Number.isFinite(h.lat) && Number.isFinite(h.lng)) {
      state.suppressMove = true;
      map.setView([h.lat, h.lng], Number.isFinite(h.z) ? h.z : map.getZoom(), { animate: false });
      state.suppressMove = false;
    }
    layer.clearLayers();
    const serverCount = paths.filter(C.isServerPath).length;
    const times = state.trackTimes.length === serverCount ? state.trackTimes : [];
    let serverIndex = 0;
    paths.forEach((p) => {
      const line = L.polyline(
        p.points.map((pt) => [pt.lat, pt.lng]),
        { color: PALETTE[p.colorIndex % 16], weight: [2, 3, 5, 8][p.strokeWidthIndex] || 3, interactive: false },
      ).addTo(layer);
      const range = C.isServerPath(p) ? times[serverIndex++] : null;
      if (range) addTrackInfo(line, range[0], range[1]);
    });
    return paths;
  }

  /** Hover shows the track's time range; click offers to show only that range. */
  function addTrackInfo(line, from, to) {
    const weight = line.options.weight;
    const label = fmt(from) + " → " + fmt(to) + " (" + duration(to - from) + ")";
    // a wider invisible line is easier to hit than the drawn one
    const hit = L.polyline(line.getLatLngs(), { weight: 14, opacity: 0 }).addTo(layer);
    hit.bindTooltip(label, { sticky: true });
    hit.on("mouseover", () => line.setStyle({ weight: weight + 3 }));
    hit.on("mouseout", () => line.setStyle({ weight }));
    hit.on("click", (ev) => {
      if (state.drawing) return;
      const content = L.DomUtil.create("div");
      L.DomUtil.create("div", "", content).textContent = label;
      const button = L.DomUtil.create("button", "", content);
      button.textContent = "Show only this time range";
      button.style.marginTop = "6px";
      const popup = L.popup().setLatLng(ev.latlng).setContent(content).openOn(map);
      button.addEventListener("click", () => {
        map.closePopup(popup);
        showOnly(from, to);
      });
    });
  }

  function duration(ms) {
    const min = Math.round(ms / 60000);
    if (min < 60) return min + " min";
    if (min < 48 * 60) return Math.floor(min / 60) + " h " + (min % 60) + " min";
    return Math.round(min / 1440) + " d";
  }

  function setLive(on) {
    state.live = on;
    $("liveChk").checked = on;
    $("liveState").textContent = on ? "Continuous update on" : "Continuous update off";
    $("liveState").className = on ? "" : "off";
  }

  function setStatus(text) {
    $("status").textContent = text;
  }

  /* ---------- tracks API ---------- */

  function currentBbox() {
    const b = map.getBounds();
    let w = b.getWest();
    let e = b.getEast();
    if (e - w >= 360) {
      w = -180;
      e = 180;
    } else {
      w = L.Util.wrapNum(w, [-180, 180], true);
      e = L.Util.wrapNum(e, [-180, 180], true);
    }
    return [w, Math.max(-90, b.getSouth()), e, Math.min(90, b.getNorth())].map((v) => +v.toFixed(6));
  }

  async function fetchTracks() {
    const seq = ++state.fetchSeq;
    const bbox = currentBbox();
    const from = state.selStart !== null ? state.selStart : state.rangeStart;
    const to = state.selEnd !== null ? state.selEnd : state.rangeEnd;
    const sw = L.latLng(bbox[1], bbox[0]);
    const ne = L.latLng(bbox[3], bbox[2]);
    // half a screen pixel, in metres
    const pixels = map.getSize().distanceTo(L.point(0, 0)) || 1000;
    const epsilon = Math.max(1, Math.round(sw.distanceTo(ne) / pixels / 2));
    const q = new URLSearchParams({
      bbox: bbox.join(","),
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      simplify: "true",
      epsilon: String(epsilon),
      maxPoints: "200000",
      times: "true",
    });
    const base = apiInput.value.trim().replace(/\/+$/, "");
    setStatus("Fetching…");
    try {
      const res = await fetch(base + "/signalk/v2/api/tracks?" + q.toString());
      if (!res.ok) throw new Error("HTTP " + res.status);
      const json = await res.json();
      if (seq !== state.fetchSeq || !state.live) return;
      state.serverPaths = C.featuresToPaths(json);
      state.trackTimes = state.serverPaths.map((p) => (Number.isFinite(p.from) ? [p.from, p.to] : null));
      writeUrl();
      applyHash(false);
      setStatus(state.serverPaths.length + " track segments, " + (json.features || []).length + " tracks");
    } catch (e) {
      if (seq === state.fetchSeq) setStatus("Fetch failed: " + e.message);
    }
  }

  function scheduleFetch() {
    if (!state.live) return;
    clearTimeout(state.fetchTimer);
    state.fetchTimer = setTimeout(fetchTracks, 400);
  }

  /* ---------- map events ---------- */

  map.on("moveend", () => {
    if (state.suppressMove) return;
    writeUrl();
    scheduleFetch();
  });

  window.addEventListener("hashchange", () => {
    // replaceState does not fire this, so any event here is a manual edit
    setLive(false);
    clearTimeout(state.fetchTimer);
    state.trackTimes = [];
    applyHash(true);
  });

  $("fetchBtn").addEventListener("click", fetchTracks);
  $("liveChk").addEventListener("change", (ev) => {
    if (ev.target.checked) {
      state.userPaths = [];
      setLive(true);
      fetchTracks();
    } else {
      setLive(false);
      clearTimeout(state.fetchTimer);
    }
  });
  $("clearBtn").addEventListener("click", () => {
    state.userPaths = [];
    writeUrl();
    applyHash(false);
  });
  $("copyBtn").addEventListener("click", async () => {
    const url = PUBLIC_BASE + location.hash;
    try {
      // the clipboard API needs a secure context, which a plain http server is not
      await navigator.clipboard.writeText(url);
      setStatus("Public URL copied");
    } catch (e) {
      window.prompt("Copy the public URL", url);
    }
  });

  /* ---------- drawing ---------- */

  const mapEl = $("map");
  let stroke = null;
  let preview = null;
  $("drawBtn").addEventListener("click", () => {
    state.drawing = !state.drawing;
    $("drawBtn").classList.toggle("active", state.drawing);
    mapEl.style.cursor = state.drawing ? "crosshair" : "";
    state.drawing ? map.dragging.disable() : map.dragging.enable();
  });
  mapEl.addEventListener("pointerdown", (ev) => {
    if (!state.drawing || ev.target.closest(".leaflet-control")) return;
    stroke = [map.mouseEventToLatLng(ev)];
    preview = L.polyline(stroke, { color: PALETTE[C.USER_COLOR], weight: 3 }).addTo(map);
    mapEl.setPointerCapture(ev.pointerId);
  });
  mapEl.addEventListener("pointermove", (ev) => {
    if (!stroke) return;
    stroke.push(map.mouseEventToLatLng(ev));
    preview.setLatLngs(stroke);
  });
  mapEl.addEventListener("pointerup", () => {
    if (!stroke) return;
    const points = C.simplify(
      stroke.map((l) => ({ lat: l.lat, lng: l.lng })),
      C.toleranceForBbox(currentBbox()) / 4,
    );
    map.removeLayer(preview);
    stroke = preview = null;
    if (points.length < 2) return;
    // extra markings freeze the view: no more automatic fetching
    setLive(false);
    clearTimeout(state.fetchTimer);
    state.userPaths.push({ type: "freehand", colorIndex: C.USER_COLOR, strokeWidthIndex: 1, points });
    writeUrl();
    applyHash(false);
  });

  /* ---------- timeline ---------- */

  const bar = $("timelineBar");
  const sel = $("selection");
  const fmt = (t) => new Date(t).toISOString().slice(0, 16).replace("T", " ");

  function setRange(start, end) {
    const now = Date.now();
    end = Math.min(end, now);
    start = Math.min(start, end - 3600000);
    state.rangeStart = start;
    state.rangeEnd = end;
    state.selStart = state.selEnd = null;
    renderTimeline();
    scheduleFetch();
  }

  function pct(t) {
    return ((t - state.rangeStart) / (state.rangeEnd - state.rangeStart)) * 100;
  }

  /** Zoom the timeline to a track's time range, padded, and select exactly that range. */
  function showOnly(from, to) {
    const pad = Math.max((to - from) / 10, 10 * 60000);
    setRange(from - pad, to + pad);
    state.selStart = Math.max(from, state.rangeStart);
    state.selEnd = Math.min(to, state.rangeEnd);
    renderTimeline();
  }

  function renderTimeline() {
    bar.querySelectorAll(".tick").forEach((n) => n.remove());
    const span = state.rangeEnd - state.rangeStart;
    const steps = [3600000, 6 * 3600000, DAY, 7 * DAY, 30 * DAY, 91 * DAY, 365 * DAY];
    const step = steps.find((s) => span / s <= 12) || 365 * DAY;
    for (let t = Math.ceil(state.rangeStart / step) * step; t < state.rangeEnd; t += step) {
      const tick = document.createElement("div");
      tick.className = "tick";
      tick.style.left = pct(t) + "%";
      const label = document.createElement("span");
      label.textContent = step >= DAY ? fmt(t).slice(0, 10) : fmt(t).slice(5);
      tick.appendChild(label);
      bar.appendChild(tick);
    }
    if (state.selStart === null) {
      sel.style.display = "none";
    } else {
      sel.style.display = "block";
      sel.style.left = pct(state.selStart) + "%";
      sel.style.width = pct(state.selEnd) - pct(state.selStart) + "%";
    }
    $("timeLabel").textContent =
      state.selStart === null
        ? fmt(state.rangeStart) + " → " + fmt(state.rangeEnd)
        : "Selected " + fmt(state.selStart) + " → " + fmt(state.selEnd);
  }

  function timeAt(ev) {
    const r = bar.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
    return state.rangeStart + f * (state.rangeEnd - state.rangeStart);
  }

  document.querySelectorAll("[data-preset]").forEach((b) =>
    b.addEventListener("click", () => {
      const now = Date.now();
      setRange(now - PRESET_DAYS[b.dataset.preset] * DAY, now);
    }),
  );
  $("zoomIn").addEventListener("click", () => zoomTimeline(0.5));
  $("zoomOut").addEventListener("click", () => zoomTimeline(2));

  function zoomTimeline(factor) {
    const hasSel = state.selStart !== null;
    const centre = hasSel ? (state.selStart + state.selEnd) / 2 : (state.rangeStart + state.rangeEnd) / 2;
    const half = ((state.rangeEnd - state.rangeStart) * factor) / 2;
    const sS = state.selStart;
    const sE = state.selEnd;
    let start = centre - half;
    let end = centre + half;
    if (end > Date.now()) {
      start -= end - Date.now();
      end = Date.now();
    }
    setRange(start, end);
    if (hasSel && sS >= state.rangeStart && sE <= state.rangeEnd) {
      state.selStart = sS;
      state.selEnd = sE;
      renderTimeline();
    }
  }

  let dragFrom = null;
  bar.addEventListener("pointerdown", (ev) => {
    const handle = ev.target.dataset.handle;
    // a handle drags one edge: the same as a new selection anchored at the other edge
    dragFrom = handle === "start" ? state.selEnd : handle === "end" ? state.selStart : timeAt(ev);
    bar.setPointerCapture(ev.pointerId);
  });
  bar.addEventListener("pointermove", (ev) => {
    if (dragFrom === null) return;
    const t = timeAt(ev);
    state.selStart = Math.min(dragFrom, t);
    state.selEnd = Math.max(dragFrom, t);
    renderTimeline();
  });
  bar.addEventListener("pointerup", (ev) => {
    if (dragFrom === null) return;
    const moved = Math.abs(timeAt(ev) - dragFrom) > (state.rangeEnd - state.rangeStart) / 200;
    dragFrom = null;
    if (!moved) {
      state.selStart = state.selEnd = null;
    }
    renderTimeline();
    scheduleFetch();
  });

  /* ---------- start ---------- */

  const initial = parseHash();
  const now = Date.now();
  state.rangeEnd = now;
  state.rangeStart = now - PRESET_DAYS["1m"] * DAY;
  renderTimeline();
  const hadPaths = initial.d ? applyHash(true) : [];
  if (Number.isFinite(initial.lat) && Number.isFinite(initial.lng) && !initial.d) {
    map.setView([initial.lat, initial.lng], Number.isFinite(initial.z) ? initial.z : 2);
  }
  // a URL that already carries markings opens in frozen mode
  setLive(!hadPaths.some((p) => !C.isServerPath(p)));
  if (state.live) scheduleFetch();
  window.addEventListener("resize", () => map.invalidateSize());
})();
