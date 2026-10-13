#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  andocApply,
  andocCite,
  andocContext,
  andocEditLocate,
  andocGet,
  andocGetBatch,
  andocInsertImage,
  andocOpen,
  andocOcrCandidates,
  andocOutline,
  renderSemanticDiffMarkdown,
  semanticDiff,
  andocPreview,
  andocQuery,
  andocRegions,
  andocReviewPropose,
  andocReviewStatus,
  andocSearch,
  andocTextQuality,
  anxPageEvidence,
  cosignAndoc,
  deriveAndocDraft,
  evaluateAnxReadConformance,
  finalizeAndoc,
  inspectAndocCapabilities,
  importDocumentToAndoc,
  importPdfToAndoc,
  exportAndocPdf,
  exportAnxDocx,
  exportAnxJsonl,
  exportAnxMarkdown,
  packAndoc,
  readAndoc,
  repackAndocPackage,
  renderHtml,
  setAndocProfiles,
  startStandaloneViewer,
  transactAndocPackage,
  unpackAndoc,
  validateAndoc,
  validateDocument,
  validateTransaction,
  verifyAndocFinalization,
  verifyAndocLineage,
  type AndocDocument,
  type AndocOperation,
  type AndocFinalizationPolicy,
  type AndocProfiles,
  type AndocTransaction,
  type AndocTrustStore,
  type AnxReadConformanceClass,
} from './index.js'

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)

  if (command === 'open') {
    const [inputPath] = args
    requireArgs(command, [inputPath])
    print(await andocOpen(inputPath!))
    return
  }

  if (command === 'query') {
    const [inputPath, query, limit, mode] = args
    requireArgs(command, [inputPath, query])
    print(await andocQuery(inputPath!, query!, {
      ...(limit ? { limit: Number.parseInt(limit, 10) } : {}),
      ...(mode === 'standard' ? { mode } : {}),
    }))
    return
  }

  if (command === 'edit-locate') {
    const [inputPath, query, limit] = args
    requireArgs(command, [inputPath, query])
    print(await andocEditLocate(inputPath!, query!, limit ? Number.parseInt(limit, 10) : undefined))
    return
  }

  if (command === 'batch') {
    const [inputPath, nodeIds, mode] = args
    requireArgs(command, [inputPath, nodeIds])
    print(await andocGetBatch(inputPath!, nodeIds!.split(','), { ...(mode === 'standard' ? { mode } : {}) }))
    return
  }

  if (command === 'context') {
    const [inputPath, nodeId, before, after, mode] = args
    requireArgs(command, [inputPath, nodeId])
    print(await andocContext(
      inputPath!,
      nodeId!,
      before ? Number.parseInt(before, 10) : undefined,
      after ? Number.parseInt(after, 10) : undefined,
      { ...(mode === 'standard' ? { mode } : {}) },
    ))
    return
  }

  if (command === 'outline') {
    const [inputPath, maximumBlocks] = args
    requireArgs(command, [inputPath])
    print(await andocOutline(inputPath!, maximumBlocks ? Number.parseInt(maximumBlocks, 10) : undefined))
    return
  }

  if (command === 'get') {
    const [inputPath, nodeId] = args
    requireArgs(command, [inputPath, nodeId])
    print(await andocGet(inputPath!, nodeId!))
    return
  }

  if (command === 'search') {
    const [inputPath, query, limit] = args
    requireArgs(command, [inputPath, query])
    print(await andocSearch(inputPath!, query!, limit ? Number.parseInt(limit, 10) : undefined))
    return
  }

  if (command === 'cite') {
    const [inputPath, nodeId] = args
    requireArgs(command, [inputPath, nodeId])
    print(await andocCite(inputPath!, nodeId!))
    return
  }

  if (command === 'text-quality') {
    const [inputPath, includeCleanValue] = args
    requireArgs(command, [inputPath])
    print(await andocTextQuality(inputPath!, includeCleanValue === 'all'))
    return
  }

  if (command === 'regions') {
    const [inputPath, pageValue, kindsValue, detailValue] = args
    requireArgs(command, [inputPath])
    const page = pageValue ? Number.parseInt(pageValue, 10) : undefined
    if (pageValue && (!Number.isInteger(page) || page! < 1 || String(page) !== pageValue)) throw new Error(`Invalid region page: ${pageValue}`)
    const kinds = kindsValue ? kindsValue.split(',').filter(Boolean) as Array<'table' | 'figure' | 'screenshot' | 'visualization' | 'simulation' | 'infographic' | 'roster' | 'logo' | 'qrCode' | 'chart' | 'map' | 'equation' | 'handwriting' | 'signature' | 'other'> : undefined
    if (detailValue && detailValue !== 'all-parts') throw new Error(`Invalid region detail mode: ${detailValue}`)
    print(await andocRegions(inputPath!, { ...(page ? { page } : {}), ...(kinds?.length ? { kinds } : {}), ...(detailValue === 'all-parts' ? { includeParts: true } : {}) }))
    return
  }

  if (command === 'page-evidence') {
    const [inputPath, pageValue, kindsValue, detailValue] = args
    requireArgs(command, [inputPath, pageValue])
    const page = Number.parseInt(pageValue!, 10)
    if (!Number.isInteger(page) || page < 1 || String(page) !== pageValue) throw new Error(`Invalid evidence page: ${pageValue}`)
    const kinds = kindsValue ? kindsValue.split(',').filter(Boolean) as Array<'table' | 'figure' | 'screenshot' | 'visualization' | 'simulation' | 'infographic' | 'roster' | 'logo' | 'qrCode' | 'chart' | 'map' | 'equation' | 'handwriting' | 'signature' | 'other'> : undefined
    if (detailValue && detailValue !== 'all-parts') throw new Error(`Invalid page-evidence detail mode: ${detailValue}`)
    print(await anxPageEvidence(inputPath!, page, {
      ...(kinds?.length ? { kinds } : {}),
      ...(detailValue === 'all-parts' ? { includeParts: true } : {}),
    }))
    return
  }

  if (command === 'diff') {
    const [fromPath, toPath, format] = args
    requireArgs(command, [fromPath, toPath])
    const fromPkg = await readAndoc(fromPath!)
    const toPkg = await readAndoc(toPath!)
    const diff = semanticDiff(fromPkg.document, toPkg.document)
    if (format === 'markdown') process.stdout.write(renderSemanticDiffMarkdown(diff))
    else print(diff)
    return
  }

  if (command === 'conformance') {
    const [inputPath, requestedValue] = args
    requireArgs(command, [inputPath])
    const requested = (requestedValue || 'ANX-C3').toUpperCase().replace(/^AGN-/, 'ANX-') as AnxReadConformanceClass
    if (!['ANX-C1', 'ANX-C2', 'ANX-C3'].includes(requested)) throw new Error('Reference conformance supports ANX-C1, ANX-C2, or ANX-C3 (legacy AGN-C1 through AGN-C3 aliases are accepted)')
    const report = await evaluateAnxReadConformance(inputPath!, requested)
    print(report)
    if (!report.passed) process.exitCode = 2
    return
  }

  if (command === 'view') {
    const [inputPath, portValue] = args
    requireArgs(command, [inputPath])
    const port = portValue ? Number.parseInt(portValue, 10) : 8787
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid viewer port: ${portValue}`)
    const viewer = await startStandaloneViewer(inputPath!, { port })
    print({ ok: true, mode: 'read-only', url: viewer.url, document: path.resolve(inputPath!) })
    return
  }

  if (command === 'review-status') {
    const [inputPath] = args
    requireArgs(command, [inputPath])
    print(await andocReviewStatus(inputPath!))
    return
  }

  if (command === 'review-propose') {
    const [inputPath, operationsPath, message, outputPath, baseRevisionValue] = args
    requireArgs(command, [inputPath, operationsPath, message])
    print(await andocReviewPropose(inputPath!, await readOperations(operationsPath!), {
      actorId: 'anx-cli-agent',
      message,
      ...(outputPath ? { outputPath } : {}),
      ...optionalBaseRevision(baseRevisionValue),
    }))
    return
  }

  if (command === 'export-docx' || command === 'export-markdown' || command === 'export-jsonl') {
    const [inputPath, outputPath] = args
    requireArgs(command, [inputPath, outputPath])
    const pkg = await readAndoc(inputPath!)
    const result = command === 'export-docx' ? exportAnxDocx(pkg) : command === 'export-markdown' ? exportAnxMarkdown(pkg) : exportAnxJsonl(pkg)
    await writeFile(outputPath!, result.bytes)
    print({ ok: true, outputPath: path.resolve(outputPath!), mediaType: result.mediaType, revision: result.revision, warnings: result.warnings })
    return
  }

  if (command === 'ocr-candidates') {
    const attach = args.includes('--attach')
    const positional = args.filter(value => value !== '--attach')
    const [inputPath, pageSpec, outputPath] = positional
    requireArgs(command, [inputPath])
    const spec = pageSpec || 'router'
    let selection: { mode?: 'router' | 'all'; pages?: number[] } = {}
    if (spec === 'all') selection = { mode: 'all' }
    else if (spec !== 'router') {
      const pages = spec.split(',').map(value => Number(value.trim()))
      if (!pages.length || pages.some(page => !Number.isInteger(page) || page < 1)) {
        throw new Error(`Invalid page selection "${spec}": use router, all, or a comma-separated 1-based page list`)
      }
      selection = { pages }
    }
    const result = await andocOcrCandidates(inputPath!, { ...selection, fullReport: Boolean(outputPath), ...(attach ? { attachTo: inputPath! } : {}) })
    if (outputPath) {
      const { fullReport, ...summary } = result as { fullReport?: unknown } & Record<string, unknown>
      await writeFile(outputPath, JSON.stringify(fullReport, null, 2) + '\n', 'utf8')
      print({ ...summary, fullReportPath: path.resolve(outputPath) })
    } else {
      print(result)
    }
    return
  }

  if (command === 'profiles') {
    const [inputPath] = args
    requireArgs(command, [inputPath])
    print(await inspectAndocCapabilities(inputPath!))
    return
  }

  if (command === 'set-profiles') {
    const [inputPath, profilesPath, outputPath] = args
    requireArgs(command, [inputPath, profilesPath, outputPath])
    const profiles = await readJson<AndocProfiles>(profilesPath!)
    const result = await setAndocProfiles(inputPath!, profiles, outputPath!)
    print({ ok: true, outputPath: path.resolve(outputPath!), profiles: result.profiles, inspection: result.inspection })
    return
  }

  if (command === 'finalize') {
    const [inputPath, privateKeyPath, keyId, role, actorId, outputPath, createdAtValue, policyPath] = args
    requireArgs(command, [inputPath, privateKeyPath, keyId, role, actorId, outputPath])
    const createdAt = createdAtValue || new Date().toISOString()
    const policy = policyPath ? await readJson<AndocFinalizationPolicy>(policyPath) : undefined
    const result = await finalizeAndoc(inputPath!, {
      privateKeyPem: await readFile(privateKeyPath!, 'utf8'),
      keyId: keyId!,
      role: role!,
      actor: { type: 'human', id: actorId! },
      createdAt,
      ...(policy ? { policy } : {}),
      outputPath: outputPath!,
    })
    print({ ok: result.verification.valid, outputPath: path.resolve(outputPath!), finalization: result.finalization, verification: result.verification })
    if (!result.verification.valid) process.exitCode = 2
    return
  }

  if (command === 'cosign') {
    const [inputPath, privateKeyPath, keyId, role, outputPath, signedAtValue] = args
    requireArgs(command, [inputPath, privateKeyPath, keyId, role, outputPath])
    const result = await cosignAndoc(inputPath!, {
      privateKeyPem: await readFile(privateKeyPath!, 'utf8'),
      keyId: keyId!,
      role: role!,
      signedAt: signedAtValue || new Date().toISOString(),
      outputPath: outputPath!,
    })
    print({ ok: result.verification.valid, outputPath: path.resolve(outputPath!), finalization: result.finalization, verification: result.verification })
    if (!result.verification.valid) process.exitCode = 2
    return
  }

  if (command === 'verify-final') {
    const [inputPath, trustStorePath] = args
    requireArgs(command, [inputPath])
    const trustStore = trustStorePath ? await readJson<AndocTrustStore>(trustStorePath) : undefined
    const result = await verifyAndocFinalization(inputPath!, trustStore)
    print(result)
    if (!result.valid) process.exitCode = 2
    return
  }

  if (command === 'derive-draft') {
    const [inputPath, actorId, outputPath, derivedAtValue, parentUri] = args
    requireArgs(command, [inputPath, actorId, outputPath])
    const result = await deriveAndocDraft(inputPath!, {
      actor: { type: 'human', id: actorId! },
      derivedAt: derivedAtValue || new Date().toISOString(),
      ...(parentUri ? { parentMode: 'reference' as const, parentUri } : {}),
      outputPath: outputPath!,
    })
    print({ ok: true, outputPath: path.resolve(outputPath!), lineage: result.lineage, transactionId: result.transactionId, revision: result.revision })
    return
  }

  if (command === 'verify-lineage') {
    const [inputPath, trustStorePathValue, externalParentPath] = args
    requireArgs(command, [inputPath])
    const trustStorePath = trustStorePathValue === '-' ? undefined : trustStorePathValue
    const trustStore = trustStorePath ? await readJson<AndocTrustStore>(trustStorePath) : undefined
    const result = await verifyAndocLineage(inputPath!, trustStore, externalParentPath)
    print(result)
    if (!result.valid) process.exitCode = 2
    return
  }

  if (command === 'preview') {
    const [inputPath, operationsPath, baseRevisionValue] = args
    requireArgs(command, [inputPath, operationsPath])
    print(await andocPreview(inputPath!, await readOperations(operationsPath!), { actorId: 'agn-cli-agent', message: 'CLI transaction preview', ...optionalBaseRevision(baseRevisionValue) }))
    return
  }

  if (command === 'apply') {
    const [inputPath, operationsPath, outputPath, baseRevisionValue] = args
    requireArgs(command, [inputPath, operationsPath])
    print(await andocApply(inputPath!, await readOperations(operationsPath!), { actorId: 'agn-cli-agent', message: 'CLI agent edit', ...(outputPath ? { outputPath } : {}), ...optionalBaseRevision(baseRevisionValue) }))
    return
  }

  if (command === 'insert-image') {
    const [inputPath, imagePath, alt, afterId, outputPath, baseRevisionValue] = args
    requireArgs(command, [inputPath, imagePath, alt])
    print(await andocInsertImage(inputPath!, imagePath!, alt!, { actorId: 'agn-cli-agent', ...(afterId ? { afterId: afterId === 'null' ? null : afterId } : {}), ...(outputPath ? { outputPath } : {}), ...optionalBaseRevision(baseRevisionValue) }))
    return
  }

  if (command === 'import-pdf') {
    const [inputPath, outputPath] = args
    requireArgs(command, [inputPath, outputPath])
    const pdfBytes = new Uint8Array(await readFile(inputPath!))
    const result = await importPdfToAndoc(pdfBytes, path.basename(inputPath!))
    await writeFile(outputPath!, result.packageBytes)
    print({
      ok: true,
      outputPath: path.resolve(outputPath!),
      documentId: result.document.documentId,
      title: result.document.title,
      doclingVersion: result.doclingVersion,
      doclingCliVersion: result.doclingCliVersion,
      stats: result.stats,
    })
    return
  }

  if (command === 'import-document') {
    const [inputPath, outputPath] = args
    requireArgs(command, [inputPath, outputPath])
    const sourceBytes = new Uint8Array(await readFile(inputPath!))
    const result = await importDocumentToAndoc(sourceBytes, path.basename(inputPath!))
    await writeFile(outputPath!, result.packageBytes)
    print({
      ok: true,
      outputPath: path.resolve(outputPath!),
      documentId: result.document.documentId,
      title: result.document.title,
      doclingVersion: result.doclingVersion,
      doclingCliVersion: result.doclingCliVersion,
      stats: result.stats,
    })
    return
  }

  if (command === 'export-pdf') {
    const [inputPath, outputPath] = args
    requireArgs(command, [inputPath, outputPath])
    const result = await exportAndocPdf(inputPath!)
    await writeFile(outputPath!, result.bytes)
    print({ ok: true, outputPath: path.resolve(outputPath!), revision: result.revision, pages: result.pageCount })
    return
  }

  if (command === 'pack') {
    const [documentPath, outputPath, assetRoot] = args
    requireArgs(command, [documentPath, outputPath])
    const document = await readJson<AndocDocument>(documentPath!)
    const root = path.resolve(assetRoot || path.dirname(documentPath!))
    const assets = Object.fromEntries(await Promise.all(Object.values(document.assets).map(async asset => [
      asset.id,
      new Uint8Array(await readFile(path.resolve(root, asset.packagePath))),
    ])))
    await packAndoc({ document, assets }, outputPath)
    print({ ok: true, outputPath: path.resolve(outputPath!), revision: document.revision, blocks: document.blocks.length })
    return
  }

  if (command === 'unpack') {
    const [inputPath, outputDirectory] = args
    requireArgs(command, [inputPath, outputDirectory])
    const pkg = await unpackAndoc(inputPath!, outputDirectory!)
    print({ ok: true, outputDirectory: path.resolve(outputDirectory!), revision: pkg.document.revision, entries: pkg.manifest.entries.length })
    return
  }

  if (command === 'migrate') {
    const [inputPath, outputPath] = args
    requireArgs(command, [inputPath, outputPath])
    if (path.extname(outputPath!).toLowerCase() !== '.anx') throw new Error('Migration output must use the canonical .anx extension')
    const pkg = await readAndoc(inputPath!)
    if (pkg.finalizations.length || pkg.lineage) {
      throw new Error('Automatic migration is disabled for finalized or lineaged packages because exact package hashes must remain stable')
    }
    const packageBytes = await repackAndocPackage(pkg)
    await writeFile(outputPath!, packageBytes)
    const validation = await validateAndoc(packageBytes)
    if (!validation.ok) throw new Error(JSON.stringify(validation.issues))
    print({ ok: true, inputPath: path.resolve(inputPath!), outputPath: path.resolve(outputPath!), sourceMediaType: pkg.manifest.mediaType, mediaType: validation.manifest?.mediaType })
    return
  }

  if (command === 'validate') {
    const [inputPath] = args
    requireArgs(command, [inputPath])
    const result = ['.anx', '.anxd', '.agn', '.andoc'].includes(path.extname(inputPath!).toLowerCase())
      ? await validateAndoc(inputPath!)
      : validateDocument(await readJson<unknown>(inputPath!))
    print(result)
    if (!result.ok) process.exitCode = 1
    return
  }

  if (command === 'render') {
    const [documentPath, outputPath] = args
    requireArgs(command, [documentPath, outputPath])
    const document = await readJson<AndocDocument>(documentPath!)
    const validation = validateDocument(document)
    if (!validation.ok) throw new Error(JSON.stringify(validation.issues))
    await writeFile(outputPath!, renderHtml(document))
    print({ ok: true, outputPath: path.resolve(outputPath!), revision: document.revision })
    return
  }

  if (command === 'transact') {
    const [inputPath, transactionPath, outputPath] = args
    requireArgs(command, [inputPath, transactionPath, outputPath])
    const pkg = await readAndoc(inputPath!)
    const transaction = await readJson<AndocTransaction>(transactionPath!)
    const transactionValidation = validateTransaction(transaction)
    if (!transactionValidation.ok) throw new Error(JSON.stringify(transactionValidation.issues))
    const { document, packageBytes } = await transactAndocPackage(pkg, transaction)
    await writeFile(outputPath!, packageBytes)
    print({ ok: true, outputPath: path.resolve(outputPath!), revision: document.revision, transactionId: transaction.id })
    return
  }

  usage()
  process.exitCode = command ? 1 : 0
}

function requireArgs(command: string, values: Array<string | undefined>): void {
  if (values.some(value => !value)) {
    usage()
    throw new Error(`Missing arguments for ${command}`)
  }
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T
}

async function readOperations(filePath: string): Promise<AndocOperation[]> {
  const value = await readJson<AndocOperation[] | { operations: AndocOperation[] }>(filePath)
  const operations = Array.isArray(value) ? value : value.operations
  if (!Array.isArray(operations) || !operations.length) throw new Error('Operations file must contain a non-empty JSON array or an object with an operations array')
  return operations
}

function optionalBaseRevision(value: string | undefined): { baseRevision?: number } {
  if (value === undefined) return {}
  const baseRevision = Number.parseInt(value, 10)
  if (!Number.isInteger(baseRevision) || baseRevision < 0 || String(baseRevision) !== value) throw new Error(`Invalid base revision: ${value}`)
  return { baseRevision }
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function usage(): void {
  process.stdout.write(`ANX CLI

Usage:
  anx outline <input.anx> [maximum-blocks]
  anx edit-locate <input.anx> <exact-current-text> [limit]
  anx get <input.anx> <node-id>
  anx search <input.anx> <query> [limit]
  anx cite <input.anx> <node-id>
  anx text-quality <input.anx> [all]
  anx regions <input.anx> [page] [kinds-csv] [all-parts]
  anx page-evidence <input.anx> <page> [kinds-csv] [all-parts]
  anx ocr-candidates <input.anx> [router|all|pages-csv] [full-report.json] [--attach]
  anx diff <from.anx> <to.anx> [markdown]
  anx conformance <input.anx> [ANX-C1|ANX-C2|ANX-C3]
  anx view <input.anx> [port]
  anx review-status <input.anx>
  anx review-propose <input.anx> <operations.json> <message> [output.anx] [base-revision]
  anx profiles <input.anx>
  anx set-profiles <input.anx> <profiles.json> <output.anx>
  anx finalize <input.anx> <private-key.pem> <key-id> <role> <actor-id> <output.anx> [created-at] [policy.json]
  anx cosign <input.anx> <private-key.pem> <key-id> <role> <output.anx> [signed-at]
  anx verify-final <input.anx> [trust-store.json]
  anx derive-draft <final.anx> <actor-id> <output.anx> [derived-at] [parent-uri]
  anx verify-lineage <input.anx> [trust-store.json|-] [external-parent.anx]
  anx preview <input.anx> <operations.json> [base-revision]
  anx apply <input.anx> <operations.json> [output.anx] [base-revision]
  anx insert-image <input.anx> <image.png|jpg> <alt> [after-id|null] [output.anx] [base-revision]
  anx import-document <input.pdf|docx|pptx|xlsx> <output.anx>
  anx import-pdf <input.pdf> <output.anx>
  anx export-pdf <input.anx> <output.pdf>
  anx export-docx <input.anx> <output.docx>
  anx export-markdown <input.anx> <output.md>
  anx export-jsonl <input.anx> <output.jsonl>
  anx pack <document.json> <output.anx> [asset-root]
  anx unpack <input.anx> <output-directory>
  anx migrate <legacy.anxd|legacy.agn|legacy.andoc> <output.anx>
  anx validate <input.anx|legacy.anxd|legacy.agn|legacy.andoc|document.json>
  anx render <document.json> <output.html>
  anx transact <input.anx> <transaction.json> <output.anx>

Legacy agn/andoc commands and .anxd/.agn/.andoc input files remain supported during migration; new writes use .anx.
`)
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
