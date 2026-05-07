/**
 * Framework colors — token CRUD helpers + store actions.
 */

import { nanoid } from 'nanoid'
import type {
  FrameworkColorToken,
  SiteDocument,
  SiteSettings,
} from '@core/page-tree'
import {
  generateDefaultDarkColor,
  normalizeFrameworkColorSlug,
} from '@core/framework/colors'
import { reconcileFrameworkClasses } from './reconcile'
import { nextOrderValue } from './shared'
import type {
  CreateFrameworkColorTokenInput,
  ColorVariantOptions,
  SiteSlice,
  SiteSliceHelpers,
  UpdateFrameworkColorTokenPatch,
} from '../types'

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_COLOR_UTILITIES = {
  text: true,
  background: true,
  border: true,
  fill: false,
} as const

const DEFAULT_COLOR_VARIANTS: ColorVariantOptions = { enabled: true, count: 4 }

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function ensureFrameworkColors(
  site: SiteDocument,
): NonNullable<SiteSettings['framework']>['colors'] {
  if (!site.settings.framework) {
    site.settings.framework = { colors: { tokens: [] } }
  }
  if (!site.settings.framework.colors) {
    site.settings.framework.colors = { tokens: [] }
  }
  site.settings.framework.colors.tokens ??= []
  return site.settings.framework.colors
}

function normalizeCategoryLabel(input: string | undefined | null): string {
  return typeof input === 'string' ? input.trim() : ''
}

/**
 * Match a new category label against existing tokens case-insensitively.
 * If any other token already uses a category with the same letters (regardless
 * of case), the canonical casing of that existing label wins — this prevents
 * "Brand" and "brand" from drifting into separate categories when the user
 * forgets the original capitalization.
 */
function canonicalizeCategoryLabel(
  input: string | undefined | null,
  tokens: FrameworkColorToken[],
  excludeTokenId?: string,
): string {
  const trimmed = normalizeCategoryLabel(input)
  if (!trimmed) return ''
  const lower = trimmed.toLowerCase()
  for (const token of tokens) {
    if (token.id === excludeTokenId) continue
    const existing = token.category.trim()
    if (existing && existing.toLowerCase() === lower) return existing
  }
  return trimmed
}

function uniqueColorSlug(
  tokens: FrameworkColorToken[],
  desiredSlug: string,
  excludeTokenId?: string,
): string {
  const base = normalizeFrameworkColorSlug(desiredSlug)
  const existing = new Set(
    tokens
      .filter((token) => token.id !== excludeTokenId)
      .map((token) => normalizeFrameworkColorSlug(token.slug)),
  )
  if (!existing.has(base)) return base

  let suffix = 2
  while (existing.has(`${base}-${suffix}`)) {
    suffix += 1
  }
  return `${base}-${suffix}`
}

function createFrameworkColorTokenFromInput(
  input: CreateFrameworkColorTokenInput,
  colors: NonNullable<SiteSettings['framework']>['colors'],
): FrameworkColorToken {
  const now = Date.now()
  const lightValue = input.lightValue.trim()
  return {
    id: nanoid(),
    category: canonicalizeCategoryLabel(input.category, colors.tokens),
    slug: uniqueColorSlug(colors.tokens, input.slug),
    lightValue,
    darkValue: input.darkValue?.trim() || generateDefaultDarkColor(lightValue),
    darkModeEnabled: input.darkModeEnabled ?? false,
    generateUtilities: {
      ...DEFAULT_COLOR_UTILITIES,
      ...(input.generateUtilities ?? {}),
    },
    generateTransparent: input.generateTransparent ?? true,
    generateShades: {
      ...DEFAULT_COLOR_VARIANTS,
      ...(input.generateShades ?? {}),
    },
    generateTints: {
      ...DEFAULT_COLOR_VARIANTS,
      ...(input.generateTints ?? {}),
    },
    order: nextOrderValue(colors.tokens),
    createdAt: now,
    updatedAt: now,
  }
}

function applyFrameworkColorTokenPatch(
  token: FrameworkColorToken,
  patch: UpdateFrameworkColorTokenPatch,
  colors: NonNullable<SiteSettings['framework']>['colors'],
): void {
  if (patch.category !== undefined) {
    token.category = canonicalizeCategoryLabel(patch.category, colors.tokens, token.id)
  }
  if (patch.slug !== undefined) token.slug = uniqueColorSlug(colors.tokens, patch.slug, token.id)
  if (patch.lightValue !== undefined) token.lightValue = patch.lightValue.trim()
  if (patch.darkValue !== undefined) token.darkValue = patch.darkValue.trim()
  if (patch.darkModeEnabled !== undefined) {
    token.darkModeEnabled = patch.darkModeEnabled
    if (patch.darkModeEnabled && !patch.darkValue && !token.darkValue) {
      token.darkValue = generateDefaultDarkColor(token.lightValue)
    }
  }
  if (patch.generateUtilities) {
    token.generateUtilities = {
      ...token.generateUtilities,
      ...patch.generateUtilities,
    }
  }
  if (patch.generateTransparent !== undefined) token.generateTransparent = patch.generateTransparent
  if (patch.generateShades) {
    token.generateShades = { ...token.generateShades, ...patch.generateShades }
  }
  if (patch.generateTints) {
    token.generateTints = { ...token.generateTints, ...patch.generateTints }
  }
  if (patch.order !== undefined) token.order = patch.order
  token.updatedAt = Date.now()
}

