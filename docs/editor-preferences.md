# Editor Preferences

Local UI preferences for the editor — auto-save behaviour, what to show in the layers panel, etc. Stored in `localStorage`, scoped to the device, never written to the site file.

This document explains how the system is built, how to add a preference, and lists candidates we've identified across the codebase that would benefit from being user-controllable.

---

## TL;DR for adding a new preference

1. Append one entry to `PREFERENCE_CATALOG` in `src/editor/preferences/catalog.ts`.
2. Read it with `useEditorPreference('your-id')` wherever you need it.

That's it. Schema, defaults, and the Settings → Preferences UI all derive from the catalog.

```ts
// catalog.ts — append:
{
  id: 'layersShowIcon',
  type: 'boolean',
  category: 'layers',
  label: 'Show module icon',
  description: 'Display the module type icon next to each layer row.',
  default: true,
}

// Use it:
import { useEditorPreference } from '@editor/preferences/editorPreferences'
const showIcon = useEditorPreference('layersShowIcon')
```

The Settings panel automatically renders the new toggle in the right category. The `id` becomes a literal-typed string union via `as const`, so `useEditorPreference('typo')` is a compile error.

---

## Architecture

Three files, one source of truth.

```
src/editor/preferences/
├── catalog.ts                — declarative source of truth
├── editorPreferences.ts      — runtime: schema, IO, hook, event bus
└── (consumed by)
    src/editor/components/Settings/sections/PreferencesSection.tsx
```

### `catalog.ts` — source of truth

A single `PREFERENCE_CATALOG` array lists every preference. Each entry declares everything we need to know about it:

```ts
export const PREFERENCE_CATALOG = [
  {
    id: 'autoSave',
    type: 'boolean',
    category: 'editor',
    label: 'Auto-save',
    description: 'Automatically save the site every 30 seconds.',
    default: true,
  },
  // …
] as const satisfies ReadonlyArray<PreferenceDef>
```

Why a catalog (vs. hand-rolling each preference):

- **Settings UI auto-renders** — `PreferencesSection` iterates the catalog grouped by category. New preferences surface automatically.
- **One place to look** — defaults, labels, descriptions, valid ids all live together.
- **Type-safe ids** — `as const` preserves the literal union type. `useEditorPreference('layersShowTag')` compiles, `useEditorPreference('layersShowtag')` does not.
- **Defaults can't drift** — the schema and `DEFAULT_EDITOR_PREFS` are derived from the catalog at module load. There is no separate "registered" list to keep in sync.

The current discriminated union has three branches:

```ts
interface BooleanPreferenceDef {
  id: string
  type: 'boolean'
  category: PreferenceCategory
  label: string
  description: string
  default: boolean
}

interface SelectPreferenceDef {
  id: string
  type: 'select'
  category: PreferenceCategory
  label: string
  description: string
  options: ReadonlyArray<{ value: string; label: string; description?: string }>
  default: string
}

interface DynamicSelectPreferenceDef {
  id: string
  type: 'select-dynamic'
  category: PreferenceCategory
  label: string
  description: string
  optionsSource: 'site.breakpoints'    // extensible enum
  default: string
}

export type PreferenceDef =
  | BooleanPreferenceDef
  | SelectPreferenceDef
  | DynamicSelectPreferenceDef
```

When we need `'number'` or `'colour'` preferences, add a branch to this union, one runtime read/set/hook in `editorPreferences.ts`, and one matching row component in `PreferencesSection.tsx`.

### `editorPreferences.ts` — runtime

Three layers:

**1. Schema and defaults — derived**

```ts
const schemaFields: Record<string, ReturnType<typeof Type.Optional>> = {}
for (const def of PREFERENCE_CATALOG) {
  if (def.type === 'boolean') schemaFields[def.id] = Type.Optional(Type.Boolean())
}
export const EditorPrefsSchema = Type.Object(schemaFields, { additionalProperties: true })
export const DEFAULT_EDITOR_PREFS = /* same loop, building the defaults object */
```

`additionalProperties: true` means an older client reading prefs written by a newer build does not crash on unknown fields — it just ignores them.

**2. Generic IO**

