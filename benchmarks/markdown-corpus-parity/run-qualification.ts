#!/usr/bin/env node
// Deterministic qualification: builds both corpus arms from the prepared ANX packages,
// scores the frozen discovery and cross-document tasks, checks citation resolution,
// relationship traversal, determinism and a scaled probe, then writes the runtime
// indexes that the live stage uses. PASS qualifies the transport, not a winner.
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  buildCorpusIndexes,
  resolveCorpusCitation,
  searchCorpus,
  serializeCorpusIndex,
  traverseCorpusRelationships,
  type CorpusIndex,
  type CorpusRelationshipFixture,
  type CorpusSearchResult,
} from './corpus-engine.js'

interface DiscoveryTask {
  id: string
  documentId: string
  family: string
  question: string
  requiredAnswerConcepts: string[][]
  evidenceFragmentGroups: string[][]
}

interface CrossTask {
  id: string
  family: string
  question: string
  requiredDocumentIds: string[]
  requiredRelationshipIds?: string[]
  requiredAnswerConcepts: string[][]
  evidenceFragmentGroups: string[][]
}

interface TaskFixture {
  benchmarkId: string
  discoveryTasks: DiscoveryTask[]
  crossDocumentTasks: CrossTask[]
  relationships: CorpusRelationshipFixture[]
}

const benchmarkRoot = import.meta.dirname
const resultsDirectory = path.join(benchmarkRoot, 'results')
const runtimeDirectory = path.join(benchmarkRoot, 'runtime')
const manifestPath = path.join(benchmarkRoot, 'corpus/manifest.json')
const packagesDirectory = path.join(benchmarkRoot, 'corpus/packages')
const expectedDocuments = 12
const expectedDiscoveryTasks = 24
const expectedCrossTasks = 6
const scaleMultiplier = 20

const fixture = JSON.parse(await readFile(path.join(benchmarkRoot, 'tasks.json'), 'utf8')) as TaskFixture
const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { documents: Array<{ id: string; fileName: string }> }
const sourceBefore = await packageHashes()
const buildStarted = performance.now()
const indexes = await buildCorpusIndexes({ manifestPath, packagesDirectory, relationships: fixture.relationships })
const buildElapsedMs = Number((performance.now() - buildStarted).toFixed(3))

const arms = [indexes.anx, indexes.markdown]
const discovery = arms.map(index => ({ arm: index.arm, tasks: fixture.discoveryTasks.map(task => scoreTask(index, task.id, task.question, [task.documentId], task.evidenceFragmentGroups)) }))
const crossDocument = arms.map(index => ({ arm: index.arm, tasks: fixture.crossDocumentTasks.map(task => scoreTask(index, task.id, task.question, task.requiredDocumentIds, task.evidenceFragmentGroups, task.requiredRelationshipIds)) }))
const sourceAfter = await packageHashes()

const determinism = arms.map(index => {
  const first = fixture.crossDocumentTasks.map(task => stableSearch(index, task.question))
  const second = fixture.crossDocumentTasks.map(task => stableSearch(index, task.question))
  return { arm: index.arm, byteIdenticalSearchReplay: JSON.stringify(first) === JSON.stringify(second), sha256: sha256(JSON.stringify(first)) }
})

const scaled = arms.map(index => scaledProbe(index, scaleMultiplier))
const aggregates = arms.map(index => {
  const discoveryRows = discovery.find(item => item.arm === index.arm)!.tasks
  const crossRows = crossDocument.find(item => item.arm === index.arm)!.tasks
  const all = [...discoveryRows, ...crossRows]
  return {
    arm: index.arm,
    documents: index.documents.length,
    evidenceUnits: index.units.length,
    discoveryDocumentRecallAt12: average(discoveryRows.map(row => row.documentRecall)),
    discoveryEvidenceRecallAt12: average(discoveryRows.map(row => row.evidenceRecall)),
    crossDocumentRecallAt12: average(crossRows.map(row => row.documentRecall)),
    crossDocumentEvidenceRecallAt12: average(crossRows.map(row => row.evidenceRecall)),
    relationshipTaskRecallAt12: average(crossRows.filter(row => row.requiredRelationshipCount > 0).map(row => row.relationshipRecall)),
    citationResolutionRate: average(all.map(row => row.citationResolutionRate)),
    medianQueryMs: percentile(all.map(row => row.queryElapsedMs), 0.5),
    p95QueryMs: percentile(all.map(row => row.queryElapsedMs), 0.95),
    meanPayloadCharacters: average(all.map(row => row.payloadCharacters)),
  }
})

