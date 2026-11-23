import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Link, Parent, Root, Text } from 'mdast';
import type { Evidence } from './domain';

export default function AssistantReply({ text, refs, show }: { text: string; refs: Evidence[]; show: (ref: Evidence) => void }) {
  const byId = new Map(refs.map(ref => [ref.id, ref]));

  function citations() {
    function visit(parent: Parent) {
      const children = parent.children;
      for (let index = children.length - 1; index >= 0; index--) {
        const child = children[index];
        if (child?.type === 'text') {
          const parts = child.value.split(/(\[S\d+\])/g);
          if (parts.length < 2) continue;
          const nodes = parts.filter(Boolean).map((part): Text | Link => {
            const id = part.slice(1, -1);
            const value: Text = { type: 'text', value: part };
            return byId.has(id) && part === `[${id}]` ? { type: 'link', url: '#excerpt-' + id, children: [value] } : value;
          });
          children.splice(index, 1, ...nodes);
        } else if (child && 'children' in child && child.type !== 'link' && child.type !== 'linkReference') {
          visit(child);
        }
      }
    }
    return (tree: Root) => { if (byId.size) visit(tree); };
  }

  return <Markdown remarkPlugins={[remarkGfm, citations]} skipHtml components={{
    a({ href, children }) {
      const ref = href?.startsWith('#excerpt-') && byId.get(href.slice(9));
      if (ref) return <button className="assistant-cite" type="button" onClick={() => show(ref)}
        title={ref.locations.map(item => item.file + ' · ' + item.at).join('\n')}>{children}</button>;
      return href && /^https?:\/\//i.test(href)
        ? <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>
        : <>{children}</>;
    },
    img({ alt }) { return alt ? <span>{alt}</span> : null; },
  }}>{text}</Markdown>;
}
