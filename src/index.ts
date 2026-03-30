import { quonfig, Quonfig, QuonfigBootstrap } from "./quonfig";
import { Config } from "./config";
import { contextsEqual, encodeContexts, base64Encode } from "./context";
import version from "./version";

import type {
  ConfigValue,
  Contexts,
  ContextValue,
  Duration,
  EvaluationPayload,
  EvaluationCallback,
  InitOptions,
  ShouldLogArgs,
  ContextUploadMode,
  ConfigEvaluationMetadata,
  ConfigEvaluationCounter,
} from "./types";

export {
  // Main class and singleton
  quonfig,
  Quonfig,
  QuonfigBootstrap,

  // Config parsing
  Config,

  // Context utilities
  contextsEqual,
  encodeContexts,
  base64Encode,

  // Version
  version,

  // Types
  ConfigValue,
  Contexts,
  ContextValue,
  Duration,
  EvaluationPayload,
  EvaluationCallback,
  InitOptions,
  ShouldLogArgs,
  ContextUploadMode,
  ConfigEvaluationMetadata,
  ConfigEvaluationCounter,
};
