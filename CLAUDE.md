# Page Builder CMS

## What this project is

A self-hosted, open-source CMS with a built-in visual page builder and a first-class plugin system. It is designed to compete directly with WordPress: easier to use, dramatically faster, and shipping clean HTML/CSS rather than bloated runtime markup.

The product has two distribution modes:

1. **Open source / self-hosted** — anyone can clone the repo, run it on their own server, and own their data.
2. **Managed (hosted)** — we operate a managed version on our own infrastructure as a paid product for users who don't want to self-host.

The whole stack runs from a single Bun server backed by Postgres. One process serves the public website, the admin editor, the CMS API, published pages, and uploaded media. The output of the page builder is intentionally plain, semantic HTML with hand-clean CSS — no framework runtimes injected into published pages, no client-side hydration of layout, no garbage.

### Stack at a glance

- **Runtime:** Bun (server + tooling). We use Bun, not Node.
- **Language:** TypeScript everywhere.
- **Frontend:** React 19 + Vite, Zustand + Immer for state, CodeMirror for code-editing UI, `@dnd-kit/core` for drag-and-drop.
- **Server:** `Bun.serve` with a custom router (`server/router.ts`) and CMS modules in `server/cms/*`.
- **Database:** Postgres (`pg`), with our own migrations in `server/cms/migrations.ts`.
- **Validation:** Zod at every untyped boundary (HTTP responses, request bodies, `JSON.parse` of persisted data, plugin manifests, settings). Helpers in `src/core/utils/jsonValidate.ts`. Response schemas in `src/core/persistence/responseSchemas.ts`. **Schemas are the source of truth — types are `z.infer<typeof Schema>`.**
- **Sanitization:** DOMPurify at the publisher boundary for rich-text and HTML strings (`src/core/sanitize.ts`).
- **Plugins:** Zip packages with a `plugin.json` manifest, lifecycle hooks (`install`, `activate`, `deactivate`, `uninstall`). SDK at `src/core/plugin-sdk/`, runtime at `src/core/plugins/`.
- **Routing:** `react-router-dom` is admin-only — banned in `src/editor/` and gated by `no-router-in-editor.test.ts`.
- **Icons:** `pixel-art-icons` npm package — developed as a sibling project (`../pixel-art-icons`) and consumed via a `link:` dependency until published. Imports use `pixel-art-icons/icons/<name>` (one TSX component per icon, tree-shakeable). No `lucide-react`, no inline SVG strings — gated by `no-third-party-icons.test.ts` and `direct-icon-imports.test.ts`.
- **Agent:** `@anthropic-ai/claude-agent-sdk`. The plain `@anthropic-ai/sdk` is banned and gated by `no-anthropic-sdk.test.ts`.
- **Publishing:** Page tree → renderer (`src/core/publisher`) → static HTML/CSS.
- **Tests:** `bun test`. Lint with `eslint`. Architectural rules enforced by `src/__tests__/architecture/*` — those tests run as part of `bun test` and any structural rule change must update the matching gate.

### Repo layout (high-level)

```
server/        Bun server, router, CMS handlers, DB, plugin runtime
src/admin/     Admin app (React) — editor shell, plugin pages, site/content admin
src/editor/    Visual page builder UI
src/core/      Engine, page tree, publisher, plugin SDK + runtime, persistence, validation
src/modules/   First-party block modules (button, container, text, image, etc.)
src/ui/        Shared UI primitives (Button, Input, Tree, icons, cn helper)
src/styles/    Global tokens (globals.css)
docs/          Architecture, plugin authoring, deployment docs
examples/      Plugin templates, type declarations
```

---

## Development status — READ THIS FIRST

**This project is in PRE-RELEASE. There are no external users. There is no production traffic. There is no installed base. Nothing is shipped.**

That has direct consequences for how Claude must approach changes in this repo.

### No backward compatibility. Ever.

There is nothing to be backward compatible with. There are no users whose data, plugins, integrations, or workflows can break, because there are none yet.

This means:

- **Do not preserve old function signatures, schemas, types, or APIs out of compatibility concern.** If a cleaner shape exists, change it everywhere and delete the old one.
- **Do not add deprecation shims.** Don't keep a `legacyFoo()` that forwards to `foo()`. Just rename it and update callers.
- **Do not add migration paths from old behavior to new behavior** unless it is genuinely required for *currently developed code in this repo* to keep functioning. We are not migrating real installs.
- **Do not gate new behavior behind feature flags or version checks "to be safe."** If the new behavior is correct, that is the only behavior.
- **Do not leave both an old and new implementation side-by-side** "for now." Pick the right one and delete the other.

