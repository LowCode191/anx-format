export type AnxCitationStyle = 'simple' | 'apa' | 'mla' | 'ieee' | 'technical'

export interface AnxCitationAuthor {
  given?: string
  family?: string
  literal?: string
}

export interface AnxCitationBibliography {
  title: string
  authors: AnxCitationAuthor[]
  issuedYear?: number
  issuedMonth?: number
  publisher?: string
  url?: string
  missingFields: Array<'author' | 'issued' | 'publisher'>
}

export interface AnxCitationFormatInput {
  bibliography: AnxCitationBibliography
  page?: number
  revision: number
  sourceNumber: number
  uri: string
}

export type AnxFormattedCitations = Record<AnxCitationStyle, string>
export type AnxFormattedInlineCitations = Record<AnxCitationStyle, string>

export function citationBibliography(
  documentTitle: string,
  documentMetadata: Record<string, unknown>,
): AnxCitationBibliography {
  const candidate = recordValue(documentMetadata.citation)
    || recordValue(documentMetadata.bibliographic)
    || {}
  const title = textValue(candidate.title) || documentTitle
  const authors = authorValues(candidate.author ?? candidate.authors)
  const issued = issuedValue(candidate.issued ?? candidate.year)
  const publisher = textValue(candidate.publisher)
  const url = textValue(candidate.URL ?? candidate.url)
  const missingFields: AnxCitationBibliography['missingFields'] = []
  if (!authors.length) missingFields.push('author')
  if (!issued?.year) missingFields.push('issued')
  if (!publisher) missingFields.push('publisher')
  return {
    title,
    authors,
    ...(issued?.year ? { issuedYear: issued.year } : {}),
    ...(issued?.month ? { issuedMonth: issued.month } : {}),
    ...(publisher ? { publisher } : {}),
    ...(url ? { url } : {}),
    missingFields,
  }
}

export function formatAnxCitationStyles(input: AnxCitationFormatInput): AnxFormattedCitations {
  return {
    simple: simpleCitation(input),
    apa: apaCitation(input),
    mla: mlaCitation(input),
    ieee: ieeeCitation(input),
    technical: input.uri,
  }
}

export function formatAnxCitationInlineStyles(input: AnxCitationFormatInput): AnxFormattedInlineCitations {
  const { bibliography, page, sourceNumber, uri } = input
  const year = bibliography.issuedYear ? String(bibliography.issuedYear) : 'n.d.'
  return {
    simple: page ? `Page ${page}` : 'Unpaginated source',
    apa: `(${apaInlineAttribution(bibliography)}, ${year}${page ? `, p. ${page}` : ''})`,
    mla: `(${mlaInlineAttribution(bibliography)}${page ? ` ${page}` : ''})`,
    ieee: `[${sourceNumber}${page ? `, p. ${page}` : ''}]`,
    technical: uri,
  }
}

function simpleCitation(input: AnxCitationFormatInput): string {
  const { bibliography, page } = input
  const author = bibliography.authors.map(displayAuthor).filter(Boolean).join(', ')
  const year = bibliography.issuedYear ? String(bibliography.issuedYear) : 'n.d.'
  const attribution = author ? `${author}, ${year}` : year
  return `${bibliography.title} — ${pageLabel(page)} (${attribution}).`
}

function apaCitation(input: AnxCitationFormatInput): string {
  const { bibliography } = input
  const author = apaAuthors(bibliography.authors)
  const year = bibliography.issuedYear ? String(bibliography.issuedYear) : 'n.d.'
  const work = author
    ? `${author} (${year}). ${sentence(bibliography.title)}`
    : `${sentence(bibliography.title)} (${year}).`
  return formalCitation([
    work,
    bibliography.publisher ? sentence(bibliography.publisher) : '',
    bibliography.url || '',
  ])
}

function mlaCitation(input: AnxCitationFormatInput): string {
  const { bibliography } = input
  const author = mlaAuthors(bibliography.authors)
  return formalCitation([
    author ? sentence(author) : '',
    sentence(bibliography.title),
    bibliography.publisher
      ? `${trimTerminal(bibliography.publisher)}, ${trimTerminal(String(bibliography.issuedYear || 'n.d.'))}.`
      : sentence(String(bibliography.issuedYear || 'n.d.')),
    bibliography.url || '',
  ])
}

function ieeeCitation(input: AnxCitationFormatInput): string {
  const { bibliography, sourceNumber } = input
  const author = ieeeAuthors(bibliography.authors)
  const publisher = bibliography.publisher
    && bibliography.publisher.toLocaleLowerCase() !== author.toLocaleLowerCase()
    ? bibliography.publisher
    : ''
  const parts = [
    `[${sourceNumber}]`,
    author ? `${trimTerminal(author)},` : '',
    `“${trimTerminal(bibliography.title)},”`,
    publisher ? `${trimTerminal(publisher)},` : '',
    `${ieeeIssued(bibliography)}.`,
    bibliography.url || '',
  ].filter(Boolean)
  return formalCitation([parts.join(' ')])
}

