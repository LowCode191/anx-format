import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

const execFileAsync = promisify(execFile)
const bridge = path.resolve(import.meta.dirname, '../scripts/rapidocr_bridge.py')

test('RapidOCR bridge derives stable logical row order while retaining raw fragments', async () => {
  const payload = {
    texts: ['Baseline', 'Review status', 'Metric', 'Ready', 'Availability', '96.2%'],
    scores: [0.99, 0.98, 0.97, 0.96, 0.95, 0.94],
    boxes: [
      [[500, 100], [620, 100], [620, 130], [500, 130]],
      [[820, 91], [990, 91], [990, 121], [820, 121]],
      [[120, 109], [220, 109], [220, 139], [120, 139]],
      [[820, 181], [900, 181], [900, 211], [820, 211]],
      [[120, 199], [280, 199], [280, 229], [120, 229]],
      [[500, 190], [590, 190], [590, 220], [500, 220]],
    ],
  }
  const program = [
    'import importlib.util,json,sys',
    "spec=importlib.util.spec_from_file_location('bridge',sys.argv[1])",
    'module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)',
    'payload=json.loads(sys.argv[2])',
    "print(json.dumps(module.logical_lines(payload['texts'],payload['scores'],payload['boxes'])))",
  ].join(';')
  const { stdout } = await execFileAsync('python3', ['-c', program, bridge, JSON.stringify(payload)], { encoding: 'utf8' })
  const lines = JSON.parse(stdout)
  assert.deepEqual(lines.map((line: Record<string, unknown>) => line.text), [
    'Metric Baseline Review status',
    'Availability 96.2% Ready',
  ])
  assert.deepEqual(lines[0].fragments.map((fragment: Record<string, unknown>) => fragment.text), ['Metric', 'Baseline', 'Review status'])
})