### No band-aids. No "we'll clean it up later."

If a piece of code is in the wrong place, has the wrong shape, has confusing naming, or carries leftover assumptions from an earlier design — **fix it at the source, even if it means refactoring multiple files**.

You are explicitly authorized — and expected — to:

- Rename modules, files, types, and functions across the whole codebase to match the cleaner architecture.
- Move responsibilities between layers (e.g. push logic out of a handler into a repository, or out of a component into the engine) when that is correct.
- Delete dead code, unused exports, half-finished abstractions, and "just in case" parameters.
- Restructure folders if the current layout no longer reflects the architecture.
- Break and fix many call sites in a single change set when that is what the cleaner design requires.

What you must not do:

- Wrap new logic around old logic to "avoid touching it."
- Add a second way of doing something because the first way is awkward — fix the first way.
- Leave TODO/FIXME notes about cleanup instead of doing the cleanup.
- Hide the wrong abstraction behind a thin adapter so callers "don't notice."
- Justify a workaround with "to keep this PR small" or "to avoid breaking other things." Other things can break in this PR. We will fix them in this PR.

### Database, schema, and stored data

There is no production data to protect. Treat the schema like code:

- If a column, table, or migration is wrong, change the migration and the schema. Do not write a "compatibility migration" on top of a bad migration.
- If stored shapes (page trees, plugin manifests, settings) need to change, change them and update everything that reads/writes them.
- Local dev databases are disposable. It is acceptable for a change to require dropping the local DB and re-running migrations from scratch.

### Plugin SDK and public-looking surfaces

The plugin SDK in `src/core/plugin-sdk/`, the runtime in `src/core/plugins/`, and the manifest format in `plugin.json` *look* like a public contract, but they are also pre-release. Nothing external depends on them yet.

- If the SDK shape is wrong, change it. Update the example plugin in `examples/plugins/template` and the docs in `docs/plugins/*` in the same change.
- The `apiVersion` field is not yet a stability promise. Don't invent legacy adapters for older `apiVersion` values.

### Default disposition on every change

When you have a choice between:

- (A) the cleaner architecture, requiring edits across several files, and
- (B) a smaller diff that leaves the architecture slightly worse,

**always choose (A).** That is not a tradeoff in this repo. The whole point of being pre-release is that this is the cheapest moment in the project's life to do (A). Spending that budget is the job.

If you are unsure whether a refactor is in scope, default to *yes, do it*, and explain in the summary what you cleaned up and why. Do not ask permission to delete dead code, rename a poorly-named symbol, or fix a bad abstraction — just do it.

---

## Design tokens and UI primitives

### Where the tokens live

All design tokens are CSS custom properties declared in `src/styles/globals.css`. They are grouped by surface:

- `--editor-*`         — editor chrome surfaces, borders, text, semantic state
- `--panel-*`          — floating overlay panels (background, border, blur, shadows)
- `--input-*`          — form controls (background, border, focus glow, radius)
- `--canvas-*`         — selection / hover rings on the live canvas
- `--editor-syntax-*`  — code editor syntax colors
- `--font-sans`        — primary font

### Token rules

- **No hardcoded hex / rgb / hsl in CSS modules.** Every color comes from a `var(--*)` token. If a needed token doesn't exist, **add it to `globals.css`** — don't inline.
- **Achromatic editor chrome.** The editor and admin shells stay achromatic (white-on-black neutrals). The only chromatic accents are the semantic state tokens (`--editor-danger`, `--editor-warning`, `--editor-success-*`) and the canvas rings (`--canvas-selection-ring`, `--canvas-hover-ring`). Tinted Tailwind classes (`zinc-*`, `slate-*`, `blue-*`, `indigo-*`, `violet-*`) are gated by `achromatic-color-policy.test.ts`.
- **Border radius:** `--editor-radius` (6px), `--editor-radius-sm` (3px), `--input-radius` (12px), `--panel-radius` (12px). Don't introduce ad-hoc radius values.

### UI primitive rules

The shared component library lives in `src/ui/components/`. Every interactive control in `src/admin/` and `src/editor/` MUST use these primitives:

