export type ContentEntryStatus = 'draft' | 'published' | 'unpublished'

export interface ContentCollection {
  id: string
  name: string
  slug: string
  singularLabel: string
  pluralLabel: string
  createdAt: string
  updatedAt: string
}

export interface ContentEntry {
  id: string
  collectionId: string
  title: string
  slug: string
  status: ContentEntryStatus
  bodyMarkdown: string
  featuredMediaId: string | null
  seoTitle: string
  seoDescription: string
  createdAt: string
  updatedAt: string
  publishedAt: string | null
  deletedAt: string | null
}

export interface ContentEntryDraftInput {
  title: string
  slug: string
  bodyMarkdown: string
  featuredMediaId: string | null
  seoTitle: string
  seoDescription: string
}

export interface CreateContentEntryInput {
  title: string
  slug?: string
  bodyMarkdown?: string
  featuredMediaId?: string | null
  seoTitle?: string
  seoDescription?: string
}
