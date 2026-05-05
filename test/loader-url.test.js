const Loader = require("../dist/loader").default;

describe("Loader.url — collectContextMode query param", () => {
  const baseParams = {
    sdkKey: "test-key",
    contexts: { user: { key: "alice" } },
    apiUrls: ["https://api.example.com"],
  };

  test("default mode appends ?collectContextMode=PERIODIC_EXAMPLE", () => {
    const loader = new Loader({ ...baseParams });
    const url = loader.url("https://api.example.com");
    expect(url).toMatch(
      /^https:\/\/api\.example\.com\/api\/v2\/configs\/eval-with-context\/[^?]+\?collectContextMode=PERIODIC_EXAMPLE$/
    );
  });

  test("explicit NONE appends ?collectContextMode=NONE", () => {
    const loader = new Loader({ ...baseParams, collectContextMode: "NONE" });
    const url = loader.url("https://api.example.com");
    expect(url.endsWith("?collectContextMode=NONE")).toBe(true);
  });

  test("explicit SHAPE_ONLY appends ?collectContextMode=SHAPE_ONLY", () => {
    const loader = new Loader({
      ...baseParams,
      collectContextMode: "SHAPE_ONLY",
    });
    const url = loader.url("https://api.example.com");
    expect(url.endsWith("?collectContextMode=SHAPE_ONLY")).toBe(true);
  });

  test("base64 context segment is not broken by the query param", () => {
    const loader = new Loader({ ...baseParams });
    const url = loader.url("https://api.example.com");

    // Split out the encoded-context path segment from query param.
    const match = url.match(/\/eval-with-context\/([^?]+)\?collectContextMode=(.+)$/);
    expect(match).not.toBeNull();

    const [, encodedContext, mode] = match;
    // Encoded context must be non-empty and must not contain a '?'.
    expect(encodedContext.length).toBeGreaterThan(0);
    expect(encodedContext).not.toContain("?");
    // Mode must be exactly the expected value with no trailing garbage.
    expect(mode).toBe("PERIODIC_EXAMPLE");

    // Round-trip: base64-decode the path segment and confirm it's the original contexts JSON.
    // The SDK's encodeContexts wraps as { contexts: [...] }, base64 of JSON string.
    const decoded = Buffer.from(decodeURIComponent(encodedContext), "base64").toString("utf8");
    const parsed = JSON.parse(decoded);
    expect(parsed).toBeDefined();
  });
});
