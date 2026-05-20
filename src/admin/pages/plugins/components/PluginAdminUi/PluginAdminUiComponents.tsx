/**
 * Curated UI surface exposed to plugin admin apps.
 *
 * Each export is a thin wrapper around the host's design-system
 * primitives (`Button`, `Input`, `Switch`, `Select`, …). Plugins receive
 * this surface via the `ui` argument of their `definePluginAdminApp`
 * render function — they don't import host components directly.
 *
 * Two reasons for the wrapper layer:
 *   1. The SDK contract stays stable as the host components evolve. A
 *      plugin written today against `ui.Button` keeps working when we
 *      refactor `Button.tsx` internally.
 *   2. We expose only the props that make sense for plugin admin UI; the
 *      host's complex internal options (`pressed`, `tone`, `numeric`, etc.)
 *      stay private.
 *
 * Layout primitives (`Stack`, `Card`) are first-party here because the
 * host's app uses CSS modules + custom flex layouts everywhere; we ship
 * a tiny consistent layout layer in this file so plugin authors don't
 * reach for inline styles.
 */
import {
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from 'react'
import { Button } from '@ui/components/Button'
import { Checkbox } from '@ui/components/Checkbox'
import { Input } from '@ui/components/Input'
import { SearchBar } from '@ui/components/SearchBar'
import { Select } from '@ui/components/Select'
import { Separator } from '@ui/components/Separator'
import { Switch } from '@ui/components/Switch'
import type {
  PluginUiAlertProps,
  PluginUiButtonProps,
  PluginUiCardProps,
  PluginUiCheckboxProps,
  PluginUiCodeProps,
  PluginUiEmptyStateProps,
  PluginUiHeadingProps,
  PluginUiInputProps,
  PluginUiSearchBarProps,
  PluginUiSelectProps,
  PluginUiSeparatorProps,
  PluginUiStackProps,
  PluginUiSwitchProps,
  PluginUiTextProps,
  PluginUiTextareaProps,
} from '@core/plugin-sdk'
import styles from './PluginAdminUi.module.css'

// ---------------------------------------------------------------------------
// Action primitives
// ---------------------------------------------------------------------------

export function PluginButton(props: PluginUiButtonProps) {
  return (
    <Button
      variant={props.variant}
      size={props.size ?? 'sm'}
      disabled={props.disabled}
      fullWidth={props.fullWidth}
      type={props.type ?? 'button'}
      onClick={props.onClick}
      aria-label={props.ariaLabel}
    >
      {props.children}
    </Button>
  )
}

// ---------------------------------------------------------------------------
// Form fields
// ---------------------------------------------------------------------------

function FormFieldShell({
  label,
  description,
  htmlFor,
  children,
}: {
  label?: string
  description?: string
  htmlFor?: string
  children: ReactNode
}) {
  if (!label && !description) return <>{children}</>
  return (
    <div className={styles.field}>
      {label && (
        <label className={styles.label} htmlFor={htmlFor}>
          {label}
        </label>
      )}
      {children}
      {description && <p className={styles.description}>{description}</p>}
    </div>
  )
}

export function PluginInput(props: PluginUiInputProps) {
  return (
    <FormFieldShell label={props.label} description={props.description}>
      <Input
        type={props.type ?? 'text'}
        value={props.value}
        defaultValue={props.defaultValue}
        placeholder={props.placeholder}
        invalid={props.invalid}
        disabled={props.disabled}
        required={props.required}
        prefix={props.prefix}
        unit={props.unit}
        onChange={(event: FormEvent<HTMLInputElement>) => {
          props.onChange?.((event.currentTarget as HTMLInputElement).value)
        }}
        onBlur={props.onBlur}
      />
    </FormFieldShell>
  )
}

export function PluginTextarea(props: PluginUiTextareaProps) {
  return (
    <FormFieldShell label={props.label} description={props.description}>
      <textarea
        className={styles.textarea}
        value={props.value}
        defaultValue={props.defaultValue}
        placeholder={props.placeholder}
        rows={props.rows ?? 4}
        disabled={props.disabled}
        required={props.required}
        aria-invalid={props.invalid || undefined}
        onChange={(event) => props.onChange?.(event.currentTarget.value)}
      />
    </FormFieldShell>
  )
}

export function PluginSelect<T extends string>(props: PluginUiSelectProps<T>) {
  return (
    <FormFieldShell label={props.label} description={props.description}>
      <Select
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => {
          props.onChange?.((event.target as HTMLSelectElement).value as T)
        }}
      >
        {props.options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </Select>
    </FormFieldShell>
  )
}

export function PluginSwitch(props: PluginUiSwitchProps) {
  return (
    <div className={styles.toggleRow}>
      <div className={styles.toggleLabels}>
        {props.label && <span className={styles.label}>{props.label}</span>}
        {props.description && <span className={styles.description}>{props.description}</span>}
      </div>
      <Switch
        checked={Boolean(props.checked)}
        disabled={props.disabled}
        onCheckedChange={props.onChange}
      />
    </div>
  )
}

export function PluginCheckbox(props: PluginUiCheckboxProps) {
  return (
    <label className={styles.checkboxRow}>
      <Checkbox
        checked={Boolean(props.checked)}
        disabled={props.disabled}
        onCheckedChange={props.onChange}
      />
      <span className={styles.checkboxText}>
        {props.label && <span className={styles.label}>{props.label}</span>}
        {props.description && <span className={styles.description}>{props.description}</span>}
      </span>
    </label>
  )
}

export function PluginSearchBar(props: PluginUiSearchBarProps) {
  return (
    <SearchBar
      placeholder={props.placeholder}
      value={props.value ?? ''}
      onValueChange={props.onChange ?? (() => {})}
    />
  )
}

// ---------------------------------------------------------------------------
// Layout primitives
// ---------------------------------------------------------------------------

export function PluginStack(props: PluginUiStackProps) {
  const style: CSSProperties = {
    display: 'flex',
    flexDirection: props.direction ?? 'column',
    gap: `${props.gap ?? 8}px`,
    alignItems: alignToCss(props.align),
    justifyContent: justifyToCss(props.justify),
    flexWrap: props.wrap ? 'wrap' : 'nowrap',
    height: typeof props.height === 'number' ? `${props.height}px` : props.height,
  }
  return (
    <div className={styles.stack} style={style}>
      {props.children}
    </div>
  )
}

function alignToCss(value: PluginUiStackProps['align']): CSSProperties['alignItems'] | undefined {
  if (!value) return undefined
  if (value === 'start') return 'flex-start'
  if (value === 'end') return 'flex-end'
  return value
}

function justifyToCss(value: PluginUiStackProps['justify']): CSSProperties['justifyContent'] | undefined {
  if (!value) return undefined
  if (value === 'start') return 'flex-start'
  if (value === 'end') return 'flex-end'
  if (value === 'between') return 'space-between'
  if (value === 'around') return 'space-around'
  return value
}

export function PluginCard(props: PluginUiCardProps) {
  const padding = props.padding ?? 16
  const className = props.bordered === false ? styles.cardBare : styles.card
  return (
    <div className={className} style={{ padding }}>
      {props.children}
    </div>
  )
}

export function PluginHeading(props: PluginUiHeadingProps) {
  const Tag = `h${props.level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
  return <Tag className={styles.heading}>{props.children}</Tag>
}

export function PluginText(props: PluginUiTextProps) {
  const variant = props.variant ?? 'default'
  const size = props.size ?? 'md'
  const className = [
    styles.text,
    variant === 'muted' ? styles.textMuted : '',
    variant === 'strong' ? styles.textStrong : '',
    variant === 'mono' ? styles.textMono : '',
    size === 'sm' ? styles.textSm : '',
    size === 'lg' ? styles.textLg : '',
  ].filter(Boolean).join(' ')
  return <p className={className}>{props.children}</p>
}

export function PluginSeparator(props: PluginUiSeparatorProps) {
  return <Separator orientation={props.orientation ?? 'horizontal'} />
}

export function PluginEmptyState(props: PluginUiEmptyStateProps) {
  return (
    <div className={styles.emptyState}>
      <h3 className={styles.heading}>{props.title}</h3>
      {props.body && <p className={styles.description}>{props.body}</p>}
      {props.action && <div className={styles.emptyAction}>{props.action}</div>}
    </div>
  )
}

export function PluginAlert(props: PluginUiAlertProps) {
  const tone = props.tone ?? 'info'
  const toneClass = tone === 'danger'
    ? styles.alertDanger
    : tone === 'warning'
      ? styles.alertWarning
      : tone === 'success'
        ? styles.alertSuccess
        : styles.alertInfo
  const role = tone === 'danger' || tone === 'warning' ? 'alert' : 'status'
  return (
    <div className={[styles.alert, toneClass].join(' ')} role={role}>
      {props.title && <strong className={styles.alertTitle}>{props.title}</strong>}
      <div className={styles.alertBody}>{props.children}</div>
    </div>
  )
}

export function PluginCode(props: PluginUiCodeProps) {
  return <pre className={styles.code}>{props.children}</pre>
}
