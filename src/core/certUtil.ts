/** Thin wrapper around certutil so cert.ts can use it without importing child_process twice. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export const execFileAsync = promisify(execFile)