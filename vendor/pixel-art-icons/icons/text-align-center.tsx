import React from 'react';
import type { IconProps } from '../types';

// Authored in-house: four horizontal bars with rows 2 and 4 shorter and
// centered, the universal "align center" glyph.
export function TextAlignCenterIcon({ size = 24, color = 'currentColor', className, style }: IconProps): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={color}
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={style}
    >
      <path d="M21 7H3V5h18v2ZM18 11H6V9h12v2Zm3 4H3v-2h18v2Zm-4 4H7v-2h10v2Z"/>
    </svg>
  );
}