```ts
export function readEditorPreference(id: BooleanPreferenceId): boolean
export function setEditorPreference(id: BooleanPreferenceId, value: boolean): void
```

Both go through `parseJsonWithFallback(EditorPrefsSchema, …)` so corrupt or partial localStorage data falls back to defaults instead of throwing.

**3. Event bus + React hooks**

```ts
// Event bus — for non-React consumers (e.g. usePersistence's auto-save scheduler)
export function subscribeToEditorPrefsChanged(listener: () => void): () => void
export function notifyEditorPrefsChanged(): void

// React — preferred path for components.
// One hook per preference type so each callsite stays type-safe.
export function useEditorPreference(id: BooleanPreferenceId): boolean
export function useEditorSelectPreference(id: SelectPreferenceId): string
```

The event bus listens to two things:

- **Same-tab updates** — `setEditorPreference` dispatches a custom event that all hook instances pick up.
- **Cross-tab updates** — the browser's native `storage` event re-fires our listeners when another tab writes the same key, so two editor windows stay in sync.

The hook is intentionally one-preference-per-call. Multiple prefs in one component is just multiple `useEditorPreference()` calls — React's dependency tracking stays trivial and re-renders are scoped to the prefs the component actually reads.

### `PreferencesSection.tsx` — auto-rendered Settings UI

```tsx
const groups = preferencesByCategory()

return groups.map((group) => (
  <section key={group.id}>
    <h4>{group.label}</h4>
    {group.preferences.map((pref) => <PreferenceRow key={pref.id} pref={pref} />)}
  </section>
))
```

`PreferenceRow` switches on `pref.type` and dispatches to the right concrete row component. Today there is one branch (`'boolean'` → `<BooleanPreferenceRow>`). Future preference types add a branch here and a matching row component.

### Categories

Categories are declared in the catalog itself:

```ts
export const PREFERENCE_CATEGORIES = [
  { id: 'editor',     label: 'Editor' },
  { id: 'canvas',     label: 'Canvas',          description: '…' },
  { id: 'layers',     label: 'Layers panel',    description: '…' },
  { id: 'properties', label: 'Properties panel' },
]
```

Order here is the rendering order in the Preferences screen. Categories without any preferences are skipped automatically.

### Dynamic select options

`'select-dynamic'` preferences resolve their options at render time from runtime state — currently `site.breakpoints` is the only declared source, used by `defaultBreakpoint`. Each source maps to a small hook in `PreferencesSection.tsx`:

```ts
function useDynamicSelectOptions(source: DynamicOptionsSource) {
  const breakpoints = useEditorStore((state) => state.site?.breakpoints)
  if (source === 'site.breakpoints') {
    if (!breakpoints) return EMPTY_OPTIONS
    return breakpoints.map((bp) => ({ value: bp.id, label: bp.label }))
  }
  return EMPTY_OPTIONS
}
```

Adding a new source is one new branch here plus a new value in the `DynamicOptionsSource` union in `catalog.ts`.

When the persisted value is no longer in the dynamic option list (e.g. user previously picked a `wide` breakpoint, then opened a site without it), the dropdown still shows the stored value with a `(not in current site)` suffix so the mismatch is visible. The runtime reader (`readEditorSelectPreference`) returns the stored string regardless — consumers (e.g. `applyDefaultBreakpointPreference` in `usePersistence.ts`) decide whether to apply it or fall back.

---

## Reading preferences from non-React code

Some call sites are not React components — `usePersistence.ts`'s auto-save scheduler is one example. They use the imperative API:

```ts
import {
  readAutoSavePreference,
  readAutoSaveDelayMs,
  readEditorSelectPreference,
  subscribeToEditorPrefsChanged,
} from '@editor/preferences/editorPreferences'

// Read once at setup time
const enabled = readAutoSavePreference()
const delayMs = readAutoSaveDelayMs()

// React to changes
const unsub = subscribeToEditorPrefsChanged(() => {
  scheduleAutoSave()
})
```

Named convenience wrappers (`readAutoSavePreference`, `readHoverPreviewPreference`, `readAutoSaveDelayMs`) sit on top of the generic getters. We keep them for two reasons:

