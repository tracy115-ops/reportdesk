import { newCreativeProject } from './creative-project';
import type { CreativeLayout, CreativePage, CreativeProject } from './creative-project';
import type { Locale } from './domain';
import type { SlideData } from './slide-data';
import Papa from 'papaparse';

export const creativeWorkflows = ['progress', 'decision', 'review'] as const;
export type CreativeWorkflow = typeof creativeWorkflows[number];
const structures: Record<CreativeWorkflow, { zh: string; en: string; layout: CreativeLayout }[]> = {
  progress: [
    { zh: '本期工作汇报', en: 'Progress update', layout: 'cover' },
    { zh: '本期结论', en: 'Executive summary', layout: 'statement' },
    { zh: '关键成果', en: 'Key results', layout: 'metrics' },
    { zh: '进展与风险', en: 'Progress and risks', layout: 'columns' },
    { zh: '下一步计划', en: 'Next steps', layout: 'timeline' },
    { zh: '需要协调的事项', en: 'Decisions and support', layout: 'content' },
  ],
  decision: [
    { zh: '方案决策提案', en: 'Decision proposal', layout: 'cover' },
    { zh: '要解决的问题', en: 'The problem to solve', layout: 'statement' },
    { zh: '现状与目标', en: 'Current state and goal', layout: 'columns' },
    { zh: '方案对比', en: 'Compare the options', layout: 'comparison' },
    { zh: '建议与依据', en: 'Recommendation and evidence', layout: 'content' },
    { zh: '实施路径', en: 'Implementation plan', layout: 'steps' },
  ],
  review: [
    { zh: '项目复盘总结', en: 'Project retrospective', layout: 'cover' },
    { zh: '目标与实际结果', en: 'Goals and outcomes', layout: 'comparison' },
    { zh: '关键成果', en: 'Key results', layout: 'metrics' },
    { zh: '问题与原因', en: 'Problems and causes', layout: 'columns' },
    { zh: '经验与改进', en: 'Lessons and improvements', layout: 'content' },
    { zh: '行动安排', en: 'Action plan', layout: 'timeline' },
  ],
};
export function workflowProject(workflow: CreativeWorkflow, locale: Locale): CreativeProject {
  const pages = structures[workflow].map(item => ({ id: crypto.randomUUID(), title: locale === 'zh-CN' ? item.zh : item.en, layout: item.layout, body: '', notes: '' }));
  return { ...newCreativeProject(pages[0]!.title, locale), pages };
}