function formalCitation(parts: string[]): string {
  return parts.filter(Boolean).join(' ').replace(/\s+/gu, ' ').trim()
}

function pageLabel(page?: number): string {
  return page ? `p. ${page}` : 'unpaginated'
}

function sentence(value: string): string {
  const trimmed = value.trim()
  return /[.!?]$/u.test(trimmed) ? trimmed : `${trimmed}.`
}

function trimTerminal(value: string): string {
  return value.trim().replace(/[.,;:]+$/u, '')
}

function displayAuthor(author: AnxCitationAuthor): string {
  if (author.literal) return author.literal
  return [author.given, author.family].filter(Boolean).join(' ')
}

function apaAuthors(authors: AnxCitationAuthor[]): string {
  return joinAuthors(authors.map(author => {
    if (author.literal) return author.literal
    const initials = (author.given || '')
      .split(/\s+/u)
      .filter(Boolean)
      .map(part => `${part[0]!.toLocaleUpperCase()}.`)
      .join(' ')
    return [author.family ? `${author.family},` : '', initials].filter(Boolean).join(' ')
  }), ', & ')
}

function mlaAuthors(authors: AnxCitationAuthor[]): string {
  return joinAuthors(authors.map((author, index) => {
    if (author.literal) return author.literal
    return index === 0
      ? [author.family ? `${author.family},` : '', author.given].filter(Boolean).join(' ')
      : displayAuthor(author)
  }), ', and ')
}

function ieeeAuthors(authors: AnxCitationAuthor[]): string {
  return joinAuthors(authors.map(author => {
    if (author.literal) return author.literal
    const initials = (author.given || '')
      .split(/\s+/u)
      .filter(Boolean)
      .map(part => `${part[0]!.toLocaleUpperCase()}.`)
      .join(' ')
    return [initials, author.family].filter(Boolean).join(' ')
  }), ' and ')
}

function apaInlineAttribution(bibliography: AnxCitationBibliography): string {
  const names = bibliography.authors.map(author => author.family || author.literal || author.given || '').filter(Boolean)
  if (!names.length) return `“${trimTerminal(bibliography.title)}”`
  if (names.length === 1) return names[0]!
  if (names.length === 2) return `${names[0]} & ${names[1]}`
  return `${names[0]} et al.`
}

function mlaInlineAttribution(bibliography: AnxCitationBibliography): string {
  const names = bibliography.authors.map(author => author.family || author.literal || author.given || '').filter(Boolean)
  if (!names.length) return `“${trimTerminal(bibliography.title)}”`
  if (names.length === 1) return names[0]!
  return `${names[0]} et al.`
}

function ieeeIssued(bibliography: AnxCitationBibliography): string {
  const months = ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'May', 'Jun.', 'Jul.', 'Aug.', 'Sep.', 'Oct.', 'Nov.', 'Dec.']
  if (!bibliography.issuedYear) return 'n.d.'
  const month = bibliography.issuedMonth ? months[bibliography.issuedMonth - 1] : undefined
  return month ? `${month} ${bibliography.issuedYear}` : String(bibliography.issuedYear)
}

function joinAuthors(authors: string[], finalSeparator: string): string {
  const present = authors.filter(Boolean)
  if (present.length < 2) return present[0] || ''
  return `${present.slice(0, -1).join(', ')}${finalSeparator}${present.at(-1)}`
}

function authorValues(value: unknown): AnxCitationAuthor[] {
  if (typeof value === 'string' && value.trim()) return [{ literal: value.trim() }]
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    if (typeof item === 'string' && item.trim()) return [{ literal: item.trim() }]
    const record = recordValue(item)
    if (!record) return []
    const literal = textValue(record.literal)
    const given = textValue(record.given)
    const family = textValue(record.family)
    if (!literal && !given && !family) return []
    return [{ ...(literal ? { literal } : {}), ...(given ? { given } : {}), ...(family ? { family } : {}) }]
  })
}

function issuedValue(value: unknown): { year: number, month?: number } | undefined {
  if (Number.isInteger(Number(value)) && Number(value) > 0) return { year: Number(value) }
  const record = recordValue(value)
  const dateParts = record?.['date-parts'] ?? record?.dateParts
  if (!Array.isArray(dateParts) || !Array.isArray(dateParts[0])) return undefined
  const firstDatePart = dateParts[0]
  const year = Number(firstDatePart[0])
  if (!Number.isInteger(year) || Number(year) <= 0) return undefined
  const month = Number(firstDatePart[1])
  return {
    year: Number(year),
    ...(Number.isInteger(month) && month >= 1 && month <= 12 ? { month } : {}),
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
