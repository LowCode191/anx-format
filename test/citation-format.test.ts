import assert from 'node:assert/strict'
import test from 'node:test'
import {
  citationBibliography,
  formatAnxCitationInlineStyles,
  formatAnxCitationStyles,
} from '../src/citation-format.js'

test('citation formatting is deterministic, style-selectable, and keeps the technical URI separate', () => {
  const bibliography = citationBibliography('Grid Planning Report', {
    citation: {
      author: [
        { given: 'Avery Jordan', family: 'Lee' },
        { literal: 'Harbor Transit Authority' },
      ],
      issued: { 'date-parts': [[2022, 8]] },
      publisher: 'Example Institute',
      URL: 'https://example.test/report',
    },
  })
  const input = {
    bibliography,
    page: 10,
    revision: 4,
    sourceNumber: 2,
    uri: 'anx://pdf-example/revisions/4/blocks/paragraph-1',
  }
  const first = formatAnxCitationStyles(input)
  const second = formatAnxCitationStyles(input)
  const inline = formatAnxCitationInlineStyles(input)

  assert.deepEqual(first, second)
  assert.equal(first.technical, input.uri)
  assert.equal(inline.technical, input.uri)
  assert.match(first.simple, /Grid Planning Report — p\. 10/)
  assert.doesNotMatch(first.simple, /ANX revision|Source 2/)
  assert.match(first.apa, /Lee, A\. J\., & Harbor Transit Authority \(2022\)/)
  assert.match(first.mla, /Lee, Avery Jordan, and Harbor Transit Authority/)
  assert.match(first.ieee, /^\[2\] A\. J\. Lee and Harbor Transit Authority,/)
  assert.match(first.ieee, /Aug\. 2022\./)
  assert.doesNotMatch(first.ieee, /p\. 10|ANX evidence/)
  assert.equal(inline.ieee, '[2, p. 10]')
  assert.match(inline.apa, /2022, p\. 10/)
  assert.doesNotMatch(`${first.apa}\n${first.mla}\n${first.ieee}`, /ANX evidence|anx:\/\//)
  assert.deepEqual(bibliography.missingFields, [])
  assert.equal(bibliography.issuedMonth, 8)
})

test('formal citation fallbacks disclose missing metadata without inventing it', () => {
  const bibliography = citationBibliography('Untitled Evidence', {})
  const formatted = formatAnxCitationStyles({
    bibliography,
    page: 3,
    revision: 0,
    sourceNumber: 1,
    uri: 'anx://pdf-example/revisions/0/blocks/paragraph-2',
  })
  const inline = formatAnxCitationInlineStyles({
    bibliography,
    page: 3,
    revision: 0,
    sourceNumber: 1,
    uri: 'anx://pdf-example/revisions/0/blocks/paragraph-2',
  })

  assert.deepEqual(bibliography.missingFields, ['author', 'issued', 'publisher'])
  assert.match(formatted.apa, /Untitled Evidence\. \(n\.d\.\)\./)
  assert.match(formatted.mla, /n\.d\./)
  assert.match(formatted.ieee, /n\.d\./)
  assert.doesNotMatch(formatted.apa, /Unknown|Anonymous/)
  assert.doesNotMatch(`${formatted.apa}\n${formatted.mla}\n${formatted.ieee}`, /ANX evidence|p\. 3/)
  assert.equal(inline.ieee, '[1, p. 3]')
})
