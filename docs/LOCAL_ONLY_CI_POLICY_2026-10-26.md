# Local-only verification policy

**Effective 2026-10-26:** Computer Connector is built and checked on the owner's Mac and RTX 5090 Linux host. GitHub is used **only for versioned source storage and PR review**, not for testing, building, deployments, hosted or self-hosted GitHub Actions. The former `.github/workflows/ci.yml` has been removed and repository Actions disabled. Do not reenable without a new explicit owner instruction.

For a **trusted clean checkout** (not an unreviewed external PR), run:

```sh
npm ci
npm test
npm audit --omit=dev --audit-level=high
cd worker
npm ci --omit=dev
npm run test:stability
npm audit --omit=dev --audit-level=high
```

Run independently on Mac and RTX 5090 for the **same commit**; record git SHA, Node version and results outside Git or in ignored local receipts. For Linux without GitHub credentials use a verified Git bundle from a trusted Mac checkout over LAN, then clone locally. Never execute untrusted code on servers with access to home files, active secrets, SSH agents or customer data.

The NAS .202 may store receipts or later coordinate internal builds, but a scheduler is **not claimed as installed**. Do not touch the Windows RTX 4050 until instructed. Do not use `npm run test:live` against actual user computers as an automatic smoke test without explicit environment/safety approval.

The commercial Cloud repository has its own local command `node scripts/verify-local.mjs` and full policy at `HappyPilot/Computer_Connector_Cloud/docs/LOCAL_ONLY_CI_POLICY_2026-10-26.md`. Real service deployments and signed product releases require separate source-specific acceptance checks; a git push is never a production deploy.
