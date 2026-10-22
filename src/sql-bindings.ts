type SqlRowBinding = { readonly name: string; readonly start: number; readonly end: number }

/** Named SQL parameters become positional bindings without changing quoted text or comments. */
export function compileSqlBindings(source: string): {
  readonly sql: string
  readonly parserSql: string
  readonly bindings: ReadonlyArray<string>
  readonly rowBinding?: SqlRowBinding
} {
  const bindings: string[] = []
  const tokens: string[] = []
  let rowBinding: SqlRowBinding | undefined
  let rowToken = -1
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
      tokens.push(source.slice(start, index))
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
      const name = source.slice(start, index)
      bindings.push(name)
      if (source.startsWith("[]", index)) {
        if (rowBinding) throw new Error("Silt supports one row array per INSERT")
        // The parser checks tuple width before it returns an AST. Count the explicit
        // column tokens here; quoted identifiers and comments stay indivisible.
        const open = tokens.lastIndexOf("(")
        const columns = tokens.slice(open + 1, -2)
        if (
          tokens[0]?.toUpperCase() !== "INSERT" ||
          tokens.at(-1)?.toUpperCase() !== "VALUES" ||
          tokens.at(-2) !== ")" ||
          open < 0 ||
          columns.length === 0 ||
          columns.some((token, i) =>
            i % 2 === 1 ? token !== "," : ["(", ")", ","].includes(token),
          )
        )
          throw new Error("Silt row arrays require INSERT INTO table (columns) VALUES :name[]")
        const width = (columns.length + 1) / 2
        if (!Number.isInteger(width))
          throw new Error("Silt row arrays require an explicit column list")
        const tuple = `(${Array.from({ length: width }, () => "?").join(", ")})`
        rowBinding = { name, start: sql.length, end: sql.length + tuple.length }
        rowToken = tokens.length
        sql += tuple
        // NULL is only a parser stand-in. The analyzer obtains row types from the
        // target columns, and SQLite prepares the positional template without execution.
        parserSql += `(${Array.from({ length: width }, () => "NULL").join(", ")})`
        index += 2
      } else {
        sql += "?"
        parserSql += source.slice(start - 1, index)
      }
      tokens.push(`:${name}`)
    } else if (char === "?" || char === "@" || char === "$") {
      throw new Error("Silt SQL parameters must use the :name syntax")
    } else if (/[A-Za-z_]/.test(char ?? "")) {
      const start = index++
      while (/[A-Za-z0-9_]/.test(source[index] ?? "")) index++
      const word = source.slice(start, index)
      tokens.push(word)
      sql += word
      parserSql += word
    } else {
      if (char?.trim()) tokens.push(char)
      sql += char
      parserSql += char
      index++
    }
  }
  if (rowBinding) {
    const next = tokens[rowToken + 1]
    if (next !== undefined && next !== ";" && next.toUpperCase() !== "RETURNING")
      throw new Error("Silt row arrays must be the entire INSERT VALUES clause")
    if (bindings.filter((name) => name === rowBinding.name).length !== 1)
      throw new Error("Silt row array names cannot also be scalar parameters")
  }
  return { sql, parserSql, bindings, ...(rowBinding ? { rowBinding } : {}) }
}