- **`Button`** (`@ui/components/Button`) — every action button. Bare `<button>` is gated by `button-primitive-usage.test.ts`; the only exceptions are listed in that file's `ALLOWLIST` with §8 justifications. New exceptions need an §8 entry.
- **`Input`, `Switch`, `Select`, `SearchBar`, `ColorInput`, `FileUpload`, `Separator`, `ContextMenu`, `FilterBar`** — for the corresponding control type.
- **`Tree*`** (`src/editor/ui/Tree/`) — for tree rows in DOM/site panels.
- **Icons:** `pixel-art-icons/icons/<name>`. Each icon is its own TSX file in the `pixel-art-icons` package; deep-import for tree-shaking, never barrel-import. No `lucide-react`, no inline SVG strings — gated by `no-third-party-icons.test.ts`.
- **Class composition:** `cn` from `@ui/cn`. **Do not import `clsx` directly outside `src/ui/lib/utils.ts`.**

### CSS rules

- **CSS Modules only** in `src/admin/` and `src/editor/`. No Tailwind utility classes — gated by `noTailwindUtilities.test.ts`.
- **No inline `style={{ ... }}`** *except* for dynamic CSS custom properties (e.g. `style={{ '--module-min-height': '${px}px' } as CSSProperties}`). The static CSS module reads them back via `var(--*)`.
- **No `!important`** in component CSS modules. The only legitimate exceptions are `globals.css` (`prefers-reduced-motion`) and `Button.module.css` (specificity reset for variant overrides).
- **File naming:** `Component.module.css` next to `Component.tsx`. Class names use `camelCase`.

---

## Error handling

### Boundaries — validate, then trust

Every untyped boundary uses Zod. Inside the boundary, code trusts the parsed value.