1. They self-document at the call site — `readAutoSavePreference()` reads better than `readEditorPreference('autoSave')` in the auto-save scheduler.
2. The `selectorStability` architecture test asserts `readAutoSavePreference` is the call site that gates auto-save. Renaming it would mean updating that gate.

When you need an imperative reader for a new preference, add a similarly-named wrapper in `editorPreferences.ts`. They're one-liners.

### Imperative settings via setEditorPreference / setEditorSelectPreference

Both setters dispatch the change event so all hook consumers re-render and the bus listeners (`usePersistence.ts`) re-evaluate. They're available outside React for migration scripts, plugin defaults, or one-shot programmatic toggles, but the typical setter path is the Settings UI.

---

## Storage shape

```jsonc
// localStorage["pb-editor-prefs"]
{
  "autoSave": true,
  "hoverPreview": false,
  "layersShowTag": true,
  "layersShowClasses": true
}
```

Missing fields fall back to the catalog default. Unknown fields are preserved on round-trip (forward-compat).

The storage key is exported as `EDITOR_PREFS_KEY` so tests and tooling can clear it without hardcoding the literal.

---

## Testing

A single architecture test asserts the catalog drives the UI:

- `src/__tests__/settings/settingsSections.test.tsx` — checks that the Preferences screen renders one switch per catalog entry, by name.
- `src/__tests__/settings/settingsModal.test.tsx` — checks `pref-${id}` ids and `htmlFor` linkage are produced for the auto-rendered rows.

When you add a preference, both tests need an updated assertion (one new `getByRole('switch', { name: /your label/i })`). That's the only test surface — everything else flows automatically.

---

## Currently shipping preferences

Catalog as of latest. The Settings → Preferences screen renders this list automatically.

| Category | Id | Type | Default | Wired in |
| --- | --- | --- | --- | --- |
| Editor | `autoSave` | boolean | `true` | `usePersistence.ts` |
| Editor | `autoSaveDelay` | select (5s/15s/30s/60s/5min) | `'30'` | `usePersistence.ts` (`readAutoSaveDelayMs`) |
| Editor | `hoverPreview` | boolean | `true` | `ClassPicker.tsx` (class suggestions) + `SpacingBoxControl.tsx` (spacing tokens) — covers all transient "hover this and see the canvas update" flows |
| Editor | `confirmBeforeDelete` | boolean | `false` | `ConfirmDeleteProvider` (canvas Delete + layers context menu) |
| Editor | `density` | select (compact / comfortable) | `'compact'` | `data-editor-density` on `AdminCanvasLayout` root → CSS vars on `TreeRow` etc. |
| Canvas | `defaultBreakpoint` | select-dynamic (`site.breakpoints`) | `'desktop'` | `applyDefaultBreakpointPreference` in `usePersistence.ts` |
| Canvas | `dimInactiveBreakpoints` | boolean | `true` | `CanvasRoot.tsx` `focusActiveBreakpoint` |
| Layers panel | `layersShowIcon` | boolean | `true` | `TreeNode.tsx` |
| Layers panel | `layersShowTag` | boolean | `true` | `TreeNode.tsx` |
| Layers panel | `layersShowClasses` | boolean | `true` | `TreeNode.tsx` |
| Layers panel | `layersAutoExpandSelected` | boolean | `true` | `DomPanel.tsx` selection effect |
| Layers panel | `layersSmoothScroll` | boolean | `true` | `DomPanel.tsx` scroll handler |
| Properties panel | `propertiesSmoothScroll` | boolean | `true` | `StyleSurface.tsx` + `PropertiesPanel.tsx` |

### Confirm-before-delete flow

`confirmBeforeDelete` runs through a single shared `<ConfirmDeleteProvider/>` mounted in `AdminCanvasLayout`. Components call `useConfirmDelete()` and pass a `commit` callback:

```tsx
const confirmDelete = useConfirmDelete()

confirmDelete({
  title: 'Delete layer?',
  description: `${displayName} and any of its children will be removed.`,
  commit: () => deleteNode(nodeId),
})
```

