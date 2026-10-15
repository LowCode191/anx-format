#!/usr/bin/env node
// Checks that every evidence fragment group in tasks.json is present in the canonical
// text of the task's document(s) after import, so a frozen task can never point at
// text the corpus does not contain. Run after prepare-corpus.ts.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { buildCorpusIndexes, type CorpusIndex } from './corpus-engine.js'

interface DiscoveryTask { id: string; documentId: string; evidenceFragmentGroups: string[][] }
interface CrossTask { id: string; requiredDocumentIds: string[]; evidenceFragmentGroups: string[][] }
interface Fixture { discoveryTasks: DiscoveryTask[]; crossDocumentTasks: CrossTask[]; relationships: any[] }

const root = import.meta.dirname
const fixture = JSON.parse(await readFile(path.join(root, 'tasks.json'), 'utf8')) as Fixture
const { anx, markdown } = await buildCorpusIndexes({
  manifestPath: path.join(root, 'corpus/manifest.json'),
  packagesDirectory: path.join(root, 'corpus/packages'),
  relationships: fixture.relationships,
})

const misses: string[] = []
for (const index of [anx, markdown]) {
  for (const task of fixture.discoveryTasks) check(index, task.id, [task.documentId], task.evidenceFragmentGroups)
  for (const task of fixture.crossDocumentTasks) check(index, task.id, task.requiredDocumentIds, task.evidenceFragmentGroups)
}

if (misses.length) {
  process.stderr.write(`${misses.join('\n')}\n`)
  process.stderr.write(`[verify-tasks] ${misses.length} fragment group(s) not found\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`[verify-tasks] all fragment groups present in both arms (${fixture.discoveryTasks.length} discovery, ${fixture.crossDocumentTasks.length} cross-document tasks)\n`)
}

function check(index: CorpusIndex, taskId: string, documentIds: string[], groups: string[][]) {
  const texts = index.units.filter(unit => documentIds.includes(unit.corpusDocumentId)).map(unit => normalize(unit.text))
  groups.forEach((group, position) => {
    const found = group.some(fragment => texts.some(text => text.includes(normalize(fragment))))
    if (!found) misses.push(`[${index.arm}] ${taskId} group ${position + 1}: ${JSON.stringify(group)}`)
  })
}

function normalize(value: string): string { return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}.]+/gu, ' ').replace(/\s+/gu, ' ').trim() }
