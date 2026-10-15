#!/usr/bin/env node
// Live stage: a fresh, vanilla CLI model session per trial answers each cross-document
// task through identical deterministic corpus operations for the ANX arm and the
// strong-Markdown arm. The model never sees the corpus files, only tool output.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  hydrateCorpusIndex,
  resolveCorpusCitation,
  type CorpusIndex,
  type CorpusRelationshipFixture,
  type SerializedCorpusIndex,
} from './corpus-engine.js'

type Provider = 'codex' | 'claude'
type Arm = 'anx' | 'markdown'

interface Task {
  id: string
  family: string
  question: string
  requiredDocumentIds: string[]
  requiredRelationshipIds?: string[]
  requiredAnswerConcepts: string[][]
  evidenceFragmentGroups: string[][]
}

interface Fixture {
  benchmarkId: string
  crossDocumentTasks: Task[]
  relationships: CorpusRelationshipFixture[]
}

interface ParsedAnswer {
  answer: string
  citations: string[]
  confidence: number | null
}

interface ProcessResult {
  code: number
  stdout: string
  stderr: string
  wallTimeMs: number
}

interface InvocationResult extends ProcessResult {
  response: string
  events: unknown[]
  toolCommands: string[]
  actualModels: string[]
  usage: Record<string, unknown>
}

const root = import.meta.dirname
const provider = argument('--provider') as Provider | null
const model = argument('--model')
const runLabel = argument('--run-label')
const confirmation = process.argv.includes('--confirm-live')
const concurrency = integerArgument('--concurrency', 2, 1, 4)
const apiCallLimit = 8
const expectedDocuments = 12
const agentRoot = path.join(os.tmpdir(), 'anx-markdown-corpus-parity-agent')
const launcherName = 'corpus-tool.mjs'
const toolPath = path.join(root, 'corpus-tool-cli.ts')
const tsxLoaderPath = path.resolve(root, '../../node_modules/tsx/dist/loader.mjs')
const schemaPath = path.join(root, 'answer.schema.json')
const runtimeRoot = path.join(root, 'runtime')
const resultsRoot = runLabel ? path.join(root, 'results/live', runLabel) : ''
const trialsRoot = resultsRoot ? path.join(resultsRoot, 'trials') : ''

if (provider !== 'codex' && provider !== 'claude') throw new Error('--provider must be codex or claude')
if (!model) throw new Error('--model is required')
if (!runLabel || !/^[a-z0-9][a-z0-9-]{0,63}$/iu.test(runLabel)) throw new Error('A valid --run-label is required')
if (!confirmation) throw new Error('Live external-model execution requires --confirm-live')

await mkdir(agentRoot, { recursive: true })
await mkdir(trialsRoot, { recursive: true })
await writeLauncher()

const fixture = JSON.parse(await readFile(path.join(root, 'tasks.json'), 'utf8')) as Fixture
const indexes = {
  anx: await loadIndex('anx'),
  markdown: await loadIndex('markdown'),
}
const qualification = JSON.parse(await readFile(path.join(root, 'results/qualification.json'), 'utf8')) as { status?: string; gates?: Array<{ passed?: boolean }> }
const preflight = await runPreflight()
await writeFile(path.join(resultsRoot, 'preflight.json'), `${JSON.stringify(preflight, null, 2)}\n`)
if (!preflight.ready) throw new Error(`live stage blocked: ${preflight.blocking.join(', ')}`)

const plan = fixture.crossDocumentTasks.flatMap(task => (['anx', 'markdown'] as Arm[]).map(arm => ({
  id: `${task.id}__${arm}`,
  taskId: task.id,
  arm,
})))
await writeFile(path.join(resultsRoot, 'plan.json'), `${JSON.stringify({
  schema: 'anx.corpus-live-plan.v1',
  generatedAt: new Date().toISOString(),
  provider,
  requestedModel: model,
  freshSessionPerTrial: true,
  repetitions: 1,
  tasks: fixture.crossDocumentTasks.length,
  trials: plan,
}, null, 2)}\n`)

const rows: unknown[] = []
for (let offset = 0; offset < plan.length; offset += concurrency) {
  const batch = plan.slice(offset, offset + concurrency)
  const completed = await Promise.all(batch.map(async item => {
    const task = fixture.crossDocumentTasks.find(candidate => candidate.id === item.taskId)
    if (!task) throw new Error(`Missing task ${item.taskId}`)
    return runTrial(item, task)
  }))
  rows.push(...completed)
  await writeResults(rows)
  for (const row of completed as Array<Record<string, unknown>>) {
    process.stdout.write(`${JSON.stringify({ completed: rows.length, total: plan.length, trial: row.id, status: row.status, taskSuccess: (row.score as Record<string, unknown>)?.taskSuccess })}\n`)
  }
}

