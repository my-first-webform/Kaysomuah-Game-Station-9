---
description: 'Use when implementing or modifying the VS Code Extension API surface. Covers ExtHost/MainThread RPC patterns, proposed API lifecycle, protocol serialization, and enabledApiProposals.'
applyTo: "src/vs/workbench/api/**"
---

# Extension API Implementation

The Extension API spans two processes connected by RPC. Changes must be coordinated across multiple files.

## Architecture

| Layer | Process | Location | Prefix |
|-------|---------|----------|--------|
| API definition | N/A | `src/vscode-dts/vscode.d.ts` | `vscode.` |
| Extension host | Extension Host | `src/vs/workbench/api/common/extHost*.ts` | `ExtHost` |
| Main thread | Renderer | `src/vs/workbench/api/browser/mainThread*.ts` | `MainThread` |
| Protocol | Shared | `src/vs/workbench/api/common/extHost.protocol.ts` | `ExtHost*Shape` / `MainThread*Shape` |

## Adding a New API

1. **Define the type** in `src/vscode-dts/vscode.d.ts` (or `vscode.proposed.*.d.ts` for proposed)
2. **Define the protocol shapes** in `extHost.protocol.ts`:
   ```typescript
   export interface MainThreadMyFeatureShape extends IDisposable {
       $doSomething(arg: string): Promise<void>;
   }
   export interface ExtHostMyFeatureShape {
       $onDidChange(data: MyData): void;
   }
   ```
3. **Implement ExtHost side** in `extHostMyFeature.ts`
4. **Implement MainThread side** in `mainThreadMyFeature.ts`
5. **Register** in the protocol identifier maps

## Proposed APIs

Proposed APIs live in `src/vscode-dts/vscode.proposed.*.d.ts` and require extensions to declare them:

```jsonc
// Extension package.json
{
    "enabledApiProposals": ["myProposedApi"]
}
```

When making breaking changes to proposed APIs, increment the version integer. See `api-version.instructions.md`.

## Serialization Rules

All data crossing the RPC boundary must be JSON-serializable:
- No class instances — use plain objects
- No functions or closures
- Use `UriComponents` instead of `URI` instances
- Use `IRange` instead of `Range` class instances
- Transform VS Code API types to/from protocol types in the ExtHost layer

## Common Mistakes

| Mistake | Impact | Fix |
|---------|--------|-----|
| Non-serializable types in protocol | RPC crash | Use plain interfaces |
| Missing `enabledApiProposals` | API not available to extension | Add to extension's `package.json` |
| Forgetting to dispose MainThread proxy | Resource leak | Implement `$dispose()` |
| Modifying vscode.d.ts for experimental features | Breaking change for all extensions | Use `vscode.proposed.*.d.ts` instead |