- **HTTP responses (client):** `parseJsonResponse(res, Schema)` from `src/core/utils/jsonValidate.ts`. For the persistence layer use `readEnvelope(res, Schema, fallbackMessage)` from `src/core/persistence/httpJson.ts`, which combines `responseErrorMessage` + Zod validation in one call.
- **`JSON.parse` of persisted data (localStorage, JSONB columns, file contents):** `safeParseJson(raw, Schema)` returns a discriminated union; `parseJsonWithFallback(raw, Schema, default)` for best-effort reads where corruption shouldn't brick the UI.
- **Request bodies on the server:** validate with a Zod schema before handing to handlers. Helpers in `server/http.ts`.
- **Plugin manifests:** `parsePluginManifest` in `src/core/plugins/manifest.ts`.
- **Site documents loaded from storage:** `validateSite` in `src/core/persistence/validate.ts` (Constraint #230).

### Error classes

- Domain validation errors are typed `Error` subclasses with a `path` (or similar) field for diagnostics. Examples already in the codebase: `SiteValidationError`, `VisualComponentNameError`, `VisualComponentParamNameError`, `VisualComponentRecursionError`. **Add a typed class when callers need to distinguish causes** — UI states, retry decisions, etc.
- Generic `throw new Error(...)` is fine for "this should never happen" invariants and library-internal panics. It is not fine when the UI needs to render a specific error state.

### Server error envelope

- Server endpoints return `{ error: string }` on failure (validated by `ErrorEnvelopeSchema`).
- Clients read it via `responseErrorMessage(res, fallback)`.
- Server logs use the prefix `console.error('[<module>]', err)` — example: `'[plugin:acme.workflow]'`.

### UI error handling

- Async UI handlers always wrap in `try/catch`. Logged errors use the prefix `console.error('[<component>] <description>:', err)` — example: `'[toolbar] Manual save failed:'`.
- User-visible errors go through component state + `role="alert"` (or `role="status"` for non-blocking). Never `alert()` / `confirm()` / `prompt()`.
- Error message extraction: `err instanceof Error ? err.message : 'Unknown <thing> error'`.
- Soft fallbacks (corrupted localStorage, missing optional config): use `parseJsonWithFallback` and continue with defaults. Do not throw.
- Hard fallbacks (corrupted required document, broken HTTP envelope): let the error bubble to the nearest error boundary. Do not silently mask it.

### Forbidden patterns

- `catch (err) {}` — silently swallowing. If the error is genuinely safe to ignore, name it (`catch (_err)`) and add a one-line comment explaining why.
- `console.log` in production code. Use `console.error` / `console.warn` with a `[<module>]` prefix, or remove the log.
- Re-throwing a wrapped `Error` that loses the original stack. Use `new Error(message, { cause: err })` if you must wrap.
- `as Foo` at a JSON / HTTP / `JSON.parse` boundary. Use a Zod schema instead.

---

## Code quality bar

- **Clear logic over clever logic.** Straight-line code beats a generic abstraction with two callers.
- **Names must be honest.** A function called `renderPage` renders a page. Not "kind of, depending on flags."
- **One reason per module.** Files in `server/cms/*` and `src/core/*` are organized by responsibility — keep them that way.
- **No dead code.** Unused exports, parameters, types, files: delete them. `ts-prune`, `knip`, `depcheck`, `madge`, and `jscpd` are installed in devDependencies — use them when in doubt.
- **No `any` to escape a type problem.** Fix the type.
- **No commented-out code.** Git remembers.
- **Validate at the boundary, trust inside.** Every external input (HTTP, `JSON.parse`, plugin manifests, persisted data) goes through a Zod schema. Don't `as Foo` your way past it.
- **Schemas are source of truth.** Domain types come from `z.infer<typeof Schema>` — don't keep a parallel `interface Foo` next to `FooSchema`.
- **Architecture tests are first-class.** When you change a structural rule (folder layout, allowed imports, banned APIs, design tokens), update the matching test in `src/__tests__/architecture/`.
- **At the end of the task, your own changes must pass `bun test`, `bun run build`, and `bun run lint`.** Verification is an end-of-task gate, not a per-edit ritual. Run the checks once when you believe the work is complete, fix what your changes broke, and you're done. See the "Verification" section below for how to handle pre-existing failures from parallel sessions.

## Tooling rules

- Always use `bun` (not `npm`/`pnpm`/`yarn`) for installs, scripts, and tests.
- Lockfile is `bun.lock`. Do not introduce `package-lock.json` or `yarn.lock`.
- Server scripts run with `bun --watch server/index.ts`. Frontend dev runs with `vite`.
- Run the full stack locally with `bun run dev` (auto-manages the docker postgres container) or `docker compose up --build` (everything in containers).
- **Lint, build, and tests are end-of-task gates, not per-edit rituals.** Architectural tests in `src/__tests__/architecture/` are part of `bun test` and will fail loudly if structural rules drift — when *your* change drifts a structural rule, fix it.
- **`bun run build` runs `tsc -b && vite build`** — both type-checking and bundling. A change that runs in dev but fails `tsc` for code you wrote is not done.

## Verification

```sh
bun install
bun run build         # tsc -b && vite build
bun test
bun run lint
```

### When to run

Run verification **once, at the end of the task**, before declaring work complete. You do not need to run `bun test` / `bun run build` / `bun run lint` after every edit — that wastes time. Make your changes, then verify.

Use `bun run build` and `bun test` for any non-trivial change. Add `bun run lint` if you touched `.ts`/`.tsx` files.

### Parallel sessions and pre-existing failures

**Multiple Claude sessions may be working on this repo at the same time.** That means when you run verification, the working tree may already contain failing tests, type errors, or lint errors from work-in-progress in another session. **That is not your problem to fix.**

Rules:

- Confirm that **the code you wrote / files you touched** typecheck, lint, and pass their tests.
- A pre-existing failure in an area you did not touch is not a blocker for your task. Note it in your summary so the user knows, then move on.
- **Do not try to "fix" failures unrelated to your work** — you'll collide with whoever is editing those files. Don't add band-aids, don't comment out failing tests, don't revert someone else's half-finished change.
- **Do not skip verification entirely** because "tests are probably broken anyway." Always run the checks, then triage: yours vs. not-yours.
- If a failure is ambiguous (could be yours, could be pre-existing), `git status` / `git diff` will show what you actually changed. Anything outside that diff is not yours.

The bar is: **your work is clean.** The repo's overall green/red state is the user's coordination problem across sessions, not yours.

---

## TL;DR for Claude

1. We are pre-release. There are no users to protect.
2. Never preserve backward compatibility, never leave band-aids, never duplicate "old vs new" code paths.
3. If the architecture would be cleaner with a multi-file refactor — do the refactor, in this change.
4. Every untyped boundary goes through Zod. `as Foo` at a JSON boundary is a bug.
5. UI uses shared primitives from `src/ui/`, design tokens from `src/styles/globals.css`, CSS Modules only.
6. Output of this project must stay clean: clean HTML, clean CSS, clean TypeScript, clean modules. No exceptions.
7. Verify once at the end of the task. Pre-existing failures from parallel sessions are not yours to fix — make sure *your* code is green and move on.
