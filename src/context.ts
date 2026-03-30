import type { Contexts, ContextValue } from "./types";

/**
 * Base64 encode a string, works in both browser and Node.js environments.
 */
export const base64Encode = (str: string): string => {
  if (typeof window !== "undefined") {
    if (typeof TextEncoder !== "undefined") {
      const bytes = new TextEncoder().encode(str);
      const binString = Array.from(bytes, (byte) => String.fromCodePoint(byte)).join("");
      return btoa(binString);
    }
    return window.btoa(str);
  }
  return Buffer.from(str).toString("base64");
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
