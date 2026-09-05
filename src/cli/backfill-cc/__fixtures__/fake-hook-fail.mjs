// Fake hook for hook-runner.test.ts: always exits non-zero with a stderr message.
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  process.stderr.write("simulated capture-failed\n");
  process.exit(1);
});
