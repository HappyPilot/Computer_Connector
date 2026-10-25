# Desktop Commander Zod 3 compatibility with patched Zod 4

## Scope
Computer Connector core uses @wonderwhy-er/desktop-commander 0.3.1.
The upstream package requires Zod 3 and publishes MCP JSON Schema through `zod-to-json-schema`, which expects Zod 3 schema objects.

## The upstream security warning
`npm audit` reports GHSA-mrhx-c7xc-m3w5 for Zod versions below 4.6.6. The last compatible upstream Desktop Commander release is 0.3.1 and has no unmodified dependency path with zero high-severity warnings.

Simply overriding its Zod dependency to 4.6.7 makes npm audit green but breaks the real MCP `tools/list` output with invalid/missing JSON Schema `type: "object"` values. General core unit tests do not detect this.

## Compatibility adaptation
- Pin the nested Desktop Commander Zod dependency to 4.6.7 through npm overrides.
- In a checked and pinned vendor version, modify only the import of `dist/tools/schemas.js` to `zod/v3`, the supported backwards-compatible schema API within the patched Zod 4 package.
- Apply and validate that one-line adaptation after every `npm ci`, following the existing image guard; fail closed if the vendor version or source signature changes.
- The direct stdio MCP smoke test executes the actual vendor server, validates `tools/list` JSON schema and calls both `get_config` and `list_directory`.

## Validation and limitations
Use `npm ci && npm test && npm audit --omit=dev --audit-level=high` in an isolated checkout before deploying to any live worker. Check that rerunning `node scripts/apply-desktop-commander-zod-compat.mjs` is idempotent.

Do not confuse this dependency fix with full command-execution sandboxing; the local controller remains bound to loopback and uses host approval/authorization controls. A major vendor update must be separately reviewed and may remove the need for this adapter.

## Residual DoS hardening
The upstream Zod 4.6.6 security release addresses large arrays with *explicit* size limits, not unbounded arrays, and the `zod/v3` compatibility API alone does not establish that all legacy validators are bounded. The dependency-audit result is a **version-scanner finding**, not proof of input-safety.

Our pinned postinstall adapter now additionally installs a pre-validation complexity guard at the actual Desktop Commander MCP `CallToolRequestSchema` handler: rejects any array with over 2048 elements, object with over 1024 keys, string with over one million UTF-16 code units, nesting beyond 24 levels, or aggregate visited nodes above 8192. It rejects with an MCP tool error **before** tools parse nested arguments via Zod and before telemetry tracks the call.

Regression invokes the real server with an oversized array under a simple `get_config` call and verifies fail-closed behavior. The guard does not bound JSON parsing costs **before** the MCP handler, all script output or host command execution; host permissions, byte limits, sandboxing and authentication remain separate defenses.

Upstream evidence: https://github.com/colinhacks/zod/pull/6652 and https://github.com/advisories/GHSA-mrhx-c7xc-m3w5. Independent cross-tenant and large-but-valid traffic tests still matter for public release.