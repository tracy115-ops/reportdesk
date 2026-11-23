import type { ArtifactKind, Cadence } from './domain';
import type { Format } from './office';

export type OfficeCommandPlan =
  | { kind: 'report'; cadence: Cadence; previous: boolean; outputs: ReportOutput[]; withAgent: boolean }
  | { kind: 'agent'; format?: Format }
  | { kind: 'clarify'; reason: 'cadence' | 'period' };

export type ReportOutput = Exclude<ArtifactKind, 'png' | 'mp3' | 'mp4'>;

export const assistantCommands = [
  { key: 'weekly', zh: '周报', en: 'weekly', aliases: ['周报', '週報', 'weekly'], label: 'assistantCommandWeekly' },
  { key: 'monthly', zh: '月报', en: 'monthly', aliases: ['月报', '月報', 'monthly'], label: 'assistantCommandMonthly' },
  { key: 'word', zh: 'Word', en: 'word', aliases: ['word', 'docx'], label: 'assistantCommandWord', format: 'docx' },
  { key: 'ppt', zh: 'PPT', en: 'ppt', aliases: ['ppt', 'pptx'], label: 'assistantCommandPpt', format: 'pptx' },
  { key: 'bundle', zh: '交付包', en: 'bundle', aliases: ['交付包', 'bundle'], label: 'assistantCommandBundle', format: 'bundle' },
] as const;

export function readAssistantCommand(request: string) {
  const match = /^\/([^\s]+)(?=\s|$)/.exec(request.trimStart());
  const name = match?.[1]?.normalize('NFKC').toLowerCase();
  const command = name && assistantCommands.find(item => item.aliases.some(alias => alias === name));
  if (!command || !match) return undefined;
  const text = request.trimStart().slice(match[0].length).trim();
  if ('format' in command) return { format: command.format, text };
  const plan = planOfficeCommand(`生成${command.zh} ${text}`, command.key);
  return { plan, text };
}

const formats: [ReportOutput, RegExp][] = [
  ['docx', /\b(?:docx|word)\b/i], ['xlsx', /\b(?:xlsx|excel)\b(?!\s+(?:source|input|data))|明细表/i],
  ['pptx', /\b(?:pptx?|powerpoint|slides)\b|演示(?:文稿|稿)|幻灯片/i], ['html', /\bhtml\b|网页/i], ['pdf', /\bpdf\b/i],
];

export function planOfficeCommand(request: string, forcedCadence?: Cadence): OfficeCommandPlan {
  const text = request.normalize('NFKC');
  const weekly = forcedCadence ? forcedCadence === 'weekly' : /[周週][报報]|\bweekly report\b|\b(?:last|this|previous|current) week['’]s report\b/i.test(text);
  const monthly = forcedCadence ? forcedCadence === 'monthly' : /月[报報]|\bmonthly report\b|\b(?:last|this|previous|current) month['’]s report\b/i.test(text);
  if (!forcedCadence && ((!weekly && !monthly) || /翻[译譯]|改写|对比|润色|翻成|\b(?:translate|rewrite|compare|edit)\b/i.test(text))) {
    const target = text.split(/(?:导出(?:为)?|保存为|做成|输出为|生成一份?|\b(?:export|save as|create)\b)/i).at(-1) ?? text;
    const word = formats[0]![1].test(target);
    const slides = formats[2]![1].test(target);
    return { kind: 'agent', format: word && slides ? 'bundle' : word ? 'docx' : slides ? 'pptx' : undefined };
  }
  if (weekly && monthly) return { kind: 'clarify', reason: 'cadence' };

  const previous = /上[一個个]?周|上[一個个]?月|上一期|\b(?:last|previous)\s+(?:week|month|period)\b/i.test(text);
  const current = /本周|这周|這週|本月|这个月|這個月|本期|\b(?:this|current)\s+(?:week|month|period)\b/i.test(text);
  const differentPeriod = weekly
    ? /(?:上[一個个]?|本|这[个]?|這[個]?)月|\b(?:last|this|previous|current)\s+month\b/i
    : /(?:上[一個个]?|本|这|這)[周週]|\b(?:last|this|previous|current)\s+week\b/i;
  if ((previous && current) || differentPeriod.test(text)
    || /\d{4}[-/.]\d{1,2}|(?:前两周|前兩週)|\b(?:two weeks ago|custom date)\b/i.test(text)) return { kind: 'clarify', reason: 'period' };

  const outputInstructions = text.replace(/(?:根据|基于|读取|使用|把|用)\s*(?:Excel|Word|PDF)\b\s*(?:来源|文件|资料|数据|表格)?/gi, '')
    .replace(/\b(?:from|using|based on)\s+(?:the\s+)?(?:excel|word|pdf)\b/gi, '')
    .replace(/(?:不要|不[用需]|别|无需|排除)\s*(?:导出|生成)?\s*(?:PPTX?|PPT|DOCX|Word|XLSX|Excel|PDF|HTML|网页|幻灯片)/gi, '')
    .replace(/\b(?:no|without|exclude|skip|do not export|don['’]t export)\s+(?:pptx?|powerpoint|slides|docx|word|xlsx|excel|pdf|html)\b/gi, '');
  const offline = /(?:别用|不用|不要用|不使用|无需使用)\s*(?:AI|Codex|Agent)|\b(?:no|without|do not use|don['’]t use)\s+(?:an?\s+)?(?:AI|Codex|Agent)\b/i.test(text);
  return {
    kind: 'report', cadence: weekly ? 'weekly' : 'monthly', previous,
    outputs: formats.filter(([, pattern]) => pattern.test(outputInstructions)).map(([format]) => format),
    withAgent: !offline && /(?:用|交给|让|請|请)\s*(?:AI|Codex|Agent)|(?:AI|Codex|Agent)\s*(?:写|整理|起草|撰写|润色)|\b(?:with|use|have)\s+(?:an?\s+)?(?:AI|Codex|Agent)\b/i.test(text),
  };
}
