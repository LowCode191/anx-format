import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const python = process.env.ANX_OCR_PYTHON || process.env.AGN_OCR_PYTHON || '/Library/Frameworks/Python.framework/Versions/3.12/bin/python3'
const policy = JSON.parse(await readFile(path.join(root, 'config/rapidocr-ppocrv5-en.json'), 'utf8'))
const packageLock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'))
const pythonNames = ['docling', 'rapidocr', 'onnxruntime', 'pypdfium2', 'pdfminer.six']
const pythonMetadata = JSON.parse(execFileSync(python, ['-c', String.raw`
import importlib.metadata as metadata, json, pathlib, rapidocr
names = ${JSON.stringify(pythonNames)}
result = {}
for name in names:
    item = metadata.metadata(name)
    result[name] = {
        "name": item.get("Name", name),
        "version": metadata.version(name),
        "license": item.get("License-Expression") or item.get("License") or "NOASSERTION",
        "home": item.get("Home-page"),
    }
result["modelRoot"] = str(pathlib.Path(rapidocr.__file__).resolve().parent / "models")
print(json.dumps(result))
`], { encoding: 'utf8' }))

const components = []
for (const [packagePath, lockEntry] of Object.entries(packageLock.packages || {})) {
  if (!packagePath.startsWith('node_modules/') || !lockEntry.version) continue
  const manifestPath = path.join(root, packagePath, 'package.json')
  let manifest = {}
  try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')) } catch {}
  const name = manifest.name || packagePath.slice(packagePath.lastIndexOf('node_modules/') + 'node_modules/'.length)
  components.push({
    type: 'library',
    name,
    version: lockEntry.version,
    'bom-ref': `pkg:npm/${encodeURIComponent(name)}@${lockEntry.version}`,
    purl: `pkg:npm/${encodeURIComponent(name)}@${lockEntry.version}`,
    ...(lockEntry.integrity ? { hashes: [{ alg: 'SHA-512', content: lockEntry.integrity.replace(/^sha512-/, '') }] } : {}),
    licenses: [{ license: { id: spdx(manifest.license || lockEntry.license || manifest.licenses?.map(item => item?.type).filter(Boolean)) } }],
    properties: [{ name: 'anx:ecosystem', value: 'node' }],
  })
}

for (const requestedName of pythonNames) {
  const item = pythonMetadata[requestedName]
  components.push({
    type: 'library',
    name: item.name,
    version: item.version,
    'bom-ref': `pkg:pypi/${requestedName}@${item.version}`,
    purl: `pkg:pypi/${requestedName}@${item.version}`,
    licenses: item.license.split(/\s*(?:,|\bor\b)\s*/i).filter(Boolean).map(value => ({ license: { id: spdx(value) } })),
    ...(item.home ? { externalReferences: [{ type: 'website', url: item.home }] } : {}),
    properties: [
      { name: 'anx:ecosystem', value: 'python' },
      { name: 'anx:runtime-role', value: requestedName === 'docling' ? 'document-conversion' : requestedName === 'rapidocr' || requestedName === 'onnxruntime' ? 'selective-ocr' : 'pdf-analysis' },
    ],
  })
}

const modelFiles = await recursiveFiles(pythonMetadata.modelRoot)
for (const model of policy.models) {
  const filePath = modelFiles.find(candidate => path.basename(candidate) === model.file)
  if (!filePath) throw new Error(`Pinned OCR model is not installed: ${model.file}`)
  const bytes = await readFile(filePath)
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== model.sha256) throw new Error(`Pinned OCR model digest mismatch: ${model.file}`)
  components.push({
    type: 'file',
    name: model.file,
    version: `${model.family}-${model.variant}`,
    'bom-ref': `anx:model:${model.sha256}`,
    hashes: [{ alg: 'SHA-256', content: digest }],
    licenses: [{ license: { id: 'Apache-2.0' } }],
    properties: [
      { name: 'anx:model-family', value: model.family },
      { name: 'anx:model-role', value: model.role },
      { name: 'anx:model-bytes', value: String((await stat(filePath)).size) },
    ],
  })
}

components.sort((left, right) => left['bom-ref'].localeCompare(right['bom-ref']))
for (const required of ['docling', 'rapidocr', 'onnxruntime', 'pypdfium2']) {
  if (!components.some(component => component.name.toLowerCase() === required)) throw new Error(`SBOM missing required component: ${required}`)
}
const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.6',
  serialNumber: `urn:uuid:${stableUuid(createHash('sha256').update(JSON.stringify(components)).digest('hex'))}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: { components: [{ type: 'application', name: '@anx/core SBOM generator', version: '1.0.0' }] },
    component: { type: 'application', name: '@anx/core', version: packageLock.version || '0.3.0', 'bom-ref': `pkg:npm/%40anx%2Fcore@${packageLock.version || '0.3.0'}` },
    properties: [
      { name: 'anx:ocr-policy-id', value: policy.id },
      { name: 'anx:ocr-policy-schema', value: policy.schema },
      { name: 'anx:claim-boundary', value: 'Inventory and hashes establish dependency provenance, not vulnerability absence or OCR accuracy.' },
    ],
  },
  components,
}
const output = path.join(root, 'docs/dependencies-sbom.cdx.json')
await writeFile(output, `${JSON.stringify(sbom, null, 2)}\n`)
process.stdout.write(`Generated ${path.relative(root, output)} with ${components.length} components, including Docling and ${policy.models.length} pinned OCR models.\n`)

async function recursiveFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  return (await Promise.all(entries.map(entry => entry.isDirectory()
    ? recursiveFiles(path.join(directory, entry.name))
    : [path.join(directory, entry.name)]))).flat()
}

function spdx(value) {
  const license = Array.isArray(value) ? value.join(' OR ') : String(value || 'NOASSERTION').trim()
  const normalized = license.replace(/ License$/i, '')
  if (/^MIT$/i.test(normalized)) return 'MIT'
  if (/^Apache[- ]?2(?:\.0)?$/i.test(normalized)) return 'Apache-2.0'
  if (/^BSD[- ]?3[- ]Clause$/i.test(normalized)) return 'BSD-3-Clause'
  if (/^ISC$/i.test(normalized)) return 'ISC'
  return normalized || 'NOASSERTION'
}

function stableUuid(hex) {
  const chars = `${hex.slice(0, 12)}4${hex.slice(13, 16)}8${hex.slice(17, 20)}${hex.slice(20, 32)}`
  return `${chars.slice(0, 8)}-${chars.slice(8, 12)}-${chars.slice(12, 16)}-${chars.slice(16, 20)}-${chars.slice(20, 32)}`
}
