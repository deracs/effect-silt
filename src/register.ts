import { register } from "node:module"

// Node preload is the explicit build boundary for unbundled SQL imports.
// The async loader lets compilation use Effect's native filesystem operations.
register(new URL("./sql-loader.js", import.meta.url))
