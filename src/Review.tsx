import { CheckCircleOutlined, FileSearchOutlined, FolderOpenOutlined, LinkOutlined, WarningOutlined } from '@ant-design/icons';
import { Button, Drawer, Input, Modal, Pagination, Radio, Select, Tag, Tooltip } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { evidenceSignature } from './domain';
import type { Analysis, Evidence, Issue, Location, Metrics, ReviewDecision, Task, TaskStatus } from './domain';

export function Blank({ kind, title, body, action }: { kind: 'folder' | 'review'; title: string; body: string; action?: React.ReactNode }) {
  return <div className="blank">
    <span className="blank-icon">{kind === 'folder' ? <FolderOpenOutlined /> : <FileSearchOutlined />}</span>
    <h3>{title}</h3><p>{body}</p>{action}
  </div>;
}

export function MetricStrip({ metrics }: { metrics?: Metrics }) {
  const { t, i18n } = useTranslation();
  const number = new Intl.NumberFormat(i18n.language);
  const fields = [['total', 'taskTotal'], ['done', 'done'], ['open', 'open'], ['unverified', 'unverified']] as const;
  return <div className="metric-strip" aria-label={t('review')}>
    {fields.map(([field, label]) => <div className={`metric metric-${field}`} key={field}>
      <span>{t(label)}</span>
      <strong data-metric={field}>{metrics ? number.format(metrics[field]) : '—'}</strong>
    </div>)}
  </div>;
}

function Status({ task }: { task: Task }) {
  const { t } = useTranslation();
  const colour = { done: 'green', open: 'blue', unknown: 'gold', conflict: 'volcano' }[task.status];
  return <Tooltip title={task.decision?.reason || `${t('rawValue')} · ${task.rawStatus || '—'}`}><Tag color={colour}>{t(task.status)}{task.decision && ` · ${t('confirmed')}`}</Tag></Tooltip>;
}

function IssueRow({ issue, show }: { issue: Issue; show: (item: Evidence) => void }) {
  const { t } = useTranslation();
  return <div className="issue-row">
    <WarningOutlined /><div className="min-w-0"><strong>{t(issue.code)}</strong><div className="text-ellipsis" title={issue.detail}>{issue.detail}</div></div>
    {issue.evidence && <Button type="text" size="small" icon={<LinkOutlined />} onClick={() => show(issue.evidence!)}>{t('source')}</Button>}
  </div>;
}

