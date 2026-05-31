/**
 * Site-scope write tools — browser-bridged. The runner emits a
 * `toolRequest` for each call and waits for the browser to POST a result
 * to /admin/api/ai/tool-result.
 *
 * Each tool defines only `name`, `description`, `inputSchema`, and the
 * sentinel `execution: 'browser'`. There is NO server-side handler — the
 * runner routes browser-execution tools through the bridge instead.
 *
 * 15 mutation tools + render_snapshot + getNodeHtml = 17 total.
 *
 * Input shapes mirror the browser executor at
 * `src/admin/pages/site/agent/executor.ts` (which validates each call
 * against TypeBox schemas — the schemas defined here are the single source
 * of truth that the executor reads in Phase 3).
 */

import { Type } from '@core/utils/typeboxHelpers'
import type { AiTool } from '../types'

// ---------------------------------------------------------------------------
// Shared input pieces
// ---------------------------------------------------------------------------

const StylePatch = Type.Record(
  Type.String(),
  Type.Union([Type.String(), Type.Number()]),
)

const BreakpointStyles = Type.Record(
  Type.String({ minLength: 1 }),
  StylePatch,
)

const ClassDefinition = Type.Object({
  name: Type.String({ minLength: 1 }),
  styles: Type.Optional(StylePatch),
  breakpointStyles: Type.Optional(BreakpointStyles),
})

// ---------------------------------------------------------------------------
// HTML-native write tools
// ---------------------------------------------------------------------------

const InsertHtmlInput = Type.Object({
  parentId: Type.String({ minLength: 1 }),
  index: Type.Optional(Type.Integer({ minimum: 0 })),
  html: Type.String({ minLength: 1 }),
  classes: Type.Optional(Type.Array(ClassDefinition)),
})

const insertHtmlTool: AiTool = {
  name: 'insertHtml',
  scope: 'site',
  execution: 'browser',
  description:
    'Insert semantic HTML as a subtree of editable nodes under an existing parent. Write structure as HTML (<section>, <h1>, <a>, <button>, <img>, <ul>, ...); style via classes referenced from class= attributes or declared in `classes`. <style> blocks and style= attributes are stripped on import.',
  inputSchema: InsertHtmlInput,
}

const GetNodeHtmlInput = Type.Object({
  nodeId: Type.String({ minLength: 1 }),
})

const getNodeHtmlTool: AiTool = {
  name: 'getNodeHtml',
  scope: 'site',
  execution: 'browser',
  description:
    'Return the current HTML the published page would emit for a node subtree. Use before replaceNodeHtml to read existing structure.',
  inputSchema: GetNodeHtmlInput,
}

const ReplaceNodeHtmlInput = Type.Object({
  nodeId: Type.String({ minLength: 1 }),
  html: Type.String({ minLength: 1 }),
  classes: Type.Optional(Type.Array(ClassDefinition)),
})

const replaceNodeHtmlTool: AiTool = {
  name: 'replaceNodeHtml',
  scope: 'site',
  execution: 'browser',
  description:
    "Replace a node subtree's children with new HTML. The target node is preserved as the parent; its existing children are rebuilt from the HTML.",
  inputSchema: ReplaceNodeHtmlInput,
}

// ---------------------------------------------------------------------------
// Node-level write tools
// ---------------------------------------------------------------------------

const DeleteNodeInput = Type.Object({
  nodeId: Type.String({ minLength: 1 }),
})

const deleteNodeTool: AiTool = {
  name: 'deleteNode',
  scope: 'site',
  execution: 'browser',
  description:
    'Remove a node and its descendants. Not undoable from inside the loop (user can Cmd+Z after).',
  inputSchema: DeleteNodeInput,
}

const UpdateNodePropsInput = Type.Object({
  nodeId: Type.String({ minLength: 1 }),
  breakpointId: Type.Optional(Type.String({ minLength: 1 })),
  patch: Type.Record(Type.String(), Type.Unknown()),
})

const updateNodePropsTool: AiTool = {
  name: 'updateNodeProps',
  scope: 'site',
  execution: 'browser',
  description:
    'Shallow-merge a patch onto an existing node\'s props. `breakpointId` is only valid for props marked `breakpointOverridable` in the schema (rejected for content props like text/tag/src). For per-breakpoint visual variation use class breakpointStyles, not this. Richtext props are auto-sanitised.',
  inputSchema: UpdateNodePropsInput,
}

const MoveNodeInput = Type.Object({
  nodeId: Type.String({ minLength: 1 }),
  newParentId: Type.String({ minLength: 1 }),
  newIndex: Type.Integer({ minimum: 0 }),
})

const moveNodeTool: AiTool = {
  name: 'moveNode',
  scope: 'site',
  execution: 'browser',
  description:
    "Move a node to a different parent and/or position. `newIndex` is 0-based among the destination's children.",
  inputSchema: MoveNodeInput,
}

const RenameNodeInput = Type.Object({
  nodeId: Type.String({ minLength: 1 }),
  label: Type.String({ minLength: 1 }),
})

const renameNodeTool: AiTool = {
  name: 'renameNode',
  scope: 'site',
  execution: 'browser',
  description:
    "Set the node's display label in the DOM tree panel. Editor-only; doesn't affect rendered HTML.",
  inputSchema: RenameNodeInput,
}

const DuplicateNodeInput = Type.Object({
  nodeId: Type.String({ minLength: 1 }),
  count: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
})

