#!/usr/bin/env node
// Generates synthetic own-vessel passages (one GPX per passage, spread over
// the last ~2 years around the Gulf of Finland / Archipelago Sea) and imports
// them into the tracks plugin of a running Signal K server.
//
// usage: node dev/generate-tracks.js [serverUrl] [passages]
const server = (process.argv[2] || "http://localhost:3000").replace(/\/+$/, "");
const passages = parseInt(process.argv[3] || "40", 10);
const DAY = 86400000;

let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

function passage(startTime) {
  let lat = 59.6 + rand() * 0.8;
  let lng = 22.0 + rand() * 3.5;
  let heading = rand() * 2 * Math.PI;
  const points = [];
  const n = 300 + Math.floor(rand() * 900);
  for (let i = 0; i < n; i++) {
    heading += (rand() - 0.5) * 0.3;
    const step = 0.0006; // ~65 m every 10 s, about 12 knots
    lat += Math.cos(heading) * step;
    lng += (Math.sin(heading) * step) / Math.cos((lat * Math.PI) / 180);
    points.push({ lat, lng, time: new Date(startTime + i * 10000).toISOString() });
  }
  return points;
}

function gpx(points) {
  const pts = points
    .map((p) => `<trkpt lat="${p.lat.toFixed(6)}" lon="${p.lng.toFixed(6)}"><time>${p.time}</time></trkpt>`)
    .join("");
  return `<?xml version="1.0"?><gpx version="1.1" creator="tracks-sharing-dev" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Own Ship</name><trkseg>${pts}</trkseg></trk></gpx>`;
}

(async () => {
  const now = Date.now();
  for (let i = 0; i < passages; i++) {
    const start = now - (1 + (i * 700) / passages + rand() * 10) * DAY;
    const res = await fetch(`${server}/plugins/tracks/imports?self=true`, {
      method: "POST",
      headers: { "Content-Type": "application/gpx+xml" },
      body: gpx(passage(start)),
    });
    console.log(`passage ${i + 1}/${passages}: HTTP ${res.status}`);
    if (!res.ok) {
      console.error(await res.text());
      process.exit(1);
    }
  }
})();