const final = await writeResults(rows)
await writeFile(path.join(resultsRoot, 'summary.md'), markdownSummary(final))
process.stdout.write(`${JSON.stringify({ status: final.status, runLabel, aggregates: final.aggregates }, null, 2)}\n`)
if (final.status !== 'PASS') process.exitCode = 1

async function writeLauncher() {
  // The launcher lives in a clean working directory outside the repository so the
  // prompt, the audited commands and the stored transcripts never contain local
  // paths. It forwards to the TypeScript corpus tool with the repository's tsx loader.
  const source = [
    '// Generated by run-live-smoke.ts for one benchmark session. Not part of the repository.',
    "import { spawnSync } from 'node:child_process'",
    `const result = spawnSync(process.execPath, ['--import', ${JSON.stringify(tsxLoaderPath)}, ${JSON.stringify(toolPath)}, ...process.argv.slice(2)], { stdio: 'inherit' })`,
    'process.exit(result.status === null ? 1 : result.status)',
    '',
  ].join('\n')
  await writeFile(path.join(agentRoot, launcherName), source)
}

async function loadIndex(arm: Arm): Promise<CorpusIndex> {
  const name = arm === 'anx' ? 'anx-index.json' : 'markdown-index.json'
  return hydrateCorpusIndex(JSON.parse(await readFile(path.join(runtimeRoot, name), 'utf8')) as SerializedCorpusIndex)
}

async function runPreflight() {
  const cli = await runProcess(provider === 'codex' ? 'codex' : 'claude', ['--version'], 60_000)
  const auth = provider === 'codex'
    ? await runProcess('codex', ['login', 'status'], 60_000)
    : await runProcess('claude', ['auth', 'status', '--json'], 60_000)
  let authenticated = auth.code === 0
  if (provider === 'claude') {
    try { authenticated = authenticated && Boolean((JSON.parse(auth.stdout) as Record<string, unknown>).loggedIn) } catch { authenticated = false }
  }
  const dryRuns = await Promise.all((['anx', 'markdown'] as Arm[]).map(arm => runProcess('node', [launcherName, arm, 'search', 'annual waiver approved denied', '2'], 60_000)))
  const checks = {
    qualification: { ok: qualification.status === 'PASS' && qualification.gates?.every(item => item.passed), detail: `${qualification.status || 'missing'} ${qualification.gates?.filter(item => item.passed).length || 0}/${qualification.gates?.length || 0}` },
    cli: { ok: cli.code === 0, detail: cli.stdout.trim() || cli.stderr.trim() },
    authentication: { ok: authenticated, detail: authenticated ? 'authenticated' : 'not authenticated' },
    indexes: { ok: indexes.anx.documents.length === expectedDocuments && indexes.markdown.documents.length === expectedDocuments, detail: `${indexes.anx.documents.length}/${indexes.markdown.documents.length} documents` },
    toolDryRuns: { ok: dryRuns.every(result => result.code === 0), detail: dryRuns.map(result => result.code).join('/') },
    schema: { ok: await exists(schemaPath), detail: 'answer.schema.json' },
  }
  const blocking = Object.entries(checks).filter(([, value]) => !value.ok).map(([key]) => key)
  return {
    schema: 'anx.corpus-live-preflight.v1',
    generatedAt: new Date().toISOString(),
    ready: blocking.length === 0,
    blocking,
    executionBoundary: {
      provider,
      requestedModel: model,
      cliVersion: cli.stdout.trim(),
      noHarness: true,
      noMemory: true,
      freshSessionPerTrial: true,
      shellRestrictedToCorpusTool: true,
      corpusToolSha256: sha256(await readFile(toolPath)),
      corpusEngineSha256: sha256(await readFile(path.join(root, 'corpus-engine.ts'))),
    },
    checks,
  }
}

