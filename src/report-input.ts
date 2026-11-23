import { currentMapping } from './domain';
import type { Issue, Loaded, Mapping, MappingCheck, Material, ReviewDecision, Settings, Sheet, Source } from './domain';

export function mappingFolder(file: Material) {
  const path = file.path.replaceAll('\\', '/');
  if (/^(?:[a-z]:\/|\/\/)/i.test(path)) return path.slice(0, path.lastIndexOf('/')).toLowerCase();
  if (path.includes('/')) return file.sourceId + '/' + path.slice(0, path.lastIndexOf('/'));
}

export function sameLayout(first: Mapping, second: Mapping) {
  return first.sheet === second.sheet && first.headerRow === second.headerRow && first.signature === second.signature;
}

export function relinkFolderMappings(before: Source, after: Source, stored: Record<string, Mapping[]>) {
  const baseFolder = (source: Source) => {
    const path = source.path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
    return source.directory ? path : path.slice(0, path.lastIndexOf('/'));
  };
  const oldFolder = baseFolder(before);
  const newFolder = baseFolder(after);
  if (oldFolder === newFolder) return stored;
  const next = { ...stored };
  for (const [folder, rules] of Object.entries(stored)) {
    if (folder !== oldFolder && !(before.directory && folder.startsWith(oldFolder + '/'))) continue;
    const destination = newFolder + folder.slice(oldFolder.length);
    const existing = next[destination] ?? [];
    next[destination] = [...existing, ...rules.filter(rule => !existing.some(match => sameLayout(rule, match)))];
  }
  return next;
}

export function checkMapping(sheets: Sheet[], saved: Mapping | undefined, rules: Mapping[]): MappingCheck {
  if (saved) return currentMapping(sheets, saved) ? { state: 'ready', mapping: saved } : { state: 'mapping_changed' };
  const matches = rules.filter(rule => currentMapping(sheets, rule));
  if (matches.length > 1) return { state: 'folderMappingAmbiguous' };
  if (matches[0]) return { state: 'folderMapping', mapping: matches[0] };
  if (rules.some(rule => sheets.some(sheet => sheet.name === rule.sheet))) return { state: 'folderMappingChanged' };
  const mapping = currentMapping(sheets);
  return mapping ? { state: 'autoMapping', mapping } : { state: 'mapping_needed' };
}

interface InputFile { id: string; name: string; signature: string }

export interface ReportInput {
  settings: string;
  files: InputFile[];
  review: string;
  scan: string;
}

export function reportInput(settings: Settings, files: Loaded[], included: Set<string>, mappings: ReadonlyMap<string, MappingCheck>,
  issues: Issue[], decisions: Record<string, ReviewDecision>): ReportInput {
  return {
    settings: JSON.stringify([settings.team.trim(), settings.cadence, settings.from, settings.to, settings.locale]),
    files: files.filter(file => included.has(file.material.id)).map(file => {
      const check = mappings.get(file.material.id);
      return {
        id: file.material.id,
        name: file.material.relative,
        signature: JSON.stringify([
          file.version ?? [file.error, file.material.modified, file.material.size],
          check?.mapping ? Object.entries(check.mapping).sort() : check?.state,
        ]),
      };
    }),
    review: JSON.stringify(Object.entries(decisions).sort().map(([key, decision]) => [key, decision.status, decision.reason, decision.date, decision.signature])),
    scan: JSON.stringify(issues.map(issue => [issue.sourceId, issue.code, issue.detail]).sort()),
  };
}

export function inputChanges(previous: ReportInput, current: ReportInput) {
  const files = new Map(previous.files.map(file => [file.id, file]));
  const added: string[] = [];
  const changed: string[] = [];
  for (const file of current.files) {
    const before = files.get(file.id);
    if (!before) added.push(file.name);
    else if (before.signature !== file.signature) changed.push(file.name);
    files.delete(file.id);
  }
  return { added, changed, removed: [...files.values()].map(file => file.name),
    other: previous.settings !== current.settings || previous.review !== current.review || previous.scan !== current.scan };
}
