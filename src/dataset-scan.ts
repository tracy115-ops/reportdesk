import { fromSource } from './domain';
import type { Issue, Loaded, ReportProfile, Source } from './domain';

interface ScannedFile { key: string; name: string; version: string }

export interface DatasetChanges {
  at: string;
  added: string[];
  changed: string[];
  removed: string[];
  first?: boolean;
  partial?: boolean;
}

export interface DatasetScan {
  files: ScannedFile[];
  changes: DatasetChanges;
}

export function scanDataset(profile: ReportProfile, sources: Source[], files: Loaded[], issues: Issue[], previous?: DatasetScan): DatasetScan {
  const excluded = new Set(profile.excluded);
  const relevant = files.filter(file => !excluded.has(file.material.id) && profile.sourceIds.some(id => fromSource(file, id)));
  const incomplete = profile.sourceIds.some(id => !sources.some(source => source.id === id))
    || issues.some(issue => issue.code !== 'no_files' && (!issue.sourceId || profile.sourceIds.includes(issue.sourceId)))
    || relevant.some(file => !file.version);
  if (incomplete) return {
    files: previous?.files ?? [],
    changes: { at: previous?.changes.at ?? '', added: [], changed: [], removed: [], partial: true },
  };

  const current = relevant.map(({ material, version }) => ({
    key: /^(?:[a-z]:[\\/]|\\\\)/i.test(material.path) ? material.path.replaceAll('\\', '/').toLowerCase() : material.id,
    name: material.relative,
    version: version!,
  }));
  const first = !previous?.changes.at;
  const changes: DatasetChanges = { at: new Date().toISOString(), added: [], changed: [], removed: [], first };
  if (!first) {
    const before = new Map(previous.files.map(file => [file.key, file]));
    for (const file of current) {
      const old = before.get(file.key);
      if (!old) changes.added.push(file.name);
      else if (old.version !== file.version) changes.changed.push(file.name);
      before.delete(file.key);
    }
    for (const file of before.values()) changes.removed.push(file.name);
    for (const names of [changes.added, changes.changed, changes.removed]) names.sort((a, b) => a.localeCompare(b));
  }
  return { files: current, changes };
}
