#!/usr/bin/env node
// Adjudication: pools the named live runs, groups trials by requested model and arm,
// applies any declared task exclusion, and writes the confirmation record that the
// benchmark README quotes. It reports what was observed; it does not pick a winner.
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

interface Trial {
  id: string
  taskId: string
  arm: 'anx' | 'markdown'
  status: string
  usage: Record<string, number>
  process: { wallTimeMs: number }
  score: Record<string, number | boolean>
  parsed: { answer: string; citations: string[] } | null
}

interface Run {
  runLabel: string
  provider: string
  requestedModel: string
  status: string
  generatedAt: string
  trials: Trial[]
}

const root = import.meta.dirname
const runLabels = (argument('--runs') || '').split(',').map(value => value.trim()).filter(Boolean)
const excludedTasks = (argument('--exclude-task') || '').split(',').map(value => value.trim()).filter(Boolean)
const exclusionReason = argument('--exclusion-reason') || ''
if (!runLabels.length) throw new Error('--runs <label,label,...> is required')
if (excludedTasks.length && !exclusionReason) throw new Error('--exclusion-reason is required when tasks are excluded')

const runs = await Promise.all(runLabels.map(load))
const deterministic = JSON.parse(await readFile(path.join(root, 'results/qualification.json'), 'utf8')) as Record<string, any>
const fixture = JSON.parse(await readFile(path.join(root, 'tasks.json'), 'utf8')) as { benchmarkId: string; discoveryTasks: unknown[]; crossDocumentTasks: Array<{ id: string }>; relationships: unknown[] }

const models = [...new Set(runs.map(run => run.requestedModel))]
const aggregates = models.flatMap(model => (['anx', 'markdown'] as const).map(arm => {
  const modelRuns = runs.filter(run => run.requestedModel === model)
  const trials = modelRuns.flatMap(run => run.trials.filter(trial => trial.arm === arm && !excludedTasks.includes(trial.taskId)))
  return aggregate(model, modelRuns.map(run => run.provider)[0] || 'unknown', arm, trials, modelRuns.length)
}))

const excluded = runs.flatMap(run => run.trials.filter(trial => excludedTasks.includes(trial.taskId)).map(trial => ({
  run: run.runLabel,
  model: run.requestedModel,
  arm: trial.arm,
  taskId: trial.taskId,
  answer: trial.parsed?.answer || null,
  taskSuccess: trial.score.taskSuccess === true,
  reason: exclusionReason,
})))

const perModel = models.map(model => {
  const anx = aggregates.find(row => row.model === model && row.arm === 'anx')!
  const markdown = aggregates.find(row => row.model === model && row.arm === 'markdown')!
  return { model, anxSuccesses: anx.taskSuccesses, markdownSuccesses: markdown.taskSuccesses, trialsPerArm: anx.trials, difference: anx.taskSuccesses - markdown.taskSuccesses }
})
const parityObserved = perModel.every(row => Math.abs(row.difference) <= 1)

const result = {
  schema: 'anx.corpus-comparative-confirmation.v1',
  generatedAt: new Date().toISOString(),
  benchmarkId: fixture.benchmarkId,
  // PASS means the deterministic stage passed and every run produced a record for every
  // planned trial. A model that exceeded its iteration budget is an observed result and is
  // reported as a protocol failure, not as a benchmark failure.
  status: deterministic.status === 'PASS' && runs.every(run => run.trials.length === fixture.crossDocumentTasks.length * 2 && run.trials.every(trial => trial.parsed !== null)) ? 'PASS' : 'HOLD',
  observation: parityObserved ? 'parity-observed' : 'difference-observed',
  corpus: {
    realDocuments: deterministic.inputs?.publicDocuments ?? null,
    discoveryTasks: fixture.discoveryTasks.length,
    crossDocumentTasks: fixture.crossDocumentTasks.length,
    adjudicatedCrossDocumentTasks: fixture.crossDocumentTasks.length - excludedTasks.length,
    logicalScaleProbeDocuments: deterministic.scaled?.[0]?.logicalDocuments ?? null,
  },
  deterministic: {
    status: deterministic.status,
    gates: `${(deterministic.gates || []).filter((gate: any) => gate.passed).length}/${(deterministic.gates || []).length}`,
    aggregates: deterministic.aggregates,
  },
  runs: runs.map(run => ({ runLabel: run.runLabel, provider: run.provider, requestedModel: run.requestedModel, status: run.status, generatedAt: run.generatedAt, trials: run.trials.length, completed: run.trials.filter(trial => trial.status === 'completed').length })),
  aggregates,
  perModel,
  excludedTasks: excluded,
  claimBoundary: `This confirmation pools ${runs.length} live run(s) over ${fixture.crossDocumentTasks.length - excludedTasks.length} adjudicated cross-document tasks with ${deterministic.inputs?.publicDocuments ?? 'the'} public documents. It does not establish enterprise-scale performance, universal format parity, production latency, cost, security, or market demand.`,
}

