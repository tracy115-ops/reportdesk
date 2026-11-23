import { ArrowDownOutlined, ArrowUpOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { Alert, Button, Checkbox, Input, Popconfirm, Select, Tag } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReportProfile } from './domain';
import { listMcpServers } from './mcp-client';
import type { McpServer } from './mcp-client';
import { stepKinds } from './office-workflows';
import type { OfficeWorkflow, StepUpdate, WorkflowRun, WorkflowStep } from './office-workflows';
import './extension-workbench.css';

interface Props {
  active: boolean;
  workflows: OfficeWorkflow[];
  save: (workflows: OfficeWorkflow[]) => boolean;
  profiles: ReportProfile[];
  incoming?: WorkflowRun;
  clearIncoming: () => void;
  run: (job: WorkflowRun, update: StepUpdate) => Promise<void>;
  running: boolean;
  stop: () => void;
  openArtifacts: () => void;
}

const newStep = (kind: WorkflowStep['kind'] = 'draft'): WorkflowStep => ({ id: crypto.randomUUID(), kind, instructions: '' });

export default function WorkflowWorkbench({ active, workflows, save, profiles, incoming, clearIncoming, run, running, stop, openArtifacts }: Props) {
  const { t, i18n } = useTranslation();
  const zh = i18n.language === 'zh-CN';
  const [editor, setEditor] = useState<OfficeWorkflow>();
  const [request, setRequest] = useState('');
  const [datasetId, setDatasetId] = useState<string>();
  const [servers, setServers] = useState<McpServer[]>([]);
  const [states, setStates] = useState<Record<string, Parameters<StepUpdate> extends [string, ...infer P] ? P : never>>({});
  const handled = useRef<string | undefined>(undefined);
  const titles = zh ? ['基于资料撰写', '生成周期汇报', '输出 Word', '输出 PPTX', '输出 HTML', '输出 PDF', '生成图片', '生成配音', '生成视频', '调用 MCP'] :
    ['Draft from sources', 'Generate period report', 'Export Word', 'Export PPTX', 'Export HTML', 'Export PDF', 'Generate image', 'Generate speech', 'Generate video', 'Call MCP tool'];
  const status = zh ? { running: '执行中', ok: '已完成', failed: '失败', skipped: '已跳过', pending: '等待' } :
    { running: 'Running', ok: 'Complete', failed: 'Failed', skipped: 'Skipped', pending: 'Pending' };
  const update: StepUpdate = (id, state, text) => setStates(current => ({ ...current, [id]: [state, text] }));

  useEffect(() => {
    if (!active) return;
    let current = true;
    void listMcpServers().then(items => { if (current) setServers(items); }).catch(() => undefined);
    return () => { current = false; };
  }, [active]);
  useEffect(() => {
    if (!incoming || running || handled.current === incoming.token) return;
    handled.current = incoming.token;
    setEditor(incoming.workflow);
    setDatasetId(incoming.datasetId);
    setRequest(incoming.request);
    setStates({});
    clearIncoming();
    void run(incoming, update);
  }, [incoming, running]);

  function setStep(index: number, step: WorkflowStep) {
    if (editor) setEditor({ ...editor, steps: editor.steps.map((entry, position) => position === index ? step : entry) });
  }
  function move(index: number, target: number) {
    if (!editor) return;
    const steps = [...editor.steps];
    [steps[index], steps[target]] = [steps[target]!, steps[index]!];
    setEditor({ ...editor, steps });
  }
  function saveCurrent() {
    if (!editor?.name.trim()) return;
    const next = { ...editor, name: editor.name.trim() };
    const exists = workflows.some(item => item.id === editor.id);
    if (save(exists ? workflows.map(item => item.id === editor.id ? next : item) : [...workflows, next])) setEditor(next);
  }

  return <div className="extension-workbench">
    <div className="page-heading"><div><h1>{t('workflows')}</h1><p>{zh ? '组合撰写、汇报、文件输出、多媒体和 MCP 工具。' : 'Combine drafting, reporting, export, media, and MCP tools.'}</p></div>
      <Button onClick={openArtifacts}>{t('artifacts')}</Button></div>
    <div className="extension-grid">
      <section className="panel extension-panel">
        <Button icon={<PlusOutlined />} disabled={running || workflows.length >= 48} onClick={() => {
          setEditor({ id: crypto.randomUUID(), name: '', triggers: '', steps: [newStep()] }); setStates({});
        }}>{zh ? '新建技能' : 'New skill'}</Button>
        {workflows.map(workflow => <Button key={workflow.id} disabled={running} type={editor?.id === workflow.id ? 'primary' : 'text'}
          title={workflow.name} onClick={() => { setEditor(workflow); setStates({}); }}>{workflow.name}</Button>)}
      </section>
      {editor ? <section className="panel extension-panel">
        <label>{zh ? '技能名称' : 'Skill name'}<Input value={editor.name} disabled={running} maxLength={80} onChange={event => setEditor({ ...editor, name: event.target.value })} /></label>
        <label>{zh ? '触发词（用逗号分隔）' : 'Trigger phrases (comma separated)'}<Input value={editor.triggers} disabled={running}
          maxLength={500} onChange={event => setEditor({ ...editor, triggers: event.target.value })} /></label>
        <Alert type="info" title={zh ? '在步骤里用 {{input}} 引用任务要求，用 {{previous}} 引用上一步结果。' :
          'Use {{input}} for the task request and {{previous}} for the previous result.'} />
        {editor.steps.map((step, index) => <div className="extension-step" key={step.id}>
          <div className="extension-step-header">
            <Select value={step.kind} disabled={running} onChange={kind => setStep(index, { ...step, kind })}
              options={stepKinds.map((value, index) => ({ value, label: titles[index] }))} aria-label={zh ? '步骤类型' : 'Step type'} />
            <div><Button type="text" icon={<ArrowUpOutlined />} disabled={running || index === 0} onClick={() => move(index, index - 1)} aria-label={zh ? '上移' : 'Move up'} />
              <Button type="text" icon={<ArrowDownOutlined />} disabled={running || index + 1 === editor.steps.length} onClick={() => move(index, index + 1)} aria-label={zh ? '下移' : 'Move down'} />
              <Button type="text" icon={<DeleteOutlined />} disabled={running || editor.steps.length < 2} aria-label={zh ? '删除步骤' : 'Remove step'}
                onClick={() => setEditor({ ...editor, steps: editor.steps.filter(item => item.id !== step.id) })} /></div>
          </div>
          {step.kind === 'mcp' && <><label>{zh ? 'MCP 服务' : 'MCP server'}<Select value={step.server} disabled={running} options={servers.map(server => ({ value: server.id, label: server.name }))}
            onChange={server => setStep(index, { ...step, server })} /></label>
            <label>{zh ? '工具名称' : 'Tool name'}<Input value={step.tool ?? ''} maxLength={200} disabled={running}
              onChange={event => setStep(index, { ...step, tool: event.target.value })} /></label></>}
          <Input.TextArea aria-label={zh ? '步骤要求' : 'Step instructions'} value={step.instructions} maxLength={3500} disabled={running}
            placeholder={step.kind === 'mcp' ? '{"query":"{{input}}"}' : '{{input}}'} rows={2} onChange={event => setStep(index, { ...step, instructions: event.target.value })} />
          <Checkbox disabled={running} checked={step.continueOnError} onChange={event => setStep(index, { ...step, continueOnError: event.target.checked })}>
            {zh ? '此步失败后继续' : 'Continue on failure'}</Checkbox>
          {states[step.id] && <div><Tag>{status[states[step.id]![0]]}</Tag>
            {states[step.id]?.[1] && <pre className="extension-step-output">{t(states[step.id]![1]!, { defaultValue: states[step.id]![1] })}</pre>}</div>}
        </div>)}
        <div className="artifact-actions"><Button disabled={running || editor.steps.length >= 10} icon={<PlusOutlined />}
          onClick={() => setEditor({ ...editor, steps: [...editor.steps, newStep()] })}>{zh ? '添加步骤' : 'Add step'}</Button>
          <Button disabled={running || !editor.name.trim()} onClick={saveCurrent}>{t('save')}</Button>
          {workflows.some(item => item.id === editor.id) && <Popconfirm title={zh ? '删除此技能？' : 'Delete this skill?'}
            onConfirm={() => { if (save(workflows.filter(item => item.id !== editor.id))) setEditor(undefined); }}>
            <Button type="text" danger disabled={running}>{t('remove')}</Button></Popconfirm>}</div>
        <label>{zh ? '使用数据集（可选）' : 'Dataset (optional)'}<Select value={datasetId} allowClear disabled={running}
          options={profiles.map(profile => ({ value: profile.id, label: profile.name }))} onChange={setDatasetId} /></label>
        <label>{zh ? '本次任务要求' : 'Task request'}<Input.TextArea value={request} maxLength={5000} rows={3} disabled={running}
          onChange={event => setRequest(event.target.value)} /></label>
        <div className="artifact-actions"><Button type="primary" disabled={running || !editor.name.trim()} onClick={() => {
          setStates({});
          void run({ workflow: editor, request, datasetId, token: crypto.randomUUID() }, update);
        }}>{zh ? '运行技能' : 'Run skill'}</Button>
          {running && <Button onClick={stop}>{t('stopTask')}</Button>}</div>
      </section> : <section className="panel extension-panel"><p className="muted">{zh ? '选择一个技能，或新建由多个步骤组成的技能。' : 'Choose a skill or create one with multiple steps.'}</p></section>}
    </div>
  </div>;
}
