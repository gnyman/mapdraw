/* Track/drawing codec shared by the webapp. Same binary format (version 2) as
 * the gh-pages application, so URLs are interchangeable. UMD: browser global
 * `TrackCodec`, or require() in node tests. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.TrackCodec = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  const TYPES = ["freehand", "line", "circle", "arrow"];
  const SERVER_COLOR = 0;
  const USER_COLOR = 5;

  function writeVarUint(target, value) {
    let v = value >>> 0;
    while (v >= 0x80) {
      target.push((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    target.push(v & 0x7f);
  }

  function writeVarInt(target, value) {
    writeVarUint(target, ((value << 1) ^ (value >> 31)) >>> 0);
  }

  function readVarUint(bytes, cursor) {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (cursor.index >= bytes.length || shift > 35) {
        throw new Error("Corrupt drawing payload");
      }
      const byte = bytes[cursor.index++];
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result >>> 0;
      shift += 7;
    }
  }

  function readVarInt(bytes, cursor) {
    const raw = readVarUint(bytes, cursor);
    return ((raw >>> 1) ^ -(raw & 1)) | 0;
  }

  /** paths: [{type, colorIndex, strokeWidthIndex?, points:[{lat,lng}]}] */
  function encodePaths(paths) {
    const prepared = [];
    paths.forEach((path) => {
      const points = [];
      let lastLat = null;
      let lastLng = null;
      path.points.forEach((p) => {
        if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return;
        const lat = Math.round(p.lat * 1e6);
        const lng = Math.round(p.lng * 1e6);
        if (lat !== lastLat || lng !== lastLng) {
          points.push({ lat, lng });
          lastLat = lat;
          lastLng = lng;
        }
      });
      if (points.length) prepared.push({ path, points });
    });

    const bytes = [2];
    writeVarUint(bytes, prepared.length);
    prepared.forEach(({ path, points }) => {
      const typeCode = Math.max(0, TYPES.indexOf(path.type || "line"));
      const width = path.strokeWidthIndex === undefined ? 1 : path.strokeWidthIndex;
      bytes.push(
        ((typeCode & 3) << 6) | ((width & 3) << 4) | ((path.colorIndex || 0) & 15),
      );
      writeVarUint(bytes, points.length);
      let prevLat = 0;
      let prevLng = 0;
      points.forEach((p) => {
        writeVarInt(bytes, p.lat - prevLat);
        writeVarInt(bytes, p.lng - prevLng);
        prevLat = p.lat;
        prevLng = p.lng;
      });
    });
    return new Uint8Array(bytes);
  }

  function decodePaths(bytes) {
    if (!bytes || bytes.length < 2 || bytes[0] !== 2) {
      throw new Error("Unsupported drawing format");
    }
    const cursor = { index: 1 };
    const count = readVarUint(bytes, cursor);
    const paths = [];
    for (let i = 0; i < count; i++) {
      if (cursor.index >= bytes.length) throw new Error("Corrupt drawing payload");
      const meta = bytes[cursor.index++];
      const n = readVarUint(bytes, cursor);
      const points = [];
      let lat = 0;
      let lng = 0;
      for (let p = 0; p < n; p++) {
        lat += readVarInt(bytes, cursor);
        lng += readVarInt(bytes, cursor);
        points.push({ lat: lat / 1e6, lng: lng / 1e6 });
      }
      paths.push({
        type: TYPES[(meta >> 6) & 3],
        strokeWidthIndex: (meta >> 4) & 3,
        colorIndex: meta & 15,
        points,
      });
    }
    return paths;
  }

  function isServerPath(path) {
    return path.type === "line" && path.colorIndex === SERVER_COLOR;
  }

  function toUrlSafeBase64(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function fromUrlSafeBase64(str) {
    const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  /** Douglas-Peucker on {lat,lng} points; tolerance in degrees. */
  function simplify(points, tolerance) {
    if (points.length <= 2 || !(tolerance > 0)) return points.slice();
    const keep = new Uint8Array(points.length);
    keep[0] = keep[points.length - 1] = 1;
    const stack = [[0, points.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      let maxD = 0;
      let idx = -1;
      for (let i = a + 1; i < b; i++) {
        const d = segDist(points[i], points[a], points[b]);
        if (d > maxD) {
          maxD = d;
          idx = i;
        }
      }
      if (idx !== -1 && maxD > tolerance) {
        keep[idx] = 1;
        stack.push([a, idx], [idx, b]);
      }
    }
    return points.filter((_, i) => keep[i]);
  }

  function segDist(p, a, b) {
    const dx = b.lng - a.lng;
    const dy = b.lat - a.lat;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((p.lng - a.lng) * dx + (p.lat - a.lat) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.lng - (a.lng + t * dx), p.lat - (a.lat + t * dy));
  }

  /** Simplification tolerance (degrees) for a bbox [w,s,e,n]: 1/800 of its larger side. */
  function toleranceForBbox(bbox) {
    let width = bbox[2] - bbox[0];
    if (width < 0) width += 360;
    return Math.max(width, bbox[3] - bbox[1]) / 800;
  }

  /** TracksResponse (FeatureCollection of MultiLineString) -> server paths.
   * With `times=true` each path also gets `from`/`to` (ms) from `coordTimes`;
   * these are not part of the URL encoding. */
  function featuresToPaths(collection) {
    const paths = [];
    ((collection && collection.features) || []).forEach((feature) => {
      const geometry = feature.geometry;
      if (!geometry || !geometry.coordinates) return;
      const lines =
        geometry.type === "LineString" ? [geometry.coordinates] : geometry.coordinates;
      const coordTimes = (feature.properties && feature.properties.coordTimes) || [];
      const timesOf = geometry.type === "LineString" ? [coordTimes] : coordTimes;
      lines.forEach((line, i) => {
        const points = line.map((c) => ({ lat: c[1], lng: c[0] }));
        if (points.length >= 2) {
          const path = { type: "line", colorIndex: SERVER_COLOR, strokeWidthIndex: 1, points };
          const times = timesOf[i];
          if (times && times.length) {
            path.from = Date.parse(times[0]);
            path.to = Date.parse(times[times.length - 1]);
          }
          paths.push(path);
        }
      });
    });
    return paths;
  }

  return {
    SERVER_COLOR,
    USER_COLOR,
    encodePaths,
    decodePaths,
    isServerPath,
    toUrlSafeBase64,
    fromUrlSafeBase64,
    simplify,
    toleranceForBbox,
    featuresToPaths,
  };
});
