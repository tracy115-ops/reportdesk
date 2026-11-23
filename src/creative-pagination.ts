import { slideTextTokens, wrapSlideText } from './creative-scene';

const contentWidth = 826;
const bodyFont = 25;
const pageLines = 9;
const paragraphsPerPage = 5;
const citation = /^\[[SDTA]\d+\]$/;
const sentenceEnd = /[。！？.!?；;]["'”’）】]?(?:\s+\[[SDTA]\d+\])*\s*$/;

function fits(text: string) {
  return wrapSlideText(text, contentWidth, bodyFont).split('\n').length <= pageLines;
}

function paragraphTokens(paragraph: string) {
  const units: string[] = [];
  for (const value of slideTextTokens(paragraph)) {
    if (citation.test(value) && units.length) {
      const space = !units.at(-1)?.trim() ? units.pop()! : '';
      const joined = units.at(-1) + space + value;
      if (units.length && (joined.length <= 240 || fits(joined))) units[units.length - 1] = joined;
      else units.push(space + value);
    } else if (value.length > 240 && !fits(value)) {
      for (const character of value) units.push(character);
    } else {
      units.push(value);
    }
  }
  return units;
}

function splitParagraph(paragraph: string) {
  if (fits(paragraph)) return [paragraph];
  const units = paragraphTokens(paragraph);
  const parts: string[] = [];
  for (let start = 0; start < units.length;) {
    let first = start + 1;
    let last = Math.min(units.length, start + 1024);
    while (first < last) {
      const middle = Math.ceil((first + last) / 2);
      if (fits(units.slice(start, middle).join('').trim())) first = middle;
      else last = middle - 1;
    }
    let end = first;
    if (end < units.length) {
      const minimum = start + Math.ceil((end - start) * .7);
      for (let candidate = end; candidate > minimum; candidate--) {
        if (sentenceEnd.test(units[candidate - 1]!)) { end = candidate; break; }
      }
    }
    const part = units.slice(start, end).join('').trim();
    if (part) parts.push(part);
    start = end;
  }
  return parts;
}

export function paginateSlideBody(text: string): string[] {
  const pages: string[] = [];
  let current: string[] = [];
  for (const paragraph of text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)) {
    for (const part of splitParagraph(paragraph)) {
      const next = [...current, part];
      if (current.length && (next.length > paragraphsPerPage || !fits(next.join('\n\n')))) {
        pages.push(current.join('\n'));
        current = [part];
      } else current = next;
    }
  }
  if (current.length) pages.push(current.join('\n'));
  return pages.length ? pages : [''];
}

export function exceedsSlideBody(text: string) {
  const paragraphs = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return paragraphs.length > paragraphsPerPage || !fits(paragraphs.join('\n\n'));
}
