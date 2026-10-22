# Native publisher verification

The Rust publisher is the live protocol runtime. The retired TypeScript implementation and its comparison tests have been removed. Historical verification is available in Git history and the append-only agent log.

- Native suite: 99 tests passed at rollout.
- Release tooling: 5 tests passed.
- Real devnet bootstrap: 8 successful finalized pool transactions; sequence 1 and initial fee activation verified.
- Pool 2 archive: exact confirmed record exported and downloaded with matching identity/hash; 69-file recovery manifest restored into an isolated directory.
- Runtime and minute backup timer run on the European dev VM; Basic remains paused and Epoch drafts unsealed pending activation readiness.

See [deployment evidence](../../packages/cox/deploy/adaptive-pool-2-devnet.json). Empty-pool bootstrap does not establish live user deposit/redemption or Epoch settlement. Dynamic inclusion, incremental backups and retention remain separate work.