const duplicateNodeTool: AiTool = {
  name: 'duplicateNode',
  scope: 'site',
  execution: 'browser',
  description:
    "Deep-clone a node + subtree (props, classIds, breakpoint overrides) right after the original. `count` (1-50, default 1) produces N clones in one call. Success data includes the first new node id as `nodeId` and all new ids as `nodeIds`.",
  inputSchema: DuplicateNodeInput,
}

// ---------------------------------------------------------------------------
// Class-level write tools
// ---------------------------------------------------------------------------

const CreateClassInput = Type.Object({
  name: Type.String({ minLength: 1 }),
  styles: Type.Optional(StylePatch),
  breakpointStyles: Type.Optional(BreakpointStyles),
})

const createClassTool: AiTool = {
  name: 'createClass',
  scope: 'site',
  execution: 'browser',
  description:
    'Create a reusable CSS class with camelCase style keys (fontSize, paddingTop, gridTemplateColumns). Name must be a CSS identifier (no spaces) and unique. Success data includes the new id as `classId`; other class tools accept id OR name.',
  inputSchema: CreateClassInput,
}

const UpdateClassStylesInput = Type.Object({
  classId: Type.String({ minLength: 1 }),
  breakpointId: Type.Optional(Type.String({ minLength: 1 })),
  patch: StylePatch,
})

const updateClassStylesTool: AiTool = {
  name: 'updateClassStyles',
  scope: 'site',
  execution: 'browser',
  description:
    'Shallow-merge a style patch onto an existing class. `breakpointId` writes a per-breakpoint override instead of base. `classId` accepts id or name.',
  inputSchema: UpdateClassStylesInput,
}

const AssignClassInput = Type.Object({
  nodeId: Type.String({ minLength: 1 }),
  classId: Type.String({ minLength: 1 }),
})

const assignClassTool: AiTool = {
  name: 'assignClass',
  scope: 'site',
  execution: 'browser',
  description:
    "Attach an existing CSS class to a node. `classId` accepts id or name.",
  inputSchema: AssignClassInput,
}

const RemoveClassInput = Type.Object({
  nodeId: Type.String({ minLength: 1 }),
  classId: Type.String({ minLength: 1 }),
})

const removeClassTool: AiTool = {
  name: 'removeClass',
  scope: 'site',
  execution: 'browser',
  description:
    'Detach a class from a node (the class itself is not deleted). `classId` accepts id or name.',
  inputSchema: RemoveClassInput,
}

// ---------------------------------------------------------------------------
// Page-level write tools
// ---------------------------------------------------------------------------

const AddPageInput = Type.Object({
  title: Type.String({ minLength: 1 }),
  slug: Type.Optional(Type.String()),
})

const addPageTool: AiTool = {
  name: 'addPage',
  scope: 'site',
  execution: 'browser',
  description:
    'Add an EMPTY page. `slug` defaults to a slugified title. Success data includes the new id as `pageId`. For copying an existing page use duplicatePage.',
  inputSchema: AddPageInput,
}

const DeletePageInput = Type.Object({
  pageId: Type.String({ minLength: 1 }),
})

const deletePageTool: AiTool = {
  name: 'deletePage',
  scope: 'site',
  execution: 'browser',
  description:
    'Permanently delete a page. Fails if it would leave the site with zero pages.',
  inputSchema: DeletePageInput,
}

const RenamePageInput = Type.Object({
  pageId: Type.String({ minLength: 1 }),
  title: Type.String({ minLength: 1 }),
  slug: Type.Optional(Type.String()),
})

const renamePageTool: AiTool = {
  name: 'renamePage',
  scope: 'site',
  execution: 'browser',
  description:
    "Change a page's title and/or slug. `slug=\"index\"` makes this page the homepage. Omit slug to keep it.",
  inputSchema: RenamePageInput,
}

const DuplicatePageInput = Type.Object({
  pageId: Type.String({ minLength: 1 }),
  title: Type.String({ minLength: 1 }),
  slug: Type.Optional(Type.String()),
})

const duplicatePageTool: AiTool = {
  name: 'duplicatePage',
  scope: 'site',
  execution: 'browser',
  description:
    'Deep-clone an existing page (every node, prop, class assignment, breakpoint override) under a new title/slug. Node ids are regenerated; class assignments preserved. Success data includes the new id as `pageId`.',
  inputSchema: DuplicatePageInput,
}

// ---------------------------------------------------------------------------
// render_snapshot — browser-bridged, returns a special payload
// ---------------------------------------------------------------------------

const RenderSnapshotInput = Type.Object({
  breakpointId: Type.Optional(Type.String({ minLength: 1 })),
})

const renderSnapshotTool: AiTool = {
  name: 'render_snapshot',
  scope: 'site',
  execution: 'browser',
  description:
    "Capture a screenshot of the canvas at one breakpoint plus layout data (viewport size, per-node bounding boxes, image-load status, warnings for overflow/broken-image/invisible). Use to verify visuals or debug layout issues. `breakpointId` defaults to active.",
  inputSchema: RenderSnapshotInput,
}

// ---------------------------------------------------------------------------
// All write tools — convenient barrel for the registry
// ---------------------------------------------------------------------------

export const siteWriteTools: AiTool[] = [
  insertHtmlTool,
  getNodeHtmlTool,
  replaceNodeHtmlTool,
  deleteNodeTool,
  updateNodePropsTool,
  moveNodeTool,
  renameNodeTool,
  duplicateNodeTool,
  createClassTool,
  updateClassStylesTool,
  assignClassTool,
  removeClassTool,
  addPageTool,
  deletePageTool,
  renamePageTool,
  duplicatePageTool,
  renderSnapshotTool,
]
