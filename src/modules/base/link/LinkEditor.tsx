/**
 * base.link editor preview component.
 *
 * Component-only file so React Fast Refresh can hot-patch edits without
 * re-running module registration. The children-vs-text fallback and the
 * `rel` decision are shared with the publisher via `./content` and
 * `@modules/base/shared/anchorTarget`, so the canvas cannot drift from the
 * published markup.
 */
import React from 'react'
import type { ModuleComponentProps } from '@core/module-engine'
import { anchorRel } from '@modules/base/shared/anchorTarget'
import { htmlAttributesForReact } from '@modules/base/shared/htmlAttributes'
import { linkUsesChildren } from './content'
import type { LinkStoredProps } from './index'

export const LinkEditor: React.FC<ModuleComponentProps<LinkStoredProps>> = ({ props, children, mcClassName, nodeWrapperProps }) => {
  const childCount = Array.isArray(children) ? children.length : children != null ? 1 : 0
  const content = linkUsesChildren(childCount) ? children : (props.text ?? 'Link text')
  return React.createElement(
    'a',
    {
      ...nodeWrapperProps,
      ...htmlAttributesForReact(props.htmlAttributes),
      href: props.href || '#',
      target: props.target,
      rel: anchorRel(props.target) ?? undefined,
      className: mcClassName,
    },
    content,
  )
}