function cloneFrameworkColorToken(
  token: FrameworkColorToken,
  colors: NonNullable<SiteSettings['framework']>['colors'],
): FrameworkColorToken {
  const now = Date.now()
  return {
    ...structuredClone(token),
    id: nanoid(),
    slug: uniqueColorSlug(colors.tokens, `${token.slug}-copy`),
    order: nextOrderValue(colors.tokens),
    createdAt: now,
    updatedAt: now,
  }
}

function reorderFrameworkColorTokenInGroup(
  colors: NonNullable<SiteSettings['framework']>['colors'],
  tokenId: string,
  direction: 'up' | 'down',
): void {
  const token = colors.tokens.find((candidate) => candidate.id === tokenId)
  if (!token) return

  const group = colors.tokens
    .filter((candidate) => candidate.category === token.category)
    .sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug))
  const currentIndex = group.findIndex((candidate) => candidate.id === tokenId)
  const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1
  if (currentIndex < 0 || targetIndex < 0 || targetIndex >= group.length) return

  const orderValues = group.map((candidate) => candidate.order).sort((a, b) => a - b)
  const reordered = [...group]
  const [moved] = reordered.splice(currentIndex, 1)
  reordered.splice(targetIndex, 0, moved)

  for (let index = 0; index < reordered.length; index += 1) {
    reordered[index].order = orderValues[index] ?? index
    reordered[index].updatedAt = Date.now()
  }
}

// ---------------------------------------------------------------------------
// Action factory
// ---------------------------------------------------------------------------

export type FrameworkColorActions = Pick<
  SiteSlice,
  | 'createFrameworkColorToken'
  | 'updateFrameworkColorToken'
  | 'duplicateFrameworkColorToken'
  | 'reorderFrameworkColorToken'
  | 'deleteFrameworkColorToken'
>

export function createFrameworkColorActions({
  get,
  mutateSite,
}: SiteSliceHelpers): FrameworkColorActions {
  return {
    createFrameworkColorToken: (input) => {
      const { site } = get()
      if (!site) throw new Error('[siteSlice] Site document is not initialized')
      // Read-only view of the (Immer-frozen) live site — `ensureFrameworkColors`
      // mutates and would throw on the frozen object. The actual write happens
      // inside `mutateSite` below where Immer's draft is mutable.
      const colors = site.settings.framework?.colors ?? { tokens: [] }
      const token = createFrameworkColorTokenFromInput(input, colors)

      mutateSite((draftSite) => {
        const draftColors = ensureFrameworkColors(draftSite)
        draftColors.tokens.push(token)
        reconcileFrameworkClasses(draftSite)
      })

      return token
    },

    updateFrameworkColorToken: (tokenId, patch) => {
      mutateSite((site) => {
        const colors = ensureFrameworkColors(site)
        const token = colors.tokens.find((candidate) => candidate.id === tokenId)
        if (!token) return
        applyFrameworkColorTokenPatch(token, patch, colors)
        reconcileFrameworkClasses(site)
      })
    },

    duplicateFrameworkColorToken: (tokenId) => {
      const { site } = get()
      if (!site) return null
      // Read-only view of the (Immer-frozen) live site — see note in
      // `createFrameworkColorToken` for why we don't call `ensureFrameworkColors`
      // here. The actual write happens inside `mutateSite` below.
      const colors = site.settings.framework?.colors ?? { tokens: [] }
      const token = colors.tokens.find((candidate) => candidate.id === tokenId)
      if (!token) return null
      const copy = cloneFrameworkColorToken(token, colors)

      mutateSite((draftSite) => {
        const draftColors = ensureFrameworkColors(draftSite)
        draftColors.tokens.push(copy)
        reconcileFrameworkClasses(draftSite)
      })

      return copy
    },

    reorderFrameworkColorToken: (tokenId, direction) => {
      mutateSite((site) => {
        const colors = ensureFrameworkColors(site)
        reorderFrameworkColorTokenInGroup(colors, tokenId, direction)
        reconcileFrameworkClasses(site)
      })
    },

    deleteFrameworkColorToken: (tokenId) => {
      mutateSite((site) => {
        const colors = ensureFrameworkColors(site)
        colors.tokens = colors.tokens.filter((token) => token.id !== tokenId)
        reconcileFrameworkClasses(site)
      })
    },
  }
}
