import React from 'react';
import type { IconProps } from '../types';

// Authored in-house: four horizontal bars all full-width, the universal
// "justify" / "align both" glyph.
export function TextAlignJustifyIcon({ size = 24, color = 'currentColor', className, style }: IconProps): React.ReactElement {
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
      <path d="M21 7H3V5h18v2Zm0 4H3V9h18v2Zm0 4H3v-2h18v2Zm0 4H3v-2h18v2Z"/>
    </svg>
  );
}
