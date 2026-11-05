const test = require("node:test");
const assert = require("node:assert");
const zlib = require("node:zlib");
const C = require("../public/codec.js");

test("encode/decode round trip", () => {
  const paths = [
    { type: "line", colorIndex: 0, strokeWidthIndex: 1, points: [{ lat: 60.1, lng: 24.9 }, { lat: 60.2, lng: -25.1 }] },
    { type: "freehand", colorIndex: 5, strokeWidthIndex: 1, points: [{ lat: -1.5, lng: 179.9 }, { lat: -1.6, lng: 179.8 }] },
  ];
  const decoded = C.decodePaths(C.encodePaths(paths));
  assert.deepStrictEqual(decoded, paths);
  assert.deepStrictEqual(decoded.map(C.isServerPath), [true, false]);
});

test("matches createlink.js format (deflate + urlsafe base64)", () => {
  const paths = [{ type: "line", colorIndex: 0, points: [{ lat: 60, lng: 24 }, { lat: 60.5, lng: 24.5 }] }];
  const b64 = C.toUrlSafeBase64(zlib.deflateRawSync(Buffer.from(C.encodePaths(paths))));
  const back = C.decodePaths(zlib.inflateRawSync(Buffer.from(C.fromUrlSafeBase64(b64))));
  assert.strictEqual(back[0].points.length, 2);
});

test("simplify drops collinear points and keeps ends", () => {
  const pts = [0, 1, 2, 3, 4].map((i) => ({ lat: i, lng: 0 }));
  assert.deepStrictEqual(C.simplify(pts, 0.1), [pts[0], pts[4]]);
  assert.strictEqual(C.simplify(pts, 0).length, 5);
});

test("featuresToPaths converts and simplifies MultiLineStrings", () => {
  const out = C.featuresToPaths(
    { features: [{ geometry: { type: "MultiLineString", coordinates: [[[0, 0], [0, 1], [0, 2]], [[5, 5]]] } }] },
    0.1,
  );
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].points.length, 2);
  assert.ok(C.isServerPath(out[0]));
});

test("toleranceForBbox handles antimeridian", () => {
  assert.strictEqual(C.toleranceForBbox([175, -10, -175, 10]), 20 / 800);
});
