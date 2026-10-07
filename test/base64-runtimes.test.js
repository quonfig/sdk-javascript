/**
 * qfg-goi1.2.6 item 6: base64Encode must produce UTF-8 base64 in every
 * runtime. It used the UTF-8 path only when `window` and `TextEncoder` both
 * existed; otherwise it called window.btoa on raw UTF-16 (wrong for Latin-1,
 * throws above U+00FF, e.g. React Native without TextEncoder) or Buffer when
 * there was no window (throws in Web/Service Workers and Cloudflare Workers).
 */

const { base64Encode } = require("../dist/context");

const CASES = ['{"n":"José"}', '{"n":"李雷"}', '{"n":"plain"}'];
// Captured before any test hides the global.
const NodeBuffer = Buffer;
const utf8Base64 = (s) => NodeBuffer.from(s, "utf8").toString("base64");

// A spec-faithful btoa: accepts only code points <= 0xFF (a "binary string").
const latin1Btoa = (s) => {
  for (const ch of s) {
    if (ch.codePointAt(0) > 0xff) {
      throw new DOMException(
        "The string contains characters outside of the Latin1 range",
        "InvalidCharacterError"
      );
    }
  }
  return NodeBuffer.from(s, "latin1").toString("base64");
};

describe("base64Encode across runtimes", () => {
  const saved = {};
  const hide = (name, value) => {
    saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);
    if (value === undefined) delete globalThis[name];
    else globalThis[name] = value;
  };
  afterEach(() => {
    for (const [name, desc] of Object.entries(saved)) {
      if (desc) Object.defineProperty(globalThis, name, desc);
      else delete globalThis[name];
      delete saved[name];
    }
  });

  test("browser-like runtime without TextEncoder (e.g. React Native): UTF-8 output, no throw", () => {
    hide("TextEncoder", undefined);
    hide("btoa", latin1Btoa);
    hide("window", { btoa: latin1Btoa });
    hide("Buffer", undefined);
    for (const s of CASES) {
      expect(base64Encode(s)).toBe(utf8Base64(s));
    }
  });

  test("worker-like runtime (no window, no Buffer; btoa + TextEncoder): UTF-8 output, no throw", () => {
    hide("window", undefined);
    hide("btoa", latin1Btoa);
    hide("Buffer", undefined);
    for (const s of CASES) {
      expect(base64Encode(s)).toBe(utf8Base64(s));
    }
  });

  test("Node and modern browsers are unchanged", () => {
    for (const s of CASES) {
      expect(base64Encode(s)).toBe(utf8Base64(s));
    }
  });
});
