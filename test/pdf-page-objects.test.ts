import assert from 'node:assert/strict'
import test from 'node:test'
import { PDFDocument, rgb } from 'pdf-lib'
import { analyzePdfPageObjects } from '../src/pdf-page-objects.js'

const pixelPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=',
  'base64',
)

test('PDF page-object analysis reads placed images and vector-ruled tables without OCR', async () => {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([600, 800])
  const image = await pdf.embedPng(pixelPng)
  page.drawImage(image, { x: 0, y: 0, width: 290, height: 300 })
  page.drawImage(image, { x: 310, y: 0, width: 290, height: 300 })
  page.drawRectangle({ x: 40, y: 420, width: 260, height: 130, borderColor: rgb(0, 0, 0), borderWidth: 1 })
  for (const y of [440, 460, 480, 500, 520]) {
    page.drawLine({ start: { x: 40, y }, end: { x: 300, y }, color: rgb(0, 0, 0), thickness: 1 })
  }

  const analysis = await analyzePdfPageObjects(await pdf.save())

  assert.equal(analysis.schema, 'anx.pdf-page-object-analysis.v1')
  assert.equal(analysis.pages, 1)
  assert.equal(analysis.placedImages.filter(candidate => candidate.areaRatio > 0.15).length, 2)
  assert.ok(analysis.vectorTableCandidates.some(candidate =>
    candidate.page === 1
    && candidate.horizontalRuleCount >= 4
    && candidate.bbox[0] <= 41
    && candidate.bbox[2] >= 299
  ))
})