When the preference is on, the provider mounts a small `<ConfirmDeleteDialog/>` and only runs `commit` after user confirmation. When off, `commit` runs immediately — preserving the historical one-key delete flow. The hook also falls back to direct execution when used outside a provider (e.g. unit tests rendering a single panel in isolation), so test fixtures don't need to wrap in the provider.

### Hover-preview gate — shared across panels

The `hoverPreview` preference covers **every** transient hover-driven canvas preview the Properties panel exposes:

- `ClassPicker` — hovering a class suggestion temporarily applies it to the selected node.
- `SpacingBoxControl` — hovering a token in the spacing autocomplete dropdown previews the resolved value on the active class.
- Any future variable / token autocomplete in other property controls **must** opt into the same gate so users have one place to control hover behaviour.

The convention for new controls:

```tsx
const hoverPreviewEnabled = useEditorPreference('hoverPreview')

// In the hover handler:
const previewOnHover = useCallback((value: string) => {
  if (!hoverPreviewEnabled) return
  applyTransientPreview(value)
}, [hoverPreviewEnabled, …])

// Defensive: clear any active preview if the pref toggles off mid-flight
// (cross-tab edit, Settings dropdown, etc.).
useEffect(() => {
  if (!hoverPreviewEnabled) clearPreview()
}, [hoverPreviewEnabled, clearPreview])
```

Notes:

- Only **hover-triggered** previews are gated. Live as-you-type previews (e.g. `previewDraft` in `SpacingBoxControl`) are NOT gated — they reflect an explicit edit the user is making, not a passive hover.
- Clearing the preview on any code path (commit, mouse-leave, menu close, pref-off effect) should always run unconditionally so a stale preview never sticks around.

### Density attribute

`AdminCanvasLayout` reads `useEditorSelectPreference('density')` and sets `data-editor-density="compact"` (default) or `"comfortable"` on the root `<div>`. Surfaces that respond to density use scoped `:global([data-editor-density='comfortable'])` selectors in their CSS module to override their default values:

```css
/* TreeRow.module.css */
.row {
    --tree-row-h: 28px;          /* compact default */
    height: var(--tree-row-h);
}
:global([data-editor-density='comfortable']) .row {
    --tree-row-h: 36px;
    font-size: 12px;
}
```

Adding density support to a new surface is two CSS lines.

---

## Open candidates (not yet implemented)

Behaviours we identified during the codebase sweep that are still hardcoded. Pick off as needed.

#### `defaultCanvasMode` — initial canvas mode (select: 'design' / 'preview')

- Today: canvas always starts in design mode (`CanvasModeToggle.tsx`).
- Why: developers iterating on a single template often spend most time in preview mode.

#### `dragActivationDistance` — drag threshold (number)

- Today: `activationConstraint: { distance: 5 }` in `DomPanel.tsx` and `AdminCanvasLayout.tsx`.
- Shape: needs the `'number'` preference type, which doesn't exist yet.

#### `layersHighlightContainerGroup` — selected-container group highlight (boolean)

- Today: when a `base.container` is selected and expanded, its children get the `openContainerGroup` outline styling.

#### `classPickerShowGenerated` — show framework-generated classes in suggestions (boolean)

- Today: `isUserVisibleClass()` filters generated classes (e.g. `text-primary-500`) out of the ClassPicker dropdown.

#### `autoSaveOnExit` — flush on tab close (boolean)

- Today: `usePersistence.ts` always flushes on `beforeunload`.
- Listed for completeness; rarely requested.

### Future-shape items (need new preference types)

- `'number'` — for `dragActivationDistance` (free input vs. select presets).
- `'colour'` — for accent colour overrides if/when we add user theming.

When we add the first non-boolean / non-select preference, extend the union in `catalog.ts` and add a matching row component + runtime branch.

---

## Renaming or dropping a preference

Renaming a preference id requires updating its storage key handling at the same time — the schema's `additionalProperties: true` keeps the old data harmless in storage, but reads using `readEditorPreference('oldId')` return the catalog default for a missing id.

Dropping a preference is safe: `additionalProperties: true` lets stale fields linger silently in users' `localStorage` without any cleanup step.
