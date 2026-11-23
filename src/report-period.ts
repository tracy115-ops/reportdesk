import { businessDate, calendarDate } from './domain';
import type { ParagraphText, Settings } from './domain';

interface DateRange { from: string; to: string }

export function reportingField(text: string) {
  const field = /^(?:#{1,6}\s+)?([^:：]{1,36})[:：]\s*(.*)$/.exec(text.trim().normalize('NFKC').replaceAll('**', ''));
  if (!field) return;
  const label = field[1]!.trim().toLowerCase();
  if (/^(?:汇报|报告|统计)(?:周期|区间|期间|范围)$|^(?:reporting |report )?period$|^date range$/.test(label)) {
    return { kind: 'range' as const, value: field[2]! };
  }
  if (/^(?:汇报|报告|统计|业务)?日期$|^(?:reporting |report )?date$/.test(label)) {
    return { kind: 'date' as const, value: field[2]! };
  }
}

function parseRange(value: string): DateRange | undefined {
  const date = businessDate(value, 'ymd');
  if (date) return { from: date, to: date };
  const month = /^(\d{4})[-/.年](\d{1,2})月?$/.exec(value);
  if (month) {
    const from = businessDate(value.replace(/月$/, '') + (value.includes('年') ? '月1日' : '-1'), 'ymd');
    if (from) return { from, to: calendarDate(new Date(Number(month[1]), Number(month[2]), 0)) };
  }
  const endpoints = value.split(/\s+(?:-|to)\s+|\s*[至到~–—]\s*/i);
  if (endpoints.length !== 2) return;
  const from = businessDate(endpoints[0], 'ymd');
  const to = businessDate(endpoints[1], 'ymd');
  if (from && to && from <= to) return { from, to };
}

export type DocumentPeriod =
  | { state: 'docUndated'; range?: undefined }
  | { state: 'docInPeriod' | 'docOutsidePeriod' | 'docOverlaps'; range: DateRange };

export function documentPeriod(paragraphs: ParagraphText[], settings: Settings): DocumentPeriod {
  const fields = paragraphs.slice(0, 12).flatMap(paragraph => reportingField(paragraph.text) ?? []);
  const ranges = fields.filter(field => field.kind === 'range');
  const preferred = ranges.length ? ranges : fields;
  const range = preferred.length ? parseRange(preferred[0]!.value) : undefined;
  if (!range || preferred.some(field => {
    const item = parseRange(field.value);
    return item?.from !== range.from || item.to !== range.to;
  })) return { state: 'docUndated' };
  if (range.from >= settings.from && range.to <= settings.to) return { state: 'docInPeriod', range };
  if (range.to < settings.from || range.from > settings.to) return { state: 'docOutsidePeriod', range };
  return { state: 'docOverlaps', range };
}
