import { DownloadOutlined, RightOutlined } from '@ant-design/icons';
import { Alert, App as AntApp, Button, InputNumber, Pagination, Select, Tag } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorCode, saveArtifact } from './desktop';
import type { Cell } from './domain';
import { artifactName } from './office';
import { makeWorkbook } from './office-output';
import { maxFontCheck, pptxRules } from './pptx-audit';
import type { SlideFinding } from './pptx-audit';

const severityLabels = { error: 'pptError', warning: 'pptWarning', info: 'pptInfo' } as const;
const severityColors = { error: 'red', warning: 'gold', info: 'blue' } as const;

export default function SlideAudit({ title, count, findings, viewPage }: { title: string; count: number; findings: SlideFinding[]; viewPage: (finding: SlideFinding) => void }) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const [minFont, setMinFont] = useState(16);
  const [severity, setSeverity] = useState<'all' | keyof typeof severityLabels>('all');
  const [slide, setSlide] = useState<number>();
  const [page, setPage] = useState(1);
  const [saving, setSaving] = useState(false);
  const flagged = findings.filter(item => item.code !== 'smallType' || (item.size ?? 0) < minFont);
  const visible = flagged.filter(item => (severity === 'all' || pptxRules[item.code].severity === severity) && (slide === undefined || slide === item.page));
  const current = Math.min(page, Math.max(1, Math.ceil(visible.length / 10)));
  const affected = [...new Set(findings.map(item => item.page))].sort((a, b) => a - b);
  const flaggedPages = new Set(flagged.map(item => item.page)).size;

  async function exportFindings() {
    setSaving(true);
    try {
      const rows: Record<number, Cell>[] = [{ 1: t('pageNumber'), 2: t('pptSeverity'), 3: t('pptFinding'), 4: t('pptObject'), 5: t('pptFontSize'), 6: t('pptFix') }];
      for (const finding of visible) {
        const rule = pptxRules[finding.code];
        rows.push({ 1: finding.page, 2: t(severityLabels[rule.severity]), 3: t(finding.code), 4: finding.object ?? '', 5: finding.size ?? '', 6: t(rule.fix) });
      }
      const output = await makeWorkbook(t('pptCheck'), rows, { widths: [9, 14, 28, 34, 15, 57] });
      const name = artifactName({ title: title.replace(/\.pptx$/i, '') + ' ' + t('pptCheck'), kind: 'xlsx' });
      const path = await saveArtifact(name, output);
      if (path) message.success(t('exported', { path }));
    } catch (error) { message.error(t(errorCode(error, 'export_failed'), { defaultValue: t('export_failed') })); }
    finally { setSaving(false); }
  }

  return <section className="slide-audit">
    <div className="audit-title"><div><strong>{t('pptAuditSummary', { count, affected: flaggedPages, findings: flagged.length })}</strong>
      <p className="muted">{t('pptAuditHint')}</p></div>
      <Button icon={<DownloadOutlined />} disabled={!visible.length} loading={saving} onClick={() => void exportFindings()}>{t('pptExportFiltered')}</Button>
    </div>
    <div className="audit-filters">
      <label htmlFor="audit-min-font">{t('pptMinFont')}</label>
      <InputNumber id="audit-min-font" value={minFont} min={8} max={maxFontCheck} precision={0} suffix="pt"
        onChange={value => { if (value && value >= 8 && value <= maxFontCheck) setMinFont(value); setPage(1); }} />
      <Select aria-label={t('pptSeverity')} value={severity}
        options={(['all', 'error', 'warning', 'info'] as const).map(value => ({ value, label: t(value === 'all' ? 'pptAllFindings' : severityLabels[value]) }))}
        onChange={value => { setSeverity(value); setPage(1); }} />
      {affected.length > 1 && <Select allowClear aria-label={t('pageNumber')} placeholder={t('pptAllPages')} value={slide}
        options={affected.map(value => ({ value, label: t('pptUntitledPage', { page: value }) }))}
        onChange={value => { setSlide(value); setPage(1); }} />}
    </div>
    {visible.length === 0 ? <Alert showIcon type="success" title={t(flagged.length ? 'pptNoFilteredFindings' : 'pptNoFindings')} /> :
      <div className="audit-results">
        {visible.slice((current - 1) * 10, current * 10).map((finding, index) => {
          const { severity, fix } = pptxRules[finding.code];
          return <div className="audit-result" key={index}>
            <Tag color={severityColors[severity]}>{t(severityLabels[severity])}</Tag>
            <div>
              <strong>{t(finding.code)} {finding.size !== undefined && '· ' + finding.size + ' pt'}</strong>
              {finding.object && <span className="muted">{finding.object}</span>}
              <p>{t(fix)}</p>
            </div>
            <Button type="text" size="small" onClick={() => viewPage(finding)}>{t('pptGoToPage', { page: finding.page })}<RightOutlined /></Button>
          </div>;
        })}
      </div>}
    {visible.length > 10 && <Pagination size="small" current={current} pageSize={10} total={visible.length}
      onChange={setPage} showSizeChanger={false} />}
  </section>;
}
