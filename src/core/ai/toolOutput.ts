import { Type, type Static } from '@core/utils/typeboxHelpers'

export const AiToolOutputSchema = Type.Object({
  ok: Type.Boolean(),
  data: Type.Optional(Type.Unknown()),
  error: Type.Optional(Type.String()),
})

export type AiToolOutput = Static<typeof AiToolOutputSchema>

export function aiToolOk(data?: unknown): AiToolOutput {
  return data === undefined ? { ok: true } : { ok: true, data }
}

export function aiToolError(error: string): AiToolOutput {
  return { ok: false, error }
}
