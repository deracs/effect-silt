/** Named SQL parameters become positional bindings without changing quoted text or comments. */
export function compileSqlBindings(source: string): {
  readonly sql: string
  readonly parserSql: string
  readonly bindings: ReadonlyArray<string>
} {
  const bindings: string[] = []
  let sql = ""
  let parserSql = ""
  let index = 0
  while (index < source.length) {
    const char = source[index]
    if (char === "'" || char === '"' || char === "`" || char === "[") {
      const start = index
      const close = char === "[" ? "]" : char
      sql += char
      index++
      while (index < source.length) {
        const next = source[index]
        sql += next
        index++
        if (next === close) {
          if (source[index] === close && close !== "]") {
            sql += close
            index++
          } else break
        }
      }
      // SQLite treats backslashes literally. The parser also accepts MySQL escapes,
      // so hide string contents from it. SQLite still prepares the original SQL.
      parserSql += char === "'" ? "'silt_literal'" : source.slice(start, index)
    } else if (source.startsWith("--", index)) {
      const end = source.indexOf("\n", index)
      const stop = end === -1 ? source.length : end
      sql += source.slice(index, stop)
      parserSql += " "
      index = stop
    } else if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2)
      const stop = end === -1 ? source.length : end + 2
      sql += source.slice(index, stop)
      parserSql += " "
      index = stop
    } else if (char === ":" && /[A-Za-z_]/.test(source[index + 1] ?? "")) {
      const start = ++index
      while (index < source.length && /[A-Za-z0-9_]/.test(source[index] ?? "")) index++
      bindings.push(source.slice(start, index))
      sql += "?"
      parserSql += source.slice(start - 1, index)
    } else if (char === "?" || char === "@" || char === "$") {
      throw new Error("Silt SQL parameters must use the :name syntax")
    } else {
      sql += char
      parserSql += char
      index++
    }
  }
  return { sql, parserSql, bindings }
}
