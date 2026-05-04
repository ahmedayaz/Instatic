import type {
  BuiltInContentCollectionField,
  ContentCollection,
  ContentCollectionFields,
} from './schemas'

export const DEFAULT_CONTENT_COLLECTION_FIELDS: ContentCollectionFields = {
  builtIn: {
    body: true,
    featuredMedia: true,
    seo: true,
  },
  custom: [],
}

export function normalizeContentCollectionFields(value: unknown): ContentCollectionFields {
  if (!value || typeof value !== 'object') return DEFAULT_CONTENT_COLLECTION_FIELDS

  const raw = value as {
    builtIn?: Partial<Record<BuiltInContentCollectionField, unknown>>
    custom?: unknown
  }

  return {
    builtIn: {
      body: typeof raw.builtIn?.body === 'boolean'
        ? raw.builtIn.body
        : DEFAULT_CONTENT_COLLECTION_FIELDS.builtIn.body,
      featuredMedia: typeof raw.builtIn?.featuredMedia === 'boolean'
        ? raw.builtIn.featuredMedia
        : DEFAULT_CONTENT_COLLECTION_FIELDS.builtIn.featuredMedia,
      seo: typeof raw.builtIn?.seo === 'boolean'
        ? raw.builtIn.seo
        : DEFAULT_CONTENT_COLLECTION_FIELDS.builtIn.seo,
    },
    custom: Array.isArray(raw.custom) ? [] : [],
  }
}

export function contentCollectionHasField(
  collection: ContentCollection | null | undefined,
  field: BuiltInContentCollectionField,
): boolean {
  return normalizeContentCollectionFields(collection?.fields).builtIn[field]
}
