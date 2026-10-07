import type { Contexts, ContextValue } from "./types";

/**
 * The UTF-8 bytes of `str` as a binary string (one char per byte), the input
 * btoa expects. TextEncoder where it exists; otherwise the
 * encodeURIComponent/unescape idiom, which every JS engine has (React Native
 * without TextEncoder, older engines).
 */
const utf8BinaryString = (str: string): string => {
  if (typeof TextEncoder !== "undefined") {
    const bytes = new TextEncoder().encode(str);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i]);
    }
    return binary;
  }
  return unescape(encodeURIComponent(str));
};

/**
 * Base64 encode a string as UTF-8, in any runtime. Feature-detects btoa
 * (browsers, workers, React Native, Node >= 16) instead of checking for
 * `window`, and always encodes to UTF-8 first, so non-Latin-1 text never
 * throws or comes out as Latin-1. Falls back to Buffer.
 */
export const base64Encode = (str: string): string => {
  if (typeof btoa === "function") {
    return btoa(utf8BinaryString(str));
  }
  if (typeof Buffer !== "undefined") {
    return Buffer.from(str, "utf8").toString("base64");
  }
  throw new Error("Quonfig: no base64 encoder available (needs btoa or Buffer)");
};

/**
 * Deep equality check for Contexts objects.
 */
export const contextsEqual = (a: Contexts, b: Contexts): boolean => {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);

  if (aKeys.length !== bKeys.length) return false;

  return aKeys.every((key) => {
    const aValues = a[key];
    const bValues = b[key];
    if (!bValues) return false;

    const aValuesKeys = Object.keys(aValues);
    const bValuesKeys = Object.keys(bValues);

    if (aValuesKeys.length !== bValuesKeys.length) return false;

    return aValuesKeys.every((ckey) => aValues[ckey] === bValues[ckey]);
  });
};

/**
 * Validate a Contexts object, logging warnings for invalid structures.
 */
export const validateContexts = (contexts: Contexts): void => {
  if (!Object.values(contexts).every((item: any) => typeof item === "object" && item !== null)) {
    console.error("Context must be an object where the value of each key is also an object");
  }

  if (
    Object.values(contexts).some((item: any) =>
      Object.values(item).some((value: any) => typeof value === "object" && value !== null)
    )
  ) {
    console.error("Nested objects are not supported in context values at this time");
  }
};

/**
 * Determine the type string for a context value (for the encoded format).
 */
const getType = (value: ContextValue): string => {
  if (typeof value === "string") return "string";
  if (typeof value === "number") {
    return Number.isInteger(value) ? "int" : "double";
  }
  return "bool";
};

/**
 * Encode a Contexts object for use in the eval-with-context URL path.
 *
 * For quonfig, we encode the context as:
 * 1. JSON.stringify the contexts object directly
 * 2. Base64 encode
 * 3. URL encode
 */
export const encodeContexts = (contexts: Contexts): string => {
  return encodeURIComponent(base64Encode(JSON.stringify(contexts)));
};

/**
 * Encode contexts in the prefab-compatible wire format (used by eval-with-context endpoint).
 * This produces the typed format: { contexts: [{ type: "user", values: { email: { string: "foo" } } }] }
 */
export const encodeContextsTyped = (contexts: Contexts): string => {
  const formatted = Object.keys(contexts).map((key) => {
    const values: Record<string, Record<string, ContextValue>> = {};

    Object.keys(contexts[key]).forEach((ckey) => {
      values[ckey] = {
        [getType(contexts[key][ckey])]: contexts[key][ckey],
      };
    });

    return {
      type: key,
      values,
    };
  });

  return encodeURIComponent(base64Encode(JSON.stringify({ contexts: formatted })));
};
