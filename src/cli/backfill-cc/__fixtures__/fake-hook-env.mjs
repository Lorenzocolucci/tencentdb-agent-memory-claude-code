// Fake hook for hook-runner.test.ts: reports the capture timeout it was given
// on stderr and exits 1 so runHookStop surfaces it in `error` (stdout is not
// returned on success). NOT the real tdai-memory Stop hook; touches nothing.
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  process.stderr.write(`TDAI_CAPTURE_TIMEOUT_MS=${process.env.TDAI_CAPTURE_TIMEOUT_MS ?? "<unset>"}\n`);
  process.exit(1);
});
