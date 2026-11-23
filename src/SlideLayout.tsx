import { Spin } from 'antd';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PresentationPage } from './domain';
import { renderDeckPage } from './presentation';
import type { SlideVisual } from './slide-visual';
import SlidePreview from './SlidePreview';

export default function SlideLayout({ page, read }: { page: PresentationPage; read?: () => Promise<ArrayBuffer> }) {
  const { t } = useTranslation();
  const [external, setExternal] = useState<SlideVisual>();
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setExternal(undefined);
    if (page.visual || !read) { setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true);
    void renderDeckPage(read, page.index, controller.signal).then(result => {
      if (!controller.signal.aborted && result.shapes.length) setExternal(result);
    }).catch(() => {}).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [read, page.index, page.visual]);
  const visual = page.visual ?? external;
  return <>
    {loading && <div className="slide-layout-loading"><Spin size="small" /> {t('pptRendering')}</div>}
    {visual ? <>
      <SlidePreview page={visual} label={t('slideVisualLabel', { page: page.index, text: page.text })} />
      {visual.approximate && <p className="muted slide-layout-note">{t('pptApproximate')}</p>}
    </> : <article className="file-paper preview-page-text"><h3>{t('slideTextPreview')}</h3><p>{page.text || t('noPageText')}</p></article>}
  </>;
}
