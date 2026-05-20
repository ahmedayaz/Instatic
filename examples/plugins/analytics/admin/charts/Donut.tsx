/**
 * Analytics plugin — SVG donut chart.
 *
 * Renders proportional arcs from a list of {label, value} entries.
 * Falls back to tint tokens from the host's design system when no explicit
 * color is supplied per segment.
 */

export interface DonutSegment {
  label: string
  value: number
  color?: string
}

export interface DonutProps {
  data: DonutSegment[]
  size?: number
}

const TINTS = [
  'var(--rail-tint-mint)',
  'var(--rail-tint-lilac)',
  'var(--rail-tint-sky)',
  'var(--rail-tint-peach)',
]

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) }
}

function describeArc(cx: number, cy: number, r: number, startDeg: number, endDeg: number) {
  const start = polarToCartesian(cx, cy, r, endDeg)
  const end   = polarToCartesian(cx, cy, r, startDeg)
  const large = endDeg - startDeg > 180 ? 1 : 0
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${r} ${r} 0 ${large} 0 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`
}

export function Donut({ data, size = 160 }: DonutProps) {
  const total = data.reduce((s, d) => s + d.value, 0)
  const cx = size / 2
  const cy = size / 2
  const outerR = size / 2 - 8
  const innerR = outerR * 0.6

  if (total === 0 || data.length === 0) {
    return (
      <div style={{ width: size, height: size, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ color: 'var(--editor-text-muted)', fontSize: 12 }}>No data</span>
      </div>
    )
  }

  // Compute per-segment sweep angles, then build cumulative start angles via
  // prefix-sum reduce. No variable is mutated after assignment — React Compiler safe.
  const sweeps = data.map(s => (s.value / total) * 360)
  const starts = sweeps.reduce<number[]>((acc, _, i) => {
    acc.push(i === 0 ? 0 : acc[i - 1] + sweeps[i - 1])
    return acc
  }, [])

  const arcs = data.map((seg, i) => {
    const start = starts[i]
    const sweep = sweeps[i]
    const end   = start + sweep - (sweep > 1 ? 0.3 : 0) // tiny gap between arcs
    const color = seg.color ?? TINTS[i % TINTS.length]
    const outerPath = describeArc(cx, cy, outerR, start, end)
    const innerPath = describeArc(cx, cy, innerR, end, start)
    const joinPt = polarToCartesian(cx, cy, innerR, end)
    return {
      label: seg.label,
      value: seg.value,
      color,
      path: `${outerPath} L ${joinPt.x.toFixed(2)} ${joinPt.y.toFixed(2)} ${innerPath} Z`,
    }
  })

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
      aria-hidden="true"
      style={{ display: 'block', flexShrink: 0 }}
    >
      {arcs.map((arc, i) => (
        <path key={i} d={arc.path} fill={arc.color} />
      ))}
      {/* Total in center */}
      <text
        x={cx}
        y={cy - 4}
        textAnchor="middle"
        fill="var(--editor-text)"
        fontSize={Math.round(size * 0.14)}
        fontWeight="600"
      >
        {total.toLocaleString()}
      </text>
      <text
        x={cx}
        y={cy + Math.round(size * 0.12)}
        textAnchor="middle"
        fill="var(--editor-text-muted)"
        fontSize={Math.round(size * 0.09)}
      >
        total
      </text>
    </svg>
  )
}