async function runTrial(planItem: { id: string; taskId: string; arm: Arm }, task: Task) {
  const responsePath = path.join(trialsRoot, `${planItem.id}.response.json`)
  const eventsPath = path.join(trialsRoot, `${planItem.id}.events.jsonl`)
  const promptPath = path.join(trialsRoot, `${planItem.id}.prompt.md`)
  const prompt = buildPrompt(planItem.arm, task)
  await writeFile(promptPath, prompt)
  const invocation = provider === 'codex'
    ? await invokeCodex(prompt, responsePath)
    : await invokeClaude(prompt)
  await writeFile(responsePath, redact(invocation.response))
  await writeFile(eventsPath, redact(invocation.stdout))
  const parsed = parseAnswer(invocation.response)
  const score = scoreAnswer(parsed, task, indexes[planItem.arm])
  const commandAudit = auditCommands(invocation.toolCommands, planItem.arm)
  const observedCalls = numeric(invocation.usage.api_calls)
  const status = invocation.code === 0 && parsed && commandAudit.passed && observedCalls <= apiCallLimit ? 'completed' : 'failed'
  return {
    ...planItem,
    status,
    provider,
    requestedModel: model,
    actualModels: invocation.actualModels,
    process: { code: invocation.code, wallTimeMs: invocation.wallTimeMs, stderr: redact(invocation.stderr).slice(0, 2000) },
    usage: invocation.usage,
    toolCommands: invocation.toolCommands.map(redact),
    protocol: {
      noHarness: true,
      noMemory: true,
      freshSession: true,
      apiCallLimit,
      apiCallLimitObserved: observedCalls,
      apiCallLimitMet: observedCalls <= apiCallLimit,
      commandAudit,
    },
    parsed,
    score,
    artifacts: {
      promptPath: path.relative(root, promptPath),
      responsePath: path.relative(root, responsePath),
      eventsPath: path.relative(root, eventsPath),
    },
  }
}

function buildPrompt(arm: Arm, task: Task): string {
  const prefix = `node ${launcherName} ${arm}`
  return [
    'You are a fresh, vanilla command-line model in a controlled corpus question-answering trial.',
    'You have no project harness, memory, prior session, target file path, or web access.',
    `Use no more than ${apiCallLimit} total model/tool iterations. Bash is transport only for the corpus operations below.`,
    `Question: ${task.question}`,
    '',
    'Allowed commands (substitute only the quoted placeholder values; run no other command):',
    `${prefix} search '<query>' 12`,
    `${prefix} search-document '<documentId>' '<query>' 12`,
    `${prefix} get '<citation>'`,
    `${prefix} relationships '<documentId>' both`,
    `${prefix} documents`,
    '',
    'Start with a search using the user question. Refine the search if the first evidence is incomplete.',
    'After discovering a relevant document ID, prefer search-document over repeated broad corpus searches.',
    'Use relationships when the question asks about document lineage, editions, governance, or supersession.',
    'Answer only from returned corpus evidence. Include every relevant comparison value and do not infer missing values.',
    'Cite only exact citation strings returned by search or get. Cite evidence from every document used in the answer.',
    'Relationship assertions must be supported by a returned relationship citation.',
    'Return only the JSON object required by the supplied schema; do not use Markdown.',
  ].join('\n')
}

async function invokeCodex(prompt: string, responsePath: string): Promise<InvocationResult> {
  const result = await runProcess('codex', [
    'exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
    '--sandbox', 'read-only', '--cd', agentRoot, '--model', model!,
    '--output-schema', schemaPath, '--json', '--output-last-message', responsePath,
    '--color', 'never', prompt,
  ], 900_000)
  const events = parseJsonLines(result.stdout)
  const response = await readFile(responsePath, 'utf8').catch(() => '')
  const toolCommands = completedCommands(events, 'codex')
  return { ...result, response, events, toolCommands, actualModels: modelNames(events), usage: normalizedUsage(events, 'codex', toolCommands) }
}

async function invokeClaude(prompt: string): Promise<InvocationResult> {
  const schema = JSON.parse(await readFile(schemaPath, 'utf8'))
  const allowed = `Bash(node ${launcherName} *)`
  const result = await runProcess('claude', [
    '-p', prompt, '--safe-mode', '--no-session-persistence', '--model', model!,
    '--tools', 'Bash', '--permission-mode', 'dontAsk', '--output-format', 'stream-json',
    '--verbose', '--json-schema', JSON.stringify(schema), '--allowedTools', allowed,
  ], 900_000)
  const events = parseJsonLines(result.stdout)
  const resultEvents = events.filter(event => isObject(event) && event.type === 'result') as Array<Record<string, unknown>>
  const final = resultEvents.at(-1) || {}
  const response = isObject(final.structured_output) ? JSON.stringify(final.structured_output) : typeof final.result === 'string' ? final.result : ''
  const toolCommands = completedCommands(events, 'claude')
  return { ...result, response, events, toolCommands, actualModels: modelNames(events), usage: normalizedUsage(events, 'claude', toolCommands) }
}

