# Swap SDK closeout

Scope: SDK, separate Express router, tests and documentation. Existing pool,
UI, API, migrations and deployments are outside this closeout.

- [x] Direct collateral entry and redemption for sealed-roster performance classes, preserving CRYPTO defaults.
- [x] Class-aware balances and request lifecycle with owner, amount, expiry, fee and minimum-output protections.
- [x] Typed direct/Express capability results and early rejection before route or wallet preparation.
- [x] Explicit Express opt-in, compatible network/provider and executable-router checks.
- [x] Full-output router measures actual collateral increase and preserves existing wallet collateral.
- [x] Separate DEX minimum collateral and future position minimum units; atomic rollback on failure.
- [x] Focused types, browser exports and final nonce/fee checks.
- [x] Verification: 56 client tests, TypeScript checks, browser bundles, 12 router host tests and 3 compiled runtime tests.
- [x] Source/artifact hashes recorded in `../cox-router/results/verification.json`.
- [x] README examples cover pending execution, fees, refunds, capabilities and token restrictions.
- [x] Peter approved chunked commits, publication to `working` and notification to Godwin and Joel on 20 October 2026.

Commit groups: direct-entry SDK and capabilities; experimental Express SDK and
router; supporting documentation; append-only agent log in a separate commit.

Express remains unavailable on the current devnet deployment. The Jupiter
provider is mainnet-only; a matching provider, independently verified live route
and reviewed router deployment are required before activation. Availability
checks do not guarantee route success or pool readiness. Compiled tests use a
controlled swap fixture and are not live Jupiter verification.

Deferred: live Express activation, API/UI integration, dual collateral, faster
publication and separate epoch pools. No deployment is part of this closeout.