export function sampleCreativeProject(locale: Locale): CreativeProject {
  const zh = locale === 'zh-CN';
  const project = workflowProject('progress', locale);
  project.title = zh ? '产品交付周会（演示数据）' : 'Delivery update (sample data)';
  project.brief = zh ? '这是一份可编辑的演示项目，所有业务数据均为虚构。可修改文字、图表和版式后导出。' : 'An editable example with fictional business data. Edit the content, charts and layouts, then export.';
  project.audience = zh ? '项目组' : 'Project team';
  const bodies = zh ? [
    '项目组 · 阶段交付汇报\n以下均为虚构演示数据',
    '12 项计划完成 9 项，完成率 75%。\n3 项延续到下周，1 项需要跨组协助。[S1]',
    '已完成 | 9 项 | 共 12 项计划 [S1]\n完成率 | 75% | 按验收完成口径 [S1]\n待跟进 | 3 项 | 纳入下周安排 [S1]',
    '客户端：登录与工作区调整已交付。[S1]\n服务端：三个接口已完成验收。[S1]\n遗留事项：3 项任务需要继续跟进。[S1]\n跨组依赖：1 项接口联调需要协助。[S1]',
    '周一：确认联调负责人和范围。[S1]\n周三：完成集成验证并记录问题。[S1]\n周五：评审交付结果与遗留任务。[S1]',
    '请项目负责人明确跨组接口人的投入时间。[S1]\n如联调无法按期完成，先交付已验收范围，再调整其余任务排期。[S1]',
  ] : [
    'Project team · Delivery review\nAll figures are fictional sample data',
    '9 of 12 planned items delivered: 75% complete.\n3 items continue next week; 1 needs support from another team. [S1]',
    'Delivered | 9 items | Out of 12 planned [S1]\nCompletion | 75% | Accepted deliveries [S1]\nIn progress | 3 items | Scheduled for next week [S1]',
    'Client: sign-in and workspace changes delivered. [S1]\nServer: three interfaces accepted. [S1]\nOpen work: 3 items need follow-up. [S1]\nDependency: 1 integration needs help from another team. [S1]',
    'Monday: confirm owners and integration scope. [S1]\nWednesday: validate integration and record issues. [S1]\nFriday: review deliveries and open items. [S1]',
    'Confirm when the integration owner can contribute. [S1]\nIf integration slips, deliver the accepted scope first and reschedule the remaining work. [S1]',
  ];
  project.pages.forEach((page, index) => { page.body = bodies[index]!; });
  project.pages[0]!.title = project.title;
  const title = zh ? '各模块交付完成量' : 'Accepted deliveries by area';
  const source = zh ? '虚构演示数据 · 已验收交付项合计 9 项 [S1]' : 'Fictional sample data · 9 accepted delivery items [S1]';
  const chart: SlideData = { title, series: zh ? '完成项数' : 'Delivered items', source, labels: zh ? ['客户端', '服务端', '测试验证'] : ['Client', 'Server', 'Validation'], values: [4, 3, 2] };
  project.pages.splice(3, 0, { id: crypto.randomUUID(), title, body: source, notes: source, layout: 'chart', chart });
  const evidence = bodies.slice(1).join('\n') + '\n' + chart.labels.map((label, index) => label + ': ' + chart.values[index]).join('\n');
  project.refs = [{ id: 'S1', text: evidence, locations: [{ file: zh ? '虚构的周会演示资料' : 'Fictional delivery sample', path: 'sample/delivery', at: zh ? '演示数据' : 'Sample data', excerpt: evidence }] }];
  project.pageCount = 7;
  return project;
}
export function parseCreativeChart(text: string, title: string, series: string, source: string): SlideData {
  const result = Papa.parse<string[]>(text.trim(), { skipEmptyLines: 'greedy', delimitersToGuess: [',', '\t', ';'] });
  const rows = result.data;
  if (result.errors.some(error => error.code !== 'UndetectableDelimiter') || !rows.length || rows.some(row => row.length !== 2)) throw Error('studio_chart_invalid');
  const number = (text: string) => text.trim() && Number.isFinite(Number(text.replaceAll(',', '').trim())) ? Number(text.replaceAll(',', '').trim()) : undefined;
  const header = /^(数值|数量|金额|销售额|营业额|收入|支出|(?:已)?完成项数|value|count|amount|number|sales|revenue)$/i;
  const start = number(rows[0]![1]!) === undefined && header.test(rows[0]![1]!.trim()) && rows.length > 1 ? 1 : 0;
  const entries = rows.slice(start);
  if (!entries.length || entries.length > 12 || entries.some(row => !row[0]!.trim() || number(row[1]!) === undefined)) throw Error('studio_chart_invalid');
  return { title: title.trim(), series: series.trim() || title.trim(), source: source.trim(), labels: entries.map(row => row[0]!.trim()), values: entries.map(row => number(row[1]!)!) };
}
export function splitCreativePage(page: CreativePage, locale: Locale): [CreativePage, CreativePage] {
  const body = page.body.trim(); let cut = -1;
  const middle = body.length / 2;
  for (const match of body.matchAll(/\n+|[。！？]\s*|[.!?](?:\s+|$)/g)) {
    const index = match.index + match[0].length;
    if (index > 0 && index < body.length && (cut < 0 || Math.abs(index - middle) < Math.abs(cut - middle))) cut = index;
  }
  if (cut < 0 && body.length > 100) {
    const refs = [...body.matchAll(/\[[SDTA]\d+\]/g)].map(match => [match.index, match.index + match[0].length]);
    for (const segment of new Intl.Segmenter(locale, { granularity: 'word' }).segment(body)) {
      const index = segment.index;
      if (index <= 0 || index >= body.length || refs.some(([start, end]) => index > start! && index < end!)) continue;
      if (cut < 0 || Math.abs(index - middle) < Math.abs(cut - middle)) cut = index;
    }
  }
  if (cut < 0) throw Error('studio_split_empty');
  const first = body.slice(0, cut).trim(), second = body.slice(cut).trim();
  if (!first || !second) throw Error('studio_split_empty');
  return [{ ...page, body: first }, { ...page, id: crypto.randomUUID(), title: page.title + (locale === 'zh-CN' ? '（续）' : ' (continued)'), body: second, notes: '', chart: undefined, layout: page.layout === 'chart' || page.layout === 'cover' ? 'content' : page.layout }];
}