function parseAnswer(value: string): ParsedAnswer | null {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '')
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>
    return {
      answer: typeof parsed.answer === 'string' ? parsed.answer : '',
      citations: Array.isArray(parsed.citations) ? [...new Set(parsed.citations.filter((item): item is string => typeof item === 'string'))] : [],
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : null,
    }
  } catch { return null }
}

function scoreAnswer(parsed: ParsedAnswer | null, task: Task, index: CorpusIndex) {
  if (!parsed) return emptyScore(false)
  const answer = normalize(parsed.answer)
  const conceptHits = task.requiredAnswerConcepts.map(group => group.some(value => matchesAlternative(answer, value)))
  const resolved = parsed.citations.map(citation => ({ citation, unit: resolveCorpusCitation(index, citation) }))
  const resolvedUnits = resolved.flatMap(item => item.unit ? [item.unit] : [])
  const citedDocuments = new Set(resolvedUnits.map(unit => unit.corpusDocumentId))
  const requiredDocuments = new Set(task.requiredDocumentIds)
  const relationshipIds = new Set(resolvedUnits.flatMap(unit => unit.relationship ? [unit.relationship.id] : []))
  const evidenceGroups = task.evidenceFragmentGroups.map(group => group.map(normalize))
  const citationSupports = resolved.map(item => {
    if (!item.unit || !requiredDocuments.has(item.unit.corpusDocumentId)) return false
    const text = normalize(item.unit.text)
    return Boolean(item.unit.relationship && task.requiredRelationshipIds?.includes(item.unit.relationship.id))
      || evidenceGroups.some(group => group.some(fragment => text.includes(fragment)))
  })
  const evidenceCoverage = evidenceGroups.map(group => resolvedUnits.some(unit => group.some(fragment => normalize(unit.text).includes(fragment))))
  const documentCitationCoverage = task.requiredDocumentIds.filter(id => citedDocuments.has(id)).length / Math.max(1, task.requiredDocumentIds.length)
  const relationshipCitationCoverage = (task.requiredRelationshipIds || []).length
    ? (task.requiredRelationshipIds || []).filter(id => relationshipIds.has(id)).length / (task.requiredRelationshipIds || []).length
    : 1
  const answerConceptRecall = conceptHits.filter(Boolean).length / Math.max(1, conceptHits.length)
  const citationPrecision = citationSupports.filter(Boolean).length / Math.max(1, parsed.citations.length)
  const citationResolutionRate = resolvedUnits.length / Math.max(1, parsed.citations.length)
  const evidenceCitationCoverage = evidenceCoverage.filter(Boolean).length / Math.max(1, evidenceCoverage.length)
  return {
    parseOk: true,
    answerCorrect: conceptHits.every(Boolean),
    answerConceptRecall,
    citationResolutionRate,
    documentCitationCoverage,
    evidenceCitationCoverage,
    relationshipCitationCoverage,
    citationPrecision,
    citedDocuments: [...citedDocuments],
    taskSuccess: conceptHits.every(Boolean)
      && citationResolutionRate === 1
      && documentCitationCoverage === 1
      && relationshipCitationCoverage === 1,
  }
}

function emptyScore(parseOk: boolean) {
  return { parseOk, answerCorrect: false, answerConceptRecall: 0, citationResolutionRate: 0, documentCitationCoverage: 0, evidenceCitationCoverage: 0, relationshipCitationCoverage: 0, citationPrecision: 0, citedDocuments: [] as string[], taskSuccess: false }
}

async function writeResults(rows: unknown[]) {
  const typed = rows.filter(isObject)
  const aggregates = (['anx', 'markdown'] as Arm[]).map(arm => aggregate(arm, typed.filter(row => row.arm === arm)))
  const allCompleted = typed.length === plan.length && typed.every(row => row.status === 'completed')
  const result = {
    schema: 'anx.corpus-live-results.v1',
    generatedAt: new Date().toISOString(),
    benchmarkId: fixture.benchmarkId,
    stage: 'live-answer-smoke',
    runLabel,
    status: allCompleted ? 'PASS' : 'HOLD',
    provider,
    requestedModel: model,
    repetitions: 1,
    aggregates,
    trials: rows,
    claimBoundary: 'One live repetition over six cross-document tasks compares agent behavior through equivalent deterministic corpus tools. It is a smoke test, not an enterprise-scale effect estimate or a universal ANX-versus-Markdown result.',
  }
  await writeFile(path.join(resultsRoot, 'results.json'), `${JSON.stringify(result, null, 2)}\n`)
  return result
}

