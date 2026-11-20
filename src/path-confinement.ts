import { lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'

/**
 * Resolves `value` against `root` and refuses it unless it stays inside `root`
 * both as written and after symbolic links are followed.
 *
 * A check on the written path alone lets a link inside the root point anywhere on
 * disk. The target need not exist yet (an output file): the deepest existing parent
 * is resolved instead. A link whose target is missing is refused, because writing
 * through it would create a file wherever it points.
 *
 * The written path is returned, not the resolved one, so callers and tool results
 * keep the path the client used. The check and the later file operation are separate
 * steps; something that can swap a link between them is outside what this guards.
 */
export function confinedPath(root: string, value: string, label = 'ANX workspace'): string {
  const lexicalRoot = path.resolve(root)
  const resolved = path.resolve(lexicalRoot, value)
  const outside = (): never => { throw new Error(`Path is outside the configured ${label}: ${value}`) }
  if (!isInside(lexicalRoot, resolved)) outside()
  let realRoot: string
  try {
    realRoot = realpathSync(lexicalRoot)
  } catch {
    throw new Error(`The configured ${label} does not exist: ${lexicalRoot}`)
  }
  if (!isInside(realRoot, realPathOfDeepestExisting(resolved, outside))) outside()
  return resolved
}

function realPathOfDeepestExisting(target: string, refuse: () => never): string {
  const missing: string[] = []
  let current = target
  for (;;) {
    try {
      return path.join(realpathSync(current), ...missing)
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    if (existsWithoutFollowing(current)) refuse()
    const parent = path.dirname(current)
    if (parent === current) return path.join(current, ...missing)
    missing.unshift(path.basename(current))
    current = parent
  }
}

function existsWithoutFollowing(candidate: string): boolean {
  try {
    lstatSync(candidate)
    return true
  } catch {
    return false
  }
}

function isInside(root: string, candidate: string): boolean {
  if (candidate === root) return true
  const relative = path.relative(root, candidate)
  return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}
