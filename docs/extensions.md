# Computer Connector extensions

Computer Connector v1 keeps the core transport and execution layer small. Optional higher-level capabilities attach as adapters and must not weaken explicit `deviceId` routing, approval policy, response-size guards, or audit boundaries.

## REA

REA (Reverse Engineer Anything) is an optional reverse-engineering adapter. Run REA locally on the target host and expose it to the same ChatGPT conversation as a separate MCP namespace, or add a thin router adapter later. Do not proxy REA by shelling arbitrary commands through Computer Connector when a native MCP call is available.

Recommended boundary:
- `computer.*`: files, processes, system operations and device routing.
- `rea.*`: binary/app reverse engineering, Ghidra/Frida workflows.

The adapter should preserve the target Computer Connector `deviceId` in evidence/audit metadata so reverse-engineering results can be traced to the correct host.

## Browser / Playwright

Use structured browser automation through Playwright MCP when the task is web/UI automation and DOM/accessibility data is available. Prefer it over pixel mouse/keyboard automation because selectors and accessibility snapshots are more stable and auditable.

A future adapter should:
- bind one browser session to one Computer Connector device;
- never silently move a session between devices;
- keep cookies/tokens local to the browser worker;
- return bounded screenshots/artifacts rather than unbounded binary payloads.

## GUI / computer-use

Native GUI control can be added through a cross-platform computer-use MCP provider. Treat GUI actions as higher risk than read-only filesystem/process inspection.

A future GUI adapter should:
- require explicit `deviceId`;
- expose screenshot, pointer, keyboard, clipboard, window/app and accessibility operations;
- gate destructive or privacy-sensitive actions with approval;
- avoid logging raw screenshots or clipboard contents by default;
- use bounded image previews.

## Extension contract

Every adapter must meet these invariants before it is enabled:
1. explicit device ownership;
2. authenticated/private transport;
3. fail-closed offline/unknown-device behavior;
4. per-session resource affinity where an adapter returns session IDs;
5. bounded request/response size;
6. no secret values in logs;
7. focused unit/integration tests;
8. no dependence on the hosted Remote Desktop Commander relay.

Core Computer Connector remains functional when no optional adapter is installed.
