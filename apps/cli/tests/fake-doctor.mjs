// Test double for the ia CLI entry the session hook runs (docs/specs/host-plugin-distribution/README.md
// §8). Stands in for dist/main.js: prints $FAKE_DOCTOR (a JSON document shaped like `ia doctor --json --host claude`'s
// output) or sleeps past the hook's 5s spawnSync timeout when $FAKE_DOCTOR is the literal string "sleep". The hook's
// own timeout normally kills this process mid-sleep; if it doesn't (a missed or lengthened timeout), this exits with
// a distinct non-zero status and no stdout, so the hook reports "ia doctor exited 91" instead of failing to parse
// truncated or absent JSON.
if (process.env.FAKE_DOCTOR === 'sleep') {
  await new Promise((resolve) => setTimeout(resolve, 8000));
  process.exit(91);
}
process.stdout.write(process.env.FAKE_DOCTOR ?? '');
