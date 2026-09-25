/**
 * Capturing logger for the telemetry transport tests: the browser SDK logs
 * through `console`, so this spies the four level methods and records every
 * line as { level, msg }. Levels map console.debug -> debug, info -> info,
 * warn -> warn, error -> error (the contract's DEBUG / INFO / WARN / ERROR).
 */
const LEVELS = ["debug", "info", "warn", "error"];

function captureConsole() {
  const lines = [];
  const spies = LEVELS.map((level) =>
    jest.spyOn(console, level).mockImplementation((...args) => {
      lines.push({ level, msg: args.map(String).join(" ") });
    })
  );
  return {
    lines,
    logCount: (level, re = /.*/) => lines.filter((l) => l.level === level && re.test(l.msg)).length,
    clear: () => {
      lines.length = 0;
    },
    restore: () => spies.forEach((s) => s.mockRestore()),
  };
}

module.exports = { captureConsole };
