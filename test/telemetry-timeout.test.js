/**
 * The telemetry uploader's default POST timeout must stay decoupled from the
 * eval-fetch DEFAULT_TIMEOUT. 1.1.0's hedge lowered DEFAULT_TIMEOUT 10s -> 3s
 * for read latency; sharing that constant silently clipped telemetry uploads
 * to 3s. TELEMETRY_TIMEOUT (10s) restores the intended background-flush budget.
 */

const path = require("path");

const apiHelpers = require(path.join(__dirname, "..", "dist", "apiHelpers"));
const TelemetryUploader = require(
  path.join(__dirname, "..", "dist", "telemetry", "uploader")
).default;

test("telemetry timeout is 10s and decoupled from the 3s eval-fetch timeout", () => {
  expect(apiHelpers.DEFAULT_TIMEOUT).toBe(3000);
  expect(apiHelpers.TELEMETRY_TIMEOUT).toBe(10000);

  const uploader = new TelemetryUploader({ sdkKey: "k", clientVersion: "test" });
  expect(uploader.timeout).toBe(10000);

  // An explicit timeout still wins.
  const custom = new TelemetryUploader({ sdkKey: "k", clientVersion: "test", timeout: 500 });
  expect(custom.timeout).toBe(500);
});
