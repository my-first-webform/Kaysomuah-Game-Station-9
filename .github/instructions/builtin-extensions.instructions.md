---
description: 'Use when modifying built-in VS Code extensions in the extensions/ directory. Covers NLS externalization in package.json, proposed API access, activation events, and inter-extension dependencies.'
applyTo: "extensions/**"
---

# Built-in Extension Guidelines

Built-in extensions ship with VS Code and follow different patterns than third-party Marketplace extensions.

## NLS Externalization in package.json

Strings in `package.json` use `%key%` placeholders mapped to `package.nls.json`:

```jsonc
// package.json
{
    "contributes": {
        "commands": [{
            "command": "git.commit",
            "title": "%command.commit%"
        }]
    }
}
```

```jsonc
// package.nls.json
{
    "command.commit": "Commit"
}
```

**Both files must be updated together.** A `%key%` without a matching entry in `package.nls.json` shows the raw key to users.

## Proposed API Access

Built-in extensions can use unstable VS Code APIs by listing them explicitly:

```jsonc
// package.json
{
    "enabledApiProposals": [
        "chatParticipantPrivate",
        "languageModelSystem"
    ]
}
```

Each proposal name maps to a `vscode.proposed.*.d.ts` file. The build system validates these declarations.

## Activation Events

Built-in extensions often use broad activation patterns since they represent core functionality:

```jsonc
{
    "activationEvents": [
        "onLanguage:typescript",
        "workspaceContains:**/tsconfig.json"
    ]
}
```

Use the narrowest activation event that ensures the extension is ready when needed.

## Inter-Extension Dependencies

Some built-in extensions depend on others (e.g., `git` depends on `git-base`):

```jsonc
{
    "extensionDependencies": ["vscode.git-base"]
}
```

Dependencies must be declared in `package.json`. Forgetting this causes activation order issues.

## Build and Test

- Built-in extensions compile via the `Ext - Build` watch task (part of `VS Code - Build`)
- Test files live in `extensions/<name>/src/test/` and run with `scripts/test-integration.sh`
- Extension source is in `extensions/<name>/src/` with TypeScript compilation