const relationshipGate = typedRelationshipGate()
const gates = [
  gate('real-corpus-loaded', indexes.anx.documents.length === expectedDocuments && indexes.markdown.documents.length === expectedDocuments, `Both arms contain all ${expectedDocuments} public documents.`),
  gate('discovery-contract-complete', fixture.discoveryTasks.length === expectedDiscoveryTasks, `${fixture.discoveryTasks.length}/${expectedDiscoveryTasks} frozen discovery tasks loaded.`),
  gate('cross-document-contract-complete', fixture.crossDocumentTasks.length === expectedCrossTasks, `${fixture.crossDocumentTasks.length}/${expectedCrossTasks} cross-document tasks loaded.`),
  gate('source-packages-byte-identical', JSON.stringify(sourceBefore) === JSON.stringify(sourceAfter), 'Every source ANX package hash is unchanged after both indexes and all searches.'),
  gate('citations-resolve-anx', aggregates.find(row => row.arm === 'anx-native-corpus')!.citationResolutionRate === 1, 'All returned ANX citations resolve to indexed evidence.'),
  gate('citations-resolve-markdown', aggregates.find(row => row.arm === 'markdown-strong-corpus')!.citationResolutionRate === 1, 'All returned Markdown file/line citations resolve to indexed evidence.'),
  gate('typed-relationship-traversal', relationshipGate.passed, `${relationshipGate.checked} declared relationships traverse outbound from the source and inbound to the target in both arms.`),
  gate('deterministic-search-replay', determinism.every(item => item.byteIdenticalSearchReplay), 'Repeated searches produce byte-identical ranked evidence after timing fields are removed.'),
  gate('scaled-probe-complete', scaled.every(item => item.logicalDocuments === expectedDocuments * scaleMultiplier && item.queries === expectedDiscoveryTasks + expectedCrossTasks), `Both arms completed ${expectedDiscoveryTasks + expectedCrossTasks} queries over ${expectedDocuments * scaleMultiplier} logical document records.`),
  gate('no-superiority-assumption', true, 'Qualification gates transport integrity; comparative performance remains an observed result.'),
]

const result = {
  schema: 'anx.corpus-comparative-qualification.v1',
  benchmarkId: fixture.benchmarkId,
  stage: 'deterministic-qualification',
  generatedAt: new Date().toISOString(),
  status: gates.every(item => item.passed) ? 'PASS' : 'HOLD',
  inputs: {
    publicDocuments: indexes.anx.documents.length,
    discoveryTasks: fixture.discoveryTasks.length,
    crossDocumentTasks: fixture.crossDocumentTasks.length,
    relationships: fixture.relationships.length,
    buildElapsedMs,
    packageSha256: sourceBefore,
  },
  controls: {
    sameCanonicalText: true,
    sameRanker: true,
    sameRetrievalLimit: 12,
    samePerDocumentCap: 4,
    targetPathWithheld: true,
    embeddings: false,
    markdownBaseline: 'strong-gfm-with-frontmatter-and-file-line-citations',
  },
  aggregates,
  discovery,
  crossDocument,
  determinism,
  scaled,
  gates,
  claimBoundary: `PASS qualifies a deterministic ${expectedDocuments}-real-document corpus transport and a ${expectedDocuments * scaleMultiplier}-logical-document scale probe. It does not prove ANX superiority, semantic or vector retrieval quality, enterprise production latency, or access-control behavior. Live model answer quality is a separate stage.`,
}

