#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  hydrateCorpusIndex,
  resolveCorpusCitation,
  searchCorpus,
  traverseCorpusRelationships,
  type CorpusArm,
  type SerializedCorpusIndex,
} from './corpus-engine.js'

type Operation = 'search' | 'search-document' | 'get' | 'relationships' | 'documents'

const [armValue, operationValue, ...values] = process.argv.slice(2)
if (!['anx', 'markdown'].includes(armValue || '') || !['search', 'search-document', 'get', 'relationships', 'documents'].includes(operationValue || '')) usage()
const arm: CorpusArm = armValue === 'anx' ? 'anx-native-corpus' : 'markdown-strong-corpus'
const runtimePath = path.join(import.meta.dirname, 'runtime', armValue === 'anx' ? 'anx-index.json' : 'markdown-index.json')
const index = hydrateCorpusIndex(JSON.parse(await readFile(runtimePath, 'utf8')) as SerializedCorpusIndex)

let result: unknown
if (operationValue === 'search') {
  if (!values[0]) usage()
  result = searchCorpus(index, values[0], { limit: positiveInteger(values[1], 12), maximumPerDocument: 4 })
} else if (operationValue === 'search-document') {
  if (!values[0] || !values[1]) usage()
  if (!index.documents.some(document => document.id === values[0])) throw new Error(`Corpus document not found: ${values[0]}`)
  result = searchCorpus(index, values[1], {
    limit: positiveInteger(values[2], 12),
    maximumPerDocument: 12,
    documentIds: [values[0]],
  })
} else if (operationValue === 'get') {
  if (!values[0]) usage()
  const evidence = resolveCorpusCitation(index, values[0])
  if (!evidence) throw new Error(`Corpus citation not found: ${values[0]}`)
  result = { schema: 'anx.corpus-evidence.v1', arm, evidence }
} else if (operationValue === 'relationships') {
  if (!values[0]) usage()
  const direction = values[1] === 'outbound' || values[1] === 'inbound' ? values[1] : 'both'
  result = {
    schema: 'anx.corpus-relationships.v1',
    arm,
    documentId: values[0],
    direction,
    relationships: traverseCorpusRelationships(index, { documentId: values[0], direction }),
    claimBoundary: 'A relationship is a declared corpus assertion. Use target document evidence for claims about target content.',
  }
} else {
  result = {
    schema: 'anx.corpus-documents.v1',
    arm,
    documents: index.documents.map(document => ({
      id: document.id,
      title: document.title,
      publisher: document.publisher,
      publicationDate: document.publicationDate,
      revision: document.revision,
      current: document.current,
    })),
  }
}

process.stdout.write(`${JSON.stringify(result)}\n`)

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 100) throw new Error(`Invalid positive integer: ${value}`)
  return parsed
}

function usage(): never {
  process.stderr.write([
    'Usage:',
    '  corpus-tool-cli.ts <anx|markdown> search <query> [limit]',
    '  corpus-tool-cli.ts <anx|markdown> search-document <documentId> <query> [limit]',
    '  corpus-tool-cli.ts <anx|markdown> get <citation>',
    '  corpus-tool-cli.ts <anx|markdown> relationships <documentId> [outbound|inbound|both]',
    '  corpus-tool-cli.ts <anx|markdown> documents',
  ].join('\n') + '\n')
  process.exit(2)
}