function aggregate(arm: Arm, rows: Array<Record<string, unknown>>) {
  const scores = rows.map(row => row.score).filter(isObject)
  const usages = rows.map(row => row.usage).filter(isObject)
  const processes = rows.map(row => row.process).filter(isObject)
  return {
    arm,
    trials: rows.length,
    completed: rows.filter(row => row.status === 'completed').length,
    taskSuccessRate: average(scores.map(score => booleanNumber(score.taskSuccess))),
    answerAccuracy: average(scores.map(score => booleanNumber(score.answerCorrect))),
    answerConceptRecall: average(scores.map(score => numeric(score.answerConceptRecall))),
    citationResolutionRate: average(scores.map(score => numeric(score.citationResolutionRate))),
    documentCitationCoverage: average(scores.map(score => numeric(score.documentCitationCoverage))),
    evidenceCitationCoverage: average(scores.map(score => numeric(score.evidenceCitationCoverage))),
    relationshipCitationCoverage: average(scores.map(score => numeric(score.relationshipCitationCoverage))),
    citationPrecision: average(scores.map(score => numeric(score.citationPrecision))),
    medianUncachedInputTokens: percentile(usages.map(usage => numeric(usage.input_tokens)), 0.5),
    medianTotalTokens: percentile(usages.map(usage => numeric(usage.total_tokens)), 0.5),
    medianToolCalls: percentile(usages.map(usage => numeric(usage.tool_calls)), 0.5),
    medianWallTimeMs: percentile(processes.map(process => numeric(process.wallTimeMs)), 0.5),
  }
}

function markdownSummary(result: Awaited<ReturnType<typeof writeResults>>): string {
  const rows = result.aggregates.map(row => `| ${row.arm} | ${row.completed}/${row.trials} | ${(row.taskSuccessRate * 100).toFixed(1)}% | ${(row.answerConceptRecall * 100).toFixed(1)}% | ${(row.documentCitationCoverage * 100).toFixed(1)}% | ${(row.citationPrecision * 100).toFixed(1)}% | ${row.medianUncachedInputTokens} | ${row.medianTotalTokens} | ${row.medianToolCalls} | ${(row.medianWallTimeMs / 1000).toFixed(2)} |`).join('\n')
  return `# ANX versus strong Markdown live corpus smoke (${result.benchmarkId})\n\nStatus: **${result.status}**\n\nProvider/model: ${result.provider} / ${result.requestedModel}\n\n| Arm | Completed | Task success | Answer concept recall | Document citation coverage | Citation precision | Median uncached input tokens | Median total tokens | Median tool calls | Median seconds |\n|---|---|---:|---:|---:|---:|---:|---:|---:|---:|\n${rows}\n\n${result.claimBoundary}\n`
}