await mkdir(resultsDirectory, { recursive: true })
await mkdir(runtimeDirectory, { recursive: true })
await writeFile(path.join(resultsDirectory, 'qualification.json'), `${JSON.stringify(result, null, 2)}\n`)
await writeFile(path.join(resultsDirectory, 'qualification.md'), markdownReport(result))
await writeFile(path.join(runtimeDirectory, 'anx-index.json'), `${JSON.stringify(serializeCorpusIndex(indexes.anx))}\n`)
await writeFile(path.join(runtimeDirectory, 'markdown-index.json'), `${JSON.stringify(serializeCorpusIndex(indexes.markdown))}\n`)
process.stdout.write(`${JSON.stringify({ status: result.status, gates: `${gates.filter(item => item.passed).length}/${gates.length}`, aggregates, scaled }, null, 2)}\n`)
if (result.status !== 'PASS') process.exitCode = 1

function scoreTask(index: CorpusIndex, taskId: string, question: string, requiredDocuments: string[], evidenceGroups: string[][], requiredRelationships: string[] = []) {
  const result = searchCorpus(index, question, { limit: 12, maximumPerDocument: 4 })
  const returnedDocuments = new Set(result.hits.map(hit => hit.corpusDocumentId))
  const normalizedEvidence = result.hits.map(hit => normalize(hit.text))
  const evidenceHits = evidenceGroups.map(group => group.some(fragment => normalizedEvidence.some(text => text.includes(normalize(fragment)))))
  const returnedRelationships = new Set(result.hits.flatMap(hit => hit.relationship ? [hit.relationship.id] : []))
  const citationResolutions = result.hits.map(hit => Boolean(resolveCorpusCitation(index, hit.citation)))
  return {
    taskId,
    question,
    requiredDocumentIds: requiredDocuments,
    returnedDocumentIds: [...returnedDocuments],
    documentRecall: requiredDocuments.filter(id => returnedDocuments.has(id)).length / Math.max(1, requiredDocuments.length),
    evidenceRecall: evidenceHits.filter(Boolean).length / Math.max(1, evidenceHits.length),
    requiredRelationshipCount: requiredRelationships.length,
    relationshipRecall: requiredRelationships.length
      ? requiredRelationships.filter(id => returnedRelationships.has(id)).length / requiredRelationships.length
      : 1,
    citationResolutionRate: citationResolutions.filter(Boolean).length / Math.max(1, citationResolutions.length),
    payloadCharacters: JSON.stringify(result.hits).length,
    queryElapsedMs: result.elapsedMs,
    hits: result.hits,
  }
}

function stableSearch(index: CorpusIndex, question: string): Omit<CorpusSearchResult, 'elapsedMs'> {
  const { elapsedMs: _elapsedMs, ...stable } = searchCorpus(index, question, { limit: 12, maximumPerDocument: 4 })
  return stable
}

function scaledProbe(index: CorpusIndex, multiplier: number) {
  const documents = Array.from({ length: multiplier }, (_, copy) => index.documents.map(document => ({ ...document, id: `${document.id}-copy-${copy + 1}`, current: copy === 0 }))).flat()
  const units = Array.from({ length: multiplier }, (_, copy) => index.units.map(unit => ({
    ...unit,
    id: `${unit.id}:copy-${copy + 1}`,
    corpusDocumentId: `${unit.corpusDocumentId}-copy-${copy + 1}`,
    current: copy === 0,
  }))).flat()
  const scaledIndex: CorpusIndex = { ...index, documents, units }
  const questions = [...fixture.discoveryTasks.map(task => task.question), ...fixture.crossDocumentTasks.map(task => task.question)]
  const started = performance.now()
  const elapsed = questions.map(question => searchCorpus(scaledIndex, question, { limit: 12, maximumPerDocument: 4 }).elapsedMs)
  const wallMs = Number((performance.now() - started).toFixed(3))
  return {
    arm: index.arm,
    logicalDocuments: documents.length,
    logicalEvidenceUnits: units.length,
    currentDocuments: documents.filter(document => document.current).length,
    queries: questions.length,
    wallMs,
    medianQueryMs: percentile(elapsed, 0.5),
    p95QueryMs: percentile(elapsed, 0.95),
    note: `${multiplier - 1} archived logical copies per real document test current-release filtering and scan cost; they do not add content diversity.`,
  }
}

