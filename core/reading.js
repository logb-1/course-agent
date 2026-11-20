/**
 * Per-chapter reading stats: how much of a chapter was actually *read*.
 *
 * The pipeline can drop pages silently — an OCR engine that finds nothing, a
 * scanned page whose layer is empty, a deferred page over the OCR page cap — and
 * the report still renders, so the user cannot tell "this chapter is short" from
 * "this chapter was never read". These counts make that difference explicit:
 * `pages` (pages belonging to the chapter), `withText` (pages carrying readable
 * text), `ocred` (pages whose text came from OCR).
 *
 * Pure functions: the pipeline supplies pages, views render them, tests pin them.
 */

/** A page with fewer characters than this is treated as "no text" for stats. */
export const MIN_PAGE_CHARS = 20

/** Readable-text test shared by every consumer so counts never disagree. */
export function hasReadableText(text) {
  return String(text || '').trim().length >= MIN_PAGE_CHARS
}

/**
 * @param {Array<{index:number,text?:string,ocr?:boolean}>} pages chapter page refs
 * @param {(index:number) => object|null} lookup resolves a page number to a page
 * @returns {{pages:number, withText:number, ocred:number, chars:number, unknown:number}}
 */
export function chapterStats(pages, lookup) {
  const list = Array.isArray(pages) ? pages : []
  let withText = 0
  let ocred = 0
  let chars = 0
  let unknown = 0
  for (const index of list) {
    const page = typeof lookup === 'function' ? lookup(index) : null
    if (!page) {
      unknown += 1
      continue
    }
    const text = String(page.text || '')
    chars += text.trim().length
    if (hasReadableText(text)) withText += 1
    if (page.ocr) ocred += 1
  }
  return { pages: list.length, withText, ocred, chars, unknown }
}

/** One document's reading stats, for the "which file is mostly unread" view. */
export function fileStats(doc) {
  const pages = Array.isArray(doc?.pages) ? doc.pages : []
  let withText = 0
  let ocred = 0
  for (const page of pages) {
    if (hasReadableText(page?.text)) withText += 1
    if (page?.ocr) ocred += 1
  }
  return { pages: pages.length, withText, ocred }
}

/**
 * Page lookup for a job's documents, keyed by document name.
 *
 * Chapter page numbers are per-document, so attribution uses the chapter's `doc`
 * name (set by `buildOutline`). A page index that two documents both define is
 * ambiguous, so the single-document fallback only applies when there is one doc.
 */
export function pageLookup(docs) {
  const byDoc = new Map()
  for (const doc of docs || []) {
    const map = new Map()
    for (const page of doc.pages || []) {
      if (Number.isInteger(page.index)) map.set(page.index, page)
    }
    byDoc.set(String(doc.name || ''), map)
  }
  const single = (docs || []).length === 1 ? String(docs[0].name || '') : null
  return (docName, index) => {
    const key = String(docName || single || '')
    const map = byDoc.get(key)
    return map ? map.get(index) || null : null
  }
}

/**
 * A short, honest sentence for the report/status: only speaks when something was
 * actually lost, so a healthy chapter stays quiet.
 */
export function readingNote(stats) {
  if (!stats || !stats.pages) return ''
  const missing = stats.pages - stats.withText
  if (!missing) return ''
  if (missing === stats.pages) return `本章 ${stats.pages} 页几乎都没读到文字（扫描件或纯图），讲解依据可能不全`
  return `本章 ${missing}/${stats.pages} 页没有可读文字，讲解依据可能不全`
}