function auditCommands(commands: string[], arm: Arm) {
  const allowed = new RegExp(`node ${launcherName.replace('.', '\\.')} ${arm} (?:search|search-document|get|relationships|documents)(?:\\s|$)`, 'u')
  const forbidden = /(?:^|\s)(?:cat|sed|awk|grep|rg|find|ls|head|tail|python|python3|curl|wget|git|env|printenv|open|cp|mv|rm)(?:\s|$)/iu
  const badControl = /(?:&&|;|\|\||\||>|<|`|\$\()/u
  const violations = commands.filter(command => !allowed.test(command) || forbidden.test(command) || badControl.test(command))
  return { passed: violations.length === 0, commands: commands.length, violations: violations.map(redact) }
}

function completedCommands(events: unknown[], selectedProvider: Provider): string[] {
  const commands: string[] = []
  for (const event of events) {
    if (!isObject(event)) continue
    if (selectedProvider === 'codex' && event.type === 'item.completed' && isObject(event.item) && event.item.type === 'command_execution') {
      if (typeof event.item.command === 'string') commands.push(event.item.command)
      else if (Array.isArray(event.item.command)) commands.push(event.item.command.filter(item => typeof item === 'string').join(' '))
    }
    if (selectedProvider === 'claude' && event.type === 'assistant' && isObject(event.message) && Array.isArray(event.message.content)) {
      for (const block of event.message.content) {
        if (isObject(block) && block.type === 'tool_use' && block.name === 'Bash' && isObject(block.input) && typeof block.input.command === 'string') commands.push(block.input.command)
      }
    }
  }
  return commands
}

function normalizedUsage(events: unknown[], selectedProvider: Provider, commands: string[]) {
  if (selectedProvider === 'codex') {
    const completed = events.filter(event => isObject(event) && event.type === 'turn.completed') as Array<Record<string, unknown>>
    const usage = isObject(completed.at(-1)?.usage) ? completed.at(-1)!.usage as Record<string, unknown> : {}
    const reportedInput = numeric(usage.input_tokens)
    const cached = numeric(usage.cached_input_tokens || usage.cache_read_input_tokens)
    const output = numeric(usage.output_tokens)
    return { input_tokens: Math.max(0, reportedInput - cached), reported_input_tokens: reportedInput, cache_read_tokens: cached, output_tokens: output, total_tokens: reportedInput + output, tool_calls: commands.length, api_calls: commands.length + 1 }
  }
  const results = events.filter(event => isObject(event) && event.type === 'result') as Array<Record<string, unknown>>
  const final = results.at(-1) || {}
  const usage = isObject(final.usage) ? final.usage as Record<string, unknown> : {}
  const input = numeric(usage.input_tokens)
  const creation = numeric(usage.cache_creation_input_tokens)
  const read = numeric(usage.cache_read_input_tokens)
  const output = numeric(usage.output_tokens)
  return { input_tokens: input + creation, reported_input_tokens: input, cache_creation_tokens: creation, cache_read_tokens: read, output_tokens: output, total_tokens: input + creation + read + output, tool_calls: commands.length, api_calls: numeric(final.num_turns) || commands.length + 1 }
}

function modelNames(events: unknown[]): string[] {
  const result = new Set<string>()
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { value.forEach(visit); return }
    const object = value as Record<string, unknown>
    if (typeof object.model === 'string' && /(?:gpt|claude|opus|sonnet|haiku|fable)/iu.test(object.model)) result.add(object.model)
    Object.values(object).forEach(visit)
  }
  events.forEach(visit)
  return [...result]
}

function runProcess(command: string, args: string[], timeoutMs: number): Promise<ProcessResult> {
  const started = performance.now()
  return new Promise(resolve => {
    const child = execFile(command, args, { cwd: agentRoot, env: process.env, timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      const failure = error as (Error & { code?: number }) | null
      resolve({ code: failure ? (typeof failure.code === 'number' ? failure.code : 1) : 0, stdout: stdout || '', stderr: stderr || failure?.message || '', wallTimeMs: Number((performance.now() - started).toFixed(3)) })
    })
    child.stdin?.end()
  })
}

function redact(value: string): string {
  // Stored transcripts must not carry local directory names.
  const home = os.homedir()
  return value.split(agentRoot).join('<agent-root>').split(root).join('<benchmark-root>').split(home).join('<home>')
}

function parseJsonLines(value: string): unknown[] { return value.split('\n').flatMap(line => { try { return line.trim() ? [JSON.parse(line)] : [] } catch { return [] } }) }
function argument(name: string): string | null { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] || null : null }
function integerArgument(name: string, fallback: number, minimum: number, maximum: number): number { const parsed = Number.parseInt(argument(name) || `${fallback}`, 10); if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`); return parsed }
function normalize(value: string): string { return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}.]+/gu, ' ').replace(/\s+/gu, ' ').trim() }
function matchesAlternative(haystack: string, alternative: string): boolean {
  const needle = normalize(alternative)
  if (haystack.includes(needle)) return true
  const tokens = needle.split(' ').filter(Boolean)
  return tokens.length > 1 && tokens.every(token => haystack.split(' ').includes(token))
}
function numeric(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? value : 0 }
function booleanNumber(value: unknown): number { return value === true ? 1 : 0 }
function average(values: number[]): number { return values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(6)) : 0 }
function percentile(values: number[], p: number): number { const sorted = [...values].sort((a, b) => a - b); return Number((sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))] || 0).toFixed(3)) }
function isObject(value: unknown): value is Record<string, any> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) }
async function exists(filePath: string): Promise<boolean> { try { await access(filePath); return true } catch { return false } }
function sha256(value: Uint8Array): string { return createHash('sha256').update(value).digest('hex') }
