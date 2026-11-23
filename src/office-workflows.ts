import type { AgentEngine } from './desktop';

export const stepKinds = ['draft', 'report', 'docx', 'pptx', 'html', 'pdf', 'png', 'mp3', 'mp4', 'mcp'] as const;
export type WorkflowKind = typeof stepKinds[number];
export interface WorkflowStep { id: string; kind: WorkflowKind; instructions: string; server?: string; tool?: string; continueOnError?: boolean }
export interface OfficeWorkflow { id: string; name: string; triggers: string; steps: WorkflowStep[] }
export interface WorkflowRun { workflow: OfficeWorkflow; datasetId?: string; request: string; token: string; engine?: AgentEngine }
export interface WorkflowStepResult { text: string; files?: string[] }
type StepState = 'pending' | 'running' | 'ok' | 'failed' | 'skipped';
export type StepUpdate = (id: string, state: StepState, text?: string) => void;

export function validWorkflows(value: unknown): value is OfficeWorkflow[] {
  const object = (entry: unknown): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry));
  const string = (entry: unknown, limit: number) => typeof entry === 'string' && entry.length <= limit;
  return Array.isArray(value) && value.length <= 48 && value.every(workflow => object(workflow)
    && string(workflow.id, 80) && Boolean(workflow.id) && string(workflow.name, 80) && Boolean(workflow.name)
    && string(workflow.triggers, 500) && Array.isArray(workflow.steps) && workflow.steps.length > 0 && workflow.steps.length <= 10
    && workflow.steps.every(step => object(step) && string(step.id, 80) && Boolean(step.id)
      && stepKinds.includes(step.kind as WorkflowKind) && string(step.instructions, 3500)
      && (step.server === undefined || string(step.server, 100)) && (step.tool === undefined || string(step.tool, 200))
      && (step.continueOnError === undefined || typeof step.continueOnError === 'boolean')));
}

export function matchingWorkflows(workflows: OfficeWorkflow[], request: string) {
  const normalize = (text: string) => text.normalize('NFKC').trim().toLowerCase();
  const prompt = normalize(request);
  return workflows.filter(workflow => workflow.triggers.split(/[\n,，]/).some(value => {
    const trigger = normalize(value);
    return trigger.length >= 2 && prompt.includes(trigger);
  }));
}

export function expandWorkflow(text: string, request: string, prior: string) {
  return text.replace(/\{\{(input|previous)\}\}/g, (_match, key) => key === 'input' ? request : prior);
}

export function workflowArguments(template: string, request: string, prior: string): Record<string, unknown> {
  function expand(value: unknown): unknown {
    if (typeof value === 'string') return expandWorkflow(value, request, prior);
    if (Array.isArray(value)) return value.map(expand);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, expand(entry)]));
    return value;
  }
  const parsed: unknown = JSON.parse(template || '{}');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw 'workflow_mcp';
  return expand(parsed) as Record<string, unknown>;
}

export async function runWorkflow(run: WorkflowRun, execute: (step: WorkflowStep, previous: string) => Promise<WorkflowStepResult>,
  update: StepUpdate, signal: AbortSignal) {
  let previous = '';
  let blocked = false;
  const outputs: string[] = [];
  for (const step of run.workflow.steps) {
    if (signal.aborted || blocked) { update(step.id, 'skipped'); continue; }
    update(step.id, 'running');
    try {
      const result = await execute(step, previous);
      previous = result.text || previous;
      if (result.files) outputs.push(...result.files);
      update(step.id, 'ok', result.text);
    } catch (error) {
      update(step.id, 'failed', typeof error === 'string' ? error : 'workflow_failed');
      blocked = !step.continueOnError;
    }
  }
  return outputs;
}
