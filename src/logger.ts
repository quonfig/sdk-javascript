import type { ConfigValue } from "./types";

const WORD_LEVEL_LOOKUP: Readonly<Record<string, number>> = {
  TRACE: 1,
  DEBUG: 2,
  INFO: 3,
  WARN: 5,
  ERROR: 6,
  FATAL: 9,
};

export type Severity = keyof typeof WORD_LEVEL_LOOKUP;

export const isValidLogLevel = (logLevel: string): boolean =>
  Object.keys(WORD_LEVEL_LOOKUP).includes(logLevel.toUpperCase());

export const shouldLog = ({
  configKey,
  desiredLevel,
  defaultLevel,
  get,
}: {
  configKey: string;
  desiredLevel: string;
  defaultLevel: string;
  get: (key: string) => ConfigValue;
}): boolean => {
  let currentKey = configKey;
  const desiredLevelNumber = WORD_LEVEL_LOOKUP[desiredLevel.toUpperCase()];

  while (currentKey.length > 0) {
    const resolvedLevel = get(currentKey);

    if (resolvedLevel !== undefined) {
      return WORD_LEVEL_LOOKUP[resolvedLevel.toString()] <= desiredLevelNumber;
    }

    if (currentKey.indexOf(".") === -1) {
      break;
    }

    currentKey = currentKey.slice(0, currentKey.lastIndexOf("."));
  }

  return WORD_LEVEL_LOOKUP[defaultLevel.toUpperCase()] <= desiredLevelNumber;
};