function typedRelationshipGate(): { passed: boolean; checked: number } {
  let checked = 0
  const passed = [indexes.anx, indexes.markdown].every(index => fixture.relationships.every(relationship => {
    checked += 1
    const outbound = traverseCorpusRelationships(index, { documentId: relationship.sourceDocumentId, direction: 'outbound', types: [relationship.type] })
    const inbound = traverseCorpusRelationships(index, { documentId: relationship.targetDocumentId, direction: 'inbound', types: [relationship.type] })
    return outbound.some(item => item.id === relationship.id) && inbound.some(item => item.id === relationship.id)
  }))
  return { passed, checked: fixture.relationships.length }
}

async function packageHashes(): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const document of manifest.documents) {
    const stem = document.fileName.replace(/\.(pdf|docx)$/iu, '')
    result[document.id] = sha256(await readFile(path.join(packagesDirectory, `${stem}.anx`)))
  }
  return result
}

function gate(id: string, passed: boolean, detail: string) { return { id, passed, detail } }
function sha256(value: string | Uint8Array) { return createHash('sha256').update(value).digest('hex') }
function normalize(value: string) { return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}.]+/gu, ' ').replace(/\s+/gu, ' ').trim() }
function average(values: number[]) { return values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(6)) : 1 }
function percentile(values: number[], p: number) { const sorted = [...values].sort((a, b) => a - b); return Number((sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))] || 0).toFixed(3)) }

function markdownReport(result: any): string {
  const rows = result.aggregates.map((row: any) => `| ${row.arm} | ${(row.discoveryDocumentRecallAt12 * 100).toFixed(1)}% | ${(row.discoveryEvidenceRecallAt12 * 100).toFixed(1)}% | ${(row.crossDocumentRecallAt12 * 100).toFixed(1)}% | ${(row.crossDocumentEvidenceRecallAt12 * 100).toFixed(1)}% | ${(row.relationshipTaskRecallAt12 * 100).toFixed(1)}% | ${(row.citationResolutionRate * 100).toFixed(1)}% | ${row.medianQueryMs.toFixed(3)} | ${Math.round(row.meanPayloadCharacters)} |`).join('\n')
  const scaledRows = result.scaled.map((row: any) => `- ${row.arm}: ${row.logicalDocuments} logical documents, ${row.logicalEvidenceUnits} evidence units, ${row.queries} queries, median ${row.medianQueryMs.toFixed(3)} ms, p95 ${row.p95QueryMs.toFixed(3)} ms.`).join('\n')
  const gateRows = result.gates.map((item: any) => `- ${item.passed ? 'PASS' : 'FAIL'} — ${item.id}: ${item.detail}`).join('\n')
  return `# ANX versus strong Markdown corpus qualification (${result.benchmarkId})\n\nStatus: **${result.status}** (${result.gates.filter((item: any) => item.passed).length}/${result.gates.length} gates)\n\nGenerated: ${result.generatedAt}\n\n## Result\n\n| Arm | Discovery document recall@12 | Discovery evidence recall@12 | Cross-document recall@12 | Cross-document evidence recall@12 | Relationship recall@12 | Citation resolution | Median query ms | Mean payload characters |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n${rows}\n\nThis stage qualifies the comparison machinery; it does not declare a winner. Both arms use the same canonical text and lexical ranker. The Markdown arm includes metadata, declared relationships, and resolvable file/line citations, making it a strong baseline rather than a strawman.\n\n## Scale probe\n\n${scaledRows}\n\nArchived copies test current-release filtering and scan cost only; they do not add content diversity.\n\n## Gates\n\n${gateRows}\n\n## Claim boundary\n\n${result.claimBoundary}\n`
}
