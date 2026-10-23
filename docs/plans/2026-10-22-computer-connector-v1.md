# Computer Connector v1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Turn the existing WCM router and Desktop Commander worker into a self-hosted, cross-platform ChatGPT computer connector with private tunnel setup, portable worker services, and verified device affinity.

**Architecture:** Preserve the existing Router, WorkerHub protocol, worker agent, approvals, and Streamable HTTP endpoint. Use the Router itself as the private controller process (`npm run start:private`) and supervise workers independently with native OS services (LaunchAgent, systemd user service, or Windows Scheduled Task). Keep Secure MCP Tunnel as the ChatGPT transport and retain OAuth/Funnel as an optional compatibility mode.

**Tech Stack:** Node.js 22.12+, existing MCP SDK and Desktop Commander dependency, LaunchAgent plist, systemd user unit, Node `node:test` integration scripts.

## Approach review

1. **Direct Router process plus native worker services (selected):** Uses the existing Router and agent directly, keeps controller startup cross-platform, and delegates worker lifecycle to LaunchAgent/systemd/Scheduled Task without adding another supervisor protocol.
2. **PowerShell-centered startup with POSIX wrappers:** Reuses current Windows operations but keeps startup semantics platform-specific and duplicates orchestration logic.
3. **New cross-platform supervisor protocol:** Could unify service lifecycle but would add a new control protocol and broad migration without being needed for v1.

The first option is the smallest design that satisfies the locked architecture and preserves Windows compatibility.

## Tasks

### Task 1: Routing affinity and WorkerHub integration regression coverage

**Files:**
- Create: `router/session-affinity.mjs`
- Modify: `router/server.mjs`
- Create: `scripts/test-multi-device-integration.mjs`
- Modify: `scripts/test-router-routing-contract.mjs`
- Modify: `package.json`

**Steps:** Add failing tests for resource ownership, two-worker routing, missing/unknown/offline targets, duplicate registry IDs and live connections, reconnect, malformed frames, and process/search follow-up calls. Run the new focused integration script and observe the expected failures. Implement bounded router-side affinity for Desktop Commander process and search IDs while preserving explicit `deviceId`, then run the integration and contract scripts.

### Task 2: Portable private controller startup

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Create/extend: private-mode integration coverage

**Steps:** Start the existing Router directly through `npm run start:private`; keep its MCP endpoint loopback-only by default. Start same-host or remote workers independently through their native service managers. Test controller startup with a temporary registry and fake workers so no real host tool is invoked. Bind the optional remote worker listener only to an explicitly configured private LAN/Tailscale interface.

### Task 3: Native macOS and Linux worker services

**Files:**
- Create: `worker/services/com.computer-connector.worker.plist`
- Create: `worker/services/computer-connector-worker@.service`
- Modify: `worker/README.md`

**Steps:** Document service installation for a per-user LaunchAgent and systemd user unit that both execute the existing `worker/agent.mjs`. Use a user-owned 0600 environment file, explain Linux least privilege and GUI access limits, and include stop/reload commands. No Docker is required.

### Task 4: Private tunnel, extension architecture, and project naming

**Files:**
- Modify: `README.md`
- Modify: `worker/README.md`
- Create: `docs/extensions.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `router/server-info.mjs`
- Modify: tests that assert user-facing names

**Steps:** Document loopback MCP startup and the current `tunnel-client init --mcp-server-url`, `doctor --profile ... --explain`, and `run --profile ...` workflow without IDs or keys. Explain optional REA, browser/Playwright, and GUI adapters as extension points that are absent until wired. Rename public metadata to Computer Connector, retain upstream MIT attribution and compatibility entry points, and clarify optional OAuth/Funnel mode.

### Task 5: Portable test runner and dependency audit

**Files:**
- Modify: `scripts/test-supervisor-restart.mjs`
- Modify: `package.json` and `package-lock.json` only if a semver-safe dependency update is justified
- Modify: dependency/security documentation

**Steps:** Probe for a supported PowerShell executable and mark the supervisor test skipped when it is unavailable; keep all cross-platform tests in `npm test`. Run `npm audit`, inspect runtime-relevant findings, and use only non-force semver-safe fixes when they do not break tests. Document any unresolved findings with package, severity, and reason.

### Task 6: Verification

Run `npm test`, the new multi-device integration and private-mode smoke scripts, syntax/import checks for changed JS/MJS, `git diff --check`, and a loopback MCP initialize → tools/list → harmless list_devices/ping flow. Review the final diff and report exact results and remaining blockers. Do not deploy, publish, merge, push, configure external accounts, or change networking.
