---
name: new-action-command
description: 'Register new commands, actions, keybindings, and menu items in VS Code. Use when adding user-facing commands, toolbar buttons, context menu entries, or keyboard shortcuts. Covers Action2, MenuId, ContextKeyExpr, precondition vs when, and accessibility keybinding scoping.'
---

# New Action / Command

Actions compose 5+ interconnected systems: command ID, keybinding, menu placement, context key gating, localization, and icon. This skill ensures they wire up correctly.

## When to Use

- Adding a new command to the Command Palette
- Adding buttons to toolbars, title bars, or context menus
- Registering keyboard shortcuts
- Creating actions that should be conditionally visible or enabled

## Procedure

### Step 1: Define the Action

```typescript
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { localize2 } from '../../../../nls.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';

class MyAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.myFeature.doThing',
			title: localize2('myAction', "Do the Thing"),
			f1: true, // Show in Command Palette
			category: localize2('myCategory', "My Feature"),
			precondition: MyContextKeys.featureEnabled, // Grayed out when false
			icon: Codicon.play,
			menu: {
				id: MenuId.ViewTitle,
				when: ContextKeyExpr.equals('view', 'myView'), // Hidden when false
				group: 'navigation',
				order: 1,
			},
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyCode.KeyK,
				when: MyContextKeys.viewFocused,
				weight: KeybindingWeight.WorkbenchContrib,
			},
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const myService = accessor.get(IMyService);
		await myService.doThing();
	}
}

registerAction2(MyAction);
```

### Step 2: Understand Precondition vs When

| Property | Effect When False | Use For |
|----------|-------------------|--------|
| `precondition` | Command **grayed out** (disabled) | Feature exists but can't run right now |
| `when` (on menu) | Menu item **hidden** | Feature not relevant in this context |
| `when` (on keybinding) | Keybinding **inactive** | Prevent conflicts in wrong context |

### Step 3: Localize the Title

```typescript
// For action titles (deferred localization)
title: localize2('myAction', "Do the Thing"),

// For runtime strings
const msg = nls.localize('result', "Found {0} items", count);
```

**Rules**:
- Title-style capitalization for command labels: "Open in Terminal" not "Open in terminal"
- Don't capitalize prepositions <=4 letters unless first/last: "Search in Files"
- Use `{0}` placeholders, never string concatenation

### Step 4: Menu Placement and Ordering

Common `MenuId` values and their ordering conventions:

| MenuId | Location | Ordering |
|--------|----------|----------|
| `MenuId.CommandPalette` | Command Palette (via `f1: true`) | Alphabetical |
| `MenuId.ViewTitle` | View title bar | `navigation` group first |
| `MenuId.EditorTitle` | Editor title bar | `navigation` group first |
| `MenuId.EditorContext` | Editor right-click menu | Groups: `1_modification`, `9_cutcopypaste` |
| `MenuId.CommandCenter` | Command center bar | 1-3 = left, ~100 = center, 10000+ = right |
| `MenuId.ExplorerContext` | Explorer right-click | Groups: `2_workspace`, `7_modification` |

**Group ordering**: Items within a group are sorted by `order`. Groups are sorted alphabetically with `navigation` always first.

### Step 5: Accessibility Keybinding Scoping

If your keybinding might conflict with standard shortcuts, scope it to accessibility mode:

```typescript
keybinding: {
	primary: KeyCode.F7,
	when: ContextKeyExpr.and(
		EditorContextKeys.focus,
		CONTEXT_ACCESSIBILITY_MODE_ENABLED // Only active in screen reader mode
	),
	weight: KeybindingWeight.WorkbenchContrib,
},
```

**Validated by**: PR #293163 — F7 keybinding conflict resolved by adding accessibility mode gating.

### Step 6: Gate AI Features

All AI/chat commands must be gated:

```typescript
precondition: ChatContextKeys.enabled, // UI-level: hides when AI disabled

// And in run():
override async run(accessor: ServicesAccessor) {
	const entitlements = accessor.get(IChatEntitlementService);
	if (entitlements.sentiment.hidden) {
		return; // Runtime: skip when user opted out
	}
}
```

**Validated by**: PR #291697 — Welcome page command needed both UI and runtime gating.

### Step 7: Register

```typescript
// In the feature's contribution file
registerAction2(MyAction);
```

For actions that need custom rendering (dropdowns, pickers), register via `IActionViewItemService`:

```typescript
registerWorkbenchContribution2(MyPickerRendering.ID, MyPickerRendering, WorkbenchPhase.BlockRestore);
```

## Common Mistakes

| Mistake | Impact | Fix |
|---------|--------|-----|
| Missing `f1: true` | Command not in palette | Add `f1: true` to make discoverable |
| `precondition` vs `when` confusion | Wrong disabled/hidden behavior | precondition = gray, when = hide |
| Missing accessibility mode check | Steals keybindings from standard features | Add `CONTEXT_ACCESSIBILITY_MODE_ENABLED` |
| Wrong CommandCenter order | Button in wrong position | Left: 1-3, center: ~100, right: 10000+ |
| Hardcoded strings | Missing translations | Use `localize2()` for titles, `nls.localize()` for runtime |
| Missing AI gate | Shows when AI disabled | Add `ChatContextKeys.enabled` precondition |