export function Review({ result, active, show, decide, exportDetails }: { result: Analysis; active: boolean; show: (item: Evidence) => void;
  decide: (key: string, value?: ReviewDecision) => void; exportDetails: () => void }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<TaskStatus | 'all'>('all');
  const [notePage, setNotePage] = useState(1);
  const [showIssues, setShowIssues] = useState(false);
  const [issuePage, setIssuePage] = useState(1);
  const [review, setReview] = useState<{ task: Task; status?: ReviewDecision['status']; reason: string; date?: string }>();
  if (!active) return <Blank kind="review" title={t('waitingTitle')} body={t('waitingBody')} />;
  const term = query.normalize('NFKC').trim().toLocaleLowerCase();
  const tasks = result.tasks.filter(task => (status === 'all' || task.status === status) && [task.title, task.owner, task.evidence.text]
    .some(text => text.normalize('NFKC').toLocaleLowerCase().includes(term)));
  const tasksPage = Math.min(page, Math.max(1, Math.ceil(tasks.length / 6)));
  const excerptsPage = Math.min(notePage, Math.max(1, Math.ceil(result.notes.length / 5)));
  const warningsPage = Math.min(issuePage, Math.max(1, Math.ceil(result.issues.length / 12)));
  return <div className="review-content">
    {result.issues.length > 0 ? <div className="review-box">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <strong>{t('reviewCount', { count: result.issues.length })}</strong>
        {result.issues.length > 2 && <Button type="link" size="small" onClick={() => setShowIssues(true)}>{t('issueMore', { count: result.issues.length })}</Button>}
      </div>
      {result.issues.slice(0, 2).map((issue, index) => <IssueRow key={index} issue={issue} show={show} />)}
    </div> : <div className="clean-review"><CheckCircleOutlined /> {t('noIssues')}</div>}
    <div className="detail-block">
      <div className="review-table-heading"><h3>{t('taskTable')}</h3>
        {result.tasks.length > 0 && <Button type="link" size="small" onClick={exportDetails}>{t('exportDetail')}</Button>}</div>
      {result.tasks.length === 0 ? <p className="muted">{t('noTasks')}</p> : <>
        <div className="review-task-filters">
          <Input size="small" allowClear aria-label={t('reportTaskSearch')} placeholder={t('reportTaskSearch')} value={query}
            onChange={event => { setQuery(event.target.value); setPage(1); }} />
          <Select size="small" aria-label={t('state')} value={status} onChange={next => { setStatus(next); setPage(1); }}
            options={(['all', 'done', 'open', 'unknown', 'conflict'] as const).map(value => ({ value, label: t(value === 'all' ? 'reportAllStates' : value) }))} />
        </div>
        {!tasks.length ? <p className="muted">{t('noMatches')}</p> :
        <div className="table-scroll"><table className="data-table task-table"><thead><tr>
          <th>{t('task')}</th><th>{t('owner')}</th><th>{t('date')}</th><th>{t('state')}</th><th><span className="sr-only">{t('source')}</span></th>
        </tr></thead><tbody>{tasks.slice((tasksPage - 1) * 6, tasksPage * 6).map(task => <tr key={task.key}>
          <td><span className="table-title">{task.title || '—'}</span></td><td>{task.owner || '—'}</td><td className="numeric">{task.date}</td>
          <td>{task.decision || task.status === 'unknown' || task.status === 'conflict' ? <button type="button" className="review-status" aria-label={`${t('resolveStatus')} ${task.title}`}
            onClick={() => setReview({ task, status: task.decision?.status, reason: task.decision?.reason ?? '', date: task.dates.length === 1 ? task.date : task.decision?.date })}><Status task={task} /></button> : <Status task={task} />}</td>
          <td><Button size="small" type="text" aria-label={t('source')} title={t('source')} icon={<LinkOutlined />} onClick={() => show(task.evidence)} /></td>
        </tr>)}</tbody></table></div>}
        {tasks.length > 6 && <Pagination size="small" current={tasksPage} pageSize={6} total={tasks.length} onChange={setPage} showSizeChanger={false} />}
      </>}
    </div>
    <div className="detail-block">
      <h3>{t('noteTable')}</h3>
      {result.notes.length === 0 ? <p className="muted">{t('noNotes')}</p> : <div className="excerpt-list">
        {result.notes.slice((excerptsPage - 1) * 5, excerptsPage * 5).map(({ kind, evidence }) => <button className="excerpt-row" key={evidence.id} onClick={() => show(evidence)}>
          <Tag>{t(kind)}</Tag><span className="excerpt-line">{evidence.text}</span><LinkOutlined />
        </button>)}
        {result.notes.length > 5 && <Pagination size="small" current={excerptsPage} pageSize={5} total={result.notes.length} onChange={setNotePage} showSizeChanger={false} />}
      </div>}
    </div>
    <Drawer open={showIssues} title={t('reviewTitle')} size={590} onClose={() => setShowIssues(false)}>
      {result.issues.slice((warningsPage - 1) * 12, warningsPage * 12).map((issue, index) => <IssueRow key={index} issue={issue} show={item => { setShowIssues(false); show(item); }} />)}
      <Pagination size="small" current={warningsPage} pageSize={12} total={result.issues.length} onChange={setIssuePage} showSizeChanger={false} />
    </Drawer>
    <Modal open={Boolean(review)} title={t('resolveStatus')} okText={t('save')} cancelText={t('cancel')} okButtonProps={{ disabled: !review?.status || !review.date }}
      onCancel={() => setReview(undefined)} onOk={() => {
        if (!review?.status || !review.date) return;
        decide(review.task.key, { status: review.status, date: review.date, reason: review.reason.trim(), signature: evidenceSignature(review.task.evidence) });
        setReview(undefined);
      }}>
      {review && <div className="edit-sections">
        <strong>{review.task.title}</strong>
        {review.task.evidence.locations.slice(0, 12).map((record, index) => <div className="review-original" key={index}>
          <span className="muted">{record.file} · {record.at}</span><p>{record.excerpt}</p>
        </div>)}
        <Radio.Group aria-label={t('chooseStatus')} value={review.status} onChange={event => setReview({ ...review, status: event.target.value })}
          options={[{ value: 'done', label: t('markDone') }, { value: 'open', label: t('markOpen') }]} />
        {review.task.dates.length > 1 && <div className="field"><label htmlFor="decision-date">{t('dateCol')}</label><Select id="decision-date" value={review.date}
          options={review.task.dates.map(date => ({ value: date, label: date }))} onChange={date => setReview({ ...review, date })} /></div>}
        <Input.TextArea aria-label={t('decisionNote')} placeholder={t('decisionNote')} value={review.reason} rows={2} maxLength={500}
          onChange={event => setReview({ ...review, reason: event.target.value })} />
        {review.task.decision && <Button size="small" type="default" onClick={() => { decide(review.task.key); setReview(undefined); }}>{t('undoDecision')}</Button>}
      </div>}
    </Modal>
  </div>;
}

export function EvidenceDrawer({ item, close, canPreview, showLocation }: {
  item: Evidence | null; close: () => void; canPreview: (location: Location) => boolean; showLocation: (location: Location) => void;
}) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const current = Math.min(page, Math.max(1, Math.ceil((item?.locations.length ?? 0) / 8)));
  return <Drawer open={Boolean(item)} onClose={close} title={`${t('evidenceTitle')}${item?.id ? ` · ${item.id}` : ''}`} size={580}>
    {item?.locations.slice((current - 1) * 8, current * 8).map((source, index) => <div className="evidence-location" key={`${source.path}-${source.at}-${index}`}>
      <h3>{source.file}</h3><span className="evidence-anchor">{source.at}</span>
      <p className="evidence-path">{source.path}</p><span className="muted">{t('excerpt')}</span><blockquote>{source.excerpt}</blockquote>
      {source.version && <Tooltip title={source.version}><small>{t('version')} · {source.version.slice(0, 12)}</small></Tooltip>}
      {canPreview(source) && <div className="mt-2"><Button type="default" size="small" onClick={() => showLocation(source)}>{t('jumpToSource')}</Button></div>}
    </div>)}
    {item && item.locations.length > 8 && <Pagination size="small" current={current} pageSize={8} total={item.locations.length} onChange={setPage} showSizeChanger={false} />}
  </Drawer>;
}
