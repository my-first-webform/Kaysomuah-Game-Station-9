---
description: 'Use when adding user-visible strings, localized messages, command titles, or extension NLS entries. Covers nls.localize, localize2, placeholders, package.nls.json, and title capitalization rules.'
applyTo: "src/**/*.ts"
---

# Localization Patterns

All user-visible strings must be externalized for translation.

## Runtime Strings

```typescript
import * as nls from '../../../../nls.js';

// Basic
const msg = nls.localize('myKey', "Found {0} results in {1}", count, folder);

// NEVER concatenate
// BAD: nls.localize('msg', "Hello " + name)
// GOOD: nls.localize('msg', "Hello {0}", name)
```

## Deferred Strings (Actions, Static Definitions)

Use `localize2` when the string is defined statically but rendered later:

```typescript
import { localize2 } from '../../../../nls.js';

title: localize2('myAction', "Open in Terminal"),
```

## Title Capitalization

Command labels, buttons, and menu items use title-style capitalization:

- **Capitalize**: Each word
- **Don't capitalize**: Prepositions of 4 or fewer letters (unless first/last word)

| Correct | Incorrect |
|---------|----------|
| "Search in Files" | "Search In Files" |
| "Open to the Side" | "Open To The Side" |
| "Go to Definition" | "Go To Definition" |
| "For the Record" | "for the Record" |

## Extension package.json Strings

Built-in extensions use `%key%` syntax in `package.json`, mapped to `package.nls.json`:

```jsonc
// package.json
{ "title": "%myCommand.title%" }

// package.nls.json
{ "myCommand.title": "My Command Title" }
```

Both files must be updated together. Missing entries cause untranslated UI.

## Rules

- Use "double quotes" for user-visible strings
- Use 'single quotes' for internal strings
- Never use string concatenation in localized strings — use `{0}` placeholders
- Every user-visible string must go through `nls.localize()` or `localize2()`

> **Note**: Built-in extensions (`extensions/`) use the `vscode.l10n.t()` API instead of `nls.localize()`. The patterns above apply to core source code (`src/vs/`).
