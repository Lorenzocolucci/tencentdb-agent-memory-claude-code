// Fake hook for hook-runner.test.ts: reads stdin JSON, echoes it, exits 0.
// This is NOT the real tdai-memory Stop hook and touches nothing on disk.
let raw = "";
process.stdin.on("data", (chunk) => {
  raw += chunk;
});
process.stdin.on("end", () => {
  process.stdout.write(`received: ${raw}\n`);
  process.exit(0);
});
