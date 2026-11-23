import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { SlideVisual } from './slide-visual';

type Text = NonNullable<SlideVisual['shapes'][number]['text']>;
type Chart = NonNullable<SlideVisual['shapes'][number]['chart']>;

function SlideText({ text, width }: { text: Text; width: number }) {
  const box = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const size = text.size / width * 100;
  useLayoutEffect(() => {
    const target = box.current;
    const words = content.current;
    if (!target || !words || !text.shrink) return;
    const fit = () => {
      let scale = 1;
      words.style.fontSize = size + 'cqw';
      while (scale > 0.55 && words.scrollHeight > target.clientHeight + 1) {
        scale *= 0.9;
        words.style.fontSize = (size * scale) + 'cqw';
      }
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(target);
    return () => observer.disconnect();
  }, [size, text.shrink, text.value]);
  return <div className="slide-preview-text" ref={box} style={{ alignItems: text.center ? 'center' : 'start' }}>
    <div ref={content} style={{ fontSize: size + 'cqw', color: text.color, fontWeight: text.bold ? 700 : 400, textAlign: text.align }}>{text.value}</div>
  </div>;
}

function SlideChart({ chart }: { chart: Chart }) {
  const magnitudes = chart.rows.map(row => Math.abs(row.value));
  const scale = Math.max(...magnitudes) || 1;
  const normalized = chart.rows.map(row => row.value / scale);
  const min = Math.min(0, ...normalized);
  const max = Math.max(0, ...normalized);
  const range = max - min || 1;
  const position = (value: number) => (value - min) / range * 100;
  const zero = position(0);
  const number = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 10 });
  return <div className="slide-chart">
    {chart.rows.map((row, index) => {
      const level = position(normalized[index]!);
      return <div className="slide-chart-row" key={index}>
        <span title={row.label}>{row.label}</span>
        <div className="slide-chart-track">
          <i style={{ left: zero + '%' }} />
          <b style={{ left: Math.min(level, zero) + '%', width: Math.abs(level - zero) + '%', backgroundColor: chart.color }} />
        </div>
        <strong>{number.format(row.value)}</strong>
      </div>;
    })}
  </div>;
}

function SlidePicture({ file, crop }: { file: Blob; crop: SlideVisual['shapes'][number]['crop'] }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const location = URL.createObjectURL(file);
    setUrl(location);
    return () => URL.revokeObjectURL(location);
  }, [file]);
  if (!url) return null;
  const width = Math.max(.05, 1 - (crop?.left ?? 0) - (crop?.right ?? 0));
  const height = Math.max(.05, 1 - (crop?.top ?? 0) - (crop?.bottom ?? 0));
  return <img alt="" src={url} className="slide-picture" style={{
    width: (100 / width) + '%', height: (100 / height) + '%',
    left: (-100 * (crop?.left ?? 0) / width) + '%', top: (-100 * (crop?.top ?? 0) / height) + '%',
  }} />;
}

export default function SlidePreview({ page, label }: { page: SlideVisual; label: string }) {
  const ratio = page.width / page.height;
  return <div className="slide-preview" role="img" aria-label={label}
    style={{ aspectRatio: ratio, background: page.background, '--slide-ratio': ratio } as CSSProperties}>
    {page.shapes.map((shape, index) => {
      const line = shape.kind === 'line';
      const stroke = shape.strokeWidth / page.width * 100 + 'cqw';
      const angle = (shape.rotation ?? 0) + (line ? Math.atan2(shape.height, shape.width) * 180 / Math.PI : 0);
      const width = line ? Math.hypot(shape.width, shape.height) : shape.width;
      return <div className="slide-preview-shape" key={index} style={{
        left: shape.x / page.width * 100 + '%', top: shape.y / page.height * 100 + '%',
        width: width / page.width * 100 + '%', height: line ? stroke : shape.height / page.height * 100 + '%',
        borderRadius: shape.kind === 'roundRect' ? '1.25cqw' : shape.kind === 'ellipse' ? '50%' : undefined,
        transform: angle ? 'rotate(' + angle + 'deg)' : undefined,
        transformOrigin: line ? 'left center' : undefined,
        background: line ? shape.stroke : shape.fill,
        border: !line && shape.stroke ? stroke + ' solid ' + shape.stroke : undefined,
      }}>
        {shape.text && <SlideText text={shape.text} width={page.width} />}
        {shape.chart && <SlideChart chart={shape.chart} />}
        {shape.picture && <SlidePicture file={shape.picture} crop={shape.crop} />}
        {shape.cells && <table className="slide-table"><tbody>{shape.cells.map((row, i) => <tr key={i}>
          {row.map((cell, j) => <td key={j} style={{ background: cell.fill, color: cell.color }}>{cell.text}</td>)}
        </tr>)}</tbody></table>}
      </div>;
    })}
  </div>;
}
