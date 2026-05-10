import { quonfig, Quonfig, QuonfigBootstrap } from "./quonfig";
import { Config } from "./config";
import { contextsEqual, encodeContexts, base64Encode } from "./context";
import version from "./version";
import { QUONFIG_SDK_LOGGING_CONTEXT_NAME } from "./types";

import type {
  ConfigValue,
  Contexts,
  ContextObj,
  ContextValue,
  Duration,
  EvaluationDetails,
  EvaluationErrorCode,
  EvaluationPayload,
  EvaluationCallback,
  EvaluationReason,
  InitOptions,
  ShouldLogArgs,
  CollectContextMode,
  ConfigEvaluationMetadata,
  ConfigEvaluationCounter,
  FrontEndConfigurationRaw,
  TypedFrontEndConfigurationRaw,
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

  // Constants
  QUONFIG_SDK_LOGGING_CONTEXT_NAME,

  // Version
  version,

  // Types
  ConfigValue,
  Contexts,
  ContextObj,
  ContextValue,
  Duration,
  EvaluationDetails,
  EvaluationErrorCode,
  EvaluationPayload,
  EvaluationCallback,
  EvaluationReason,
  InitOptions,
  ShouldLogArgs,
  CollectContextMode,
  ConfigEvaluationMetadata,
  ConfigEvaluationCounter,
  FrontEndConfigurationRaw,
  TypedFrontEndConfigurationRaw,
};