await writeFile(path.join(root, 'results/confirmation.json'), `${JSON.stringify(result, null, 2)}\n`)
await writeFile(path.join(root, 'results/confirmation.md'), markdown(result))
process.stdout.write(`${JSON.stringify({ status: result.status, observation: result.observation, perModel }, null, 2)}\n`)

async function load(runLabel: string): Promise<Run> {
  const value = JSON.parse(await readFile(path.join(root, 'results/live', runLabel, 'results.json'), 'utf8')) as Run
  return { ...value, runLabel }
}

function aggregate(model: string, provider: string, arm: 'anx' | 'markdown', trials: Trial[], repetitions: number) {
  const completed = trials.filter(trial => trial.status === 'completed')
  const scores = trials.map(trial => trial.score)
  return {
    model,
    provider,
    arm,
    repetitions,
    trials: trials.length,
    completed: completed.length,
    taskSuccesses: trials.filter(trial => trial.status === 'completed' && trial.score.taskSuccess === true).length,
    taskSuccessRate: average(trials.map(trial => trial.status === 'completed' && trial.score.taskSuccess === true ? 1 : 0)),
    correctAnswers: scores.filter(score => score.answerCorrect === true).length,
    protocolFailures: trials.filter(trial => trial.status !== 'completed').length,
    answerConceptRecall: average(scores.map(score => numeric(score.answerConceptRecall))),
    citationResolutionRate: average(scores.map(score => numeric(score.citationResolutionRate))),
    documentCitationCoverage: average(scores.map(score => numeric(score.documentCitationCoverage))),
    citationPrecision: average(scores.map(score => numeric(score.citationPrecision))),
    medianUncachedInputTokens: percentile(trials.map(trial => numeric(trial.usage?.input_tokens)), 0.5),
    medianTotalTokens: percentile(trials.map(trial => numeric(trial.usage?.total_tokens)), 0.5),
    medianToolCalls: percentile(trials.map(trial => numeric(trial.usage?.tool_calls)), 0.5),
    medianSeconds: Number((percentile(trials.map(trial => numeric(trial.process?.wallTimeMs)), 0.5) / 1000).toFixed(2)),
  }
}

function markdown(value: typeof result): string {
  const rows = value.aggregates.map(row => `| ${row.model} | ${row.arm} | ${row.taskSuccesses}/${row.trials} | ${row.correctAnswers}/${row.trials} | ${row.protocolFailures} | ${(row.answerConceptRecall * 100).toFixed(1)}% | ${(row.citationResolutionRate * 100).toFixed(1)}% | ${(row.documentCitationCoverage * 100).toFixed(1)}% | ${(row.citationPrecision * 100).toFixed(1)}% | ${row.medianUncachedInputTokens} | ${row.medianTotalTokens} | ${row.medianToolCalls} | ${row.medianSeconds} |`).join('\n')
  const runRows = value.runs.map(run => `- ${run.runLabel}: ${run.provider} / ${run.requestedModel}, ${run.completed}/${run.trials} trials completed within protocol, run status ${run.status}, ${run.generatedAt}.`).join('\n')
  const exclusion = value.excludedTasks.length
    ? `\n## Excluded task rows\n\n${[...new Set(value.excludedTasks.map(item => item.taskId))].map(id => `- ${id}: ${value.excludedTasks.find(item => item.taskId === id)?.reason}`).join('\n')}\n\nExcluded rows stay in the JSON record with their answers.\n`
    : ''
  return `# ANX versus strong Markdown corpus confirmation (${value.benchmarkId})\n\nStatus: **${value.status}**  \nObservation: **${value.observation}**\n\n## Adjudicated live result\n\n| Model | Arm | Task success | Correct answers | Protocol failures | Concept recall | Citation resolution | Required-document citation coverage | Citation precision | Median uncached input | Median total tokens | Median tool calls | Median seconds |\n|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n${rows}\n\nTask success requires a completed trial within the eight-iteration protocol, every required answer concept, every citation resolving, and a citation from every required document (and relationship, where one is required). Correct answers counts trials whose answer contained every required concept regardless of protocol; protocol failures are trials that exceeded the iteration limit, ran a disallowed command, or returned no parseable answer.\n\n## Runs\n\n${runRows}\n${exclusion}\n## Deterministic qualification\n\nStatus ${value.deterministic.status} (${value.deterministic.gates} gates). Both arms search the same canonical text with the same lexical ranker; see results/qualification.md.\n\n## Claim boundary\n\n${value.claimBoundary}\n`
}

function argument(name: string): string | null { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] || null : null }
function numeric(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? value : 0 }
function average(values: number[]): number { return values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(6)) : 0 }
function percentile(values: number[], p: number): number { const sorted = [...values].sort((a, b) => a - b); return Number((sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))] || 0).toFixed(3)) }
