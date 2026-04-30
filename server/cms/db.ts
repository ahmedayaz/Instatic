export interface DbResult<Row = Record<string, unknown>> {
  rows: Row[]
  rowCount: number
}

export interface DbClient {
  query<Row = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<DbResult<Row>>
}
