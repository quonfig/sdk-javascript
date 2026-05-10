const { Quonfig } = require("../dist/quonfig");

// Round-trip test: hydrate Quonfig with an EvaluationPayload containing
// reason/ruleIndex/weightedValueIndex, then call getDetails(key) and assert
// the EvaluationDetails shape (value, reason, variant, flagMetadata).
//
// Mirrors sdk-node's getBoolDetails / getStringDetails contract per the
// cross-SDK spec (project/plans/openfeature-resolution-details.md).

describe("Quonfig.getDetails", () => {
  /** @type {InstanceType<typeof Quonfig>} */
  let q;

  beforeEach(() => {
    q = new Quonfig();
    // Skip init() — we drive setConfig() directly to avoid network/telemetry.
    // setConfig sets `loaded = true`, which is enough for get*() / getDetails().
  });

  test("STATIC config returns variant 'static' and flagMetadata with configId/configType, no ruleIndex/weightedValueIndex", () => {
    q.setConfig({
      evaluations: {
        "feature.flag": {
          value: { type: "bool", value: true },
          configId: "cfg-static",
          configType: "feature_flag",
          valueType: "bool",
          reason: "STATIC",
        },
      },
    });

    const details = q.getDetails("feature.flag");

    expect(details.value).toBe(true);
    expect(details.reason).toBe("STATIC");
    expect(details.variant).toBe("static");
    expect(details.flagMetadata).toEqual({
      configId: "cfg-static",
      configType: "FEATURE_FLAG",
    });
  });

  test("TARGETING_MATCH returns variant 'targeting:<n>' and flagMetadata.ruleIndex set, no weightedValueIndex", () => {
    q.setConfig({
      evaluations: {
        "rules.flag": {
          value: { type: "string", value: "matched" },
          configId: "cfg-rules",
          configType: "config",
          valueType: "string",
          reason: "TARGETING_MATCH",
          ruleIndex: 2,
        },
      },
    });

    const details = q.getDetails("rules.flag");

    expect(details.value).toBe("matched");
    expect(details.reason).toBe("TARGETING_MATCH");
    expect(details.variant).toBe("targeting:2");
    expect(details.flagMetadata).toEqual({
      configId: "cfg-rules",
      configType: "CONFIG",
      ruleIndex: 2,
    });
    expect(details.flagMetadata).not.toHaveProperty("weightedValueIndex");
  });

  test("SPLIT returns variant 'split:<n>' and flagMetadata with both ruleIndex and weightedValueIndex", () => {
    q.setConfig({
      evaluations: {
        "ab.test": {
          value: { type: "bool", value: false },
          configId: "cfg-ab",
          configType: "feature_flag",
          valueType: "bool",
          reason: "SPLIT",
          ruleIndex: 0,
          weightedValueIndex: 1,
        },
      },
    });

    const details = q.getDetails("ab.test");

    expect(details.value).toBe(false);
    expect(details.reason).toBe("SPLIT");
    expect(details.variant).toBe("split:1");
    expect(details.flagMetadata).toEqual({
      configId: "cfg-ab",
      configType: "FEATURE_FLAG",
      ruleIndex: 0,
      weightedValueIndex: 1,
    });
  });

  test("missing key returns ERROR with FLAG_NOT_FOUND and variant 'default'", () => {
    q.setConfig({ evaluations: {} });

    const details = q.getDetails("does.not.exist");

    expect(details.value).toBeUndefined();
    expect(details.reason).toBe("ERROR");
    expect(details.errorCode).toBe("FLAG_NOT_FOUND");
    expect(details.variant).toBe("default");
    expect(details.flagMetadata).toEqual({});
  });

  test("client not loaded returns ERROR with GENERAL and variant 'default'", () => {
    // q is a fresh instance, never had setConfig called → loaded === false.
    const details = q.getDetails("anything");

    expect(details.value).toBeUndefined();
    expect(details.reason).toBe("ERROR");
    expect(details.errorCode).toBe("GENERAL");
    expect(details.variant).toBe("default");
  });

  test("missing reason on payload defaults to STATIC for backward-compat with older servers", () => {
    // api-delivery may not yet emit `reason` on the wire. When it's omitted,
    // the SDK should treat the result as STATIC so older deployments don't
    // regress to "default" variants.
    q.setConfig({
      evaluations: {
        "legacy.flag": {
          value: { type: "string", value: "v1" },
          configId: "cfg-legacy",
          configType: "config",
          valueType: "string",
          // reason intentionally omitted
        },
      },
    });

    const details = q.getDetails("legacy.flag");

    expect(details.value).toBe("v1");
    expect(details.reason).toBe("STATIC");
    expect(details.variant).toBe("static");
  });
});
