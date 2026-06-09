/**
 * base.text editor preview component.
 *
 * Component-only file so React Fast Refresh can hot-patch edits without
 * re-running module registration. Per Constraint #309, this file MUST NOT
 * export non-component values — `normalizeTag` and the tag vocabulary live in
 * the shared `./tags` module that both this file and `index.ts` import.
 *
 * Text is edited via the Properties panel only. The canvas-side inline
 * (double-click contentEditable) editing was removed because the
 * iframe-per-frame architecture makes focus/selection management
 * unreliable across the cross-frame boundary; a clean replacement will be
 * designed separately.
 */
import React from 'react'
import type { ModuleComponentProps } from '@core/module-engine'
import { htmlAttributesForReact } from '@modules/base/shared/htmlAttributes'
import { normalizeTag } from './tags'
import type { TextStoredProps } from './index'

export const TextEditor: React.FC<ModuleComponentProps<TextStoredProps>> = ({
  props,
  mcClassName,
  nodeWrapperProps,
}) => {
  const tag = normalizeTag(props.tag)
  if (tag === 'none') {
    return React.createElement(
      'span',
      {
        ...nodeWrapperProps,
        className: mcClassName,
      },
      props.text || 'Text',
    )
  }

  const Tag = tag as React.ElementType
  return React.createElement(
    Tag,
    {
      ...nodeWrapperProps,
      ...htmlAttributesForReact(props.htmlAttributes),
      className: mcClassName,
    },
    props.text || 'Text',
  )
}
