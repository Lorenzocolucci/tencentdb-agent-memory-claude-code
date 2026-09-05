// Fake hook for hook-runner.test.ts: never exits on its own, to exercise the
// timeout + SIGKILL path in runHookStop.
process.stdin.on("data", () => {});
setInterval(() => {}, 1000);
