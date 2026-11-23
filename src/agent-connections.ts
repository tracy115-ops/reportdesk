import { useCallback, useRef, useState } from 'react';
import { agentCliDetails, codexStatus, errorCode, nativeDesktop } from './desktop';
import type { AgentCliDetails, AgentEngine, NativeAgent } from './desktop';
import { configuredModels, providerEngine, providerTarget, testProvider } from './provider-client';
import type { ProviderProfile } from './provider-client';

type CliConnection = { status: string; details?: AgentCliDetails };

export interface AgentConnection extends CliConnection {
  engine: AgentEngine;
  name: string;
  ready: boolean;
  profile?: ProviderProfile;
  modelId?: string;
}

export function useAgentConnections(profiles: ProviderProfile[] | undefined, unavailableName: string) {
  const [cli, setCli] = useState<Partial<Record<NativeAgent, CliConnection>>>({});
  const [providerCheck, setProviderCheck] = useState<{ profile: ProviderProfile; modelId: string; status: string }>();
  const checked = useRef(new Set<NativeAgent>());
  const pending = useRef(new Set<NativeAgent>());

  const checkCli = useCallback(async (engine: AgentEngine, refresh = false) => {
    if (!nativeDesktop || (engine !== 'codex' && engine !== 'claude') || pending.current.has(engine)
      || (!refresh && checked.current.has(engine))) return;
    pending.current.add(engine);
    setCli(previous => ({ ...previous, [engine]: { status: 'codex_checking' } }));
    try {
      const details = await agentCliDetails(engine).catch(() => undefined);
      const status = details?.status ?? await codexStatus(engine);
      setCli(previous => ({ ...previous, [engine]: { status, details } }));
    } catch {
      setCli(previous => ({ ...previous, [engine]: { status: 'codex_failed' } }));
    } finally {
      checked.current.add(engine);
      pending.current.delete(engine);
    }
  }, []);

  function resolve(engine: AgentEngine): AgentConnection {
    if (engine === 'codex' || engine === 'claude') {
      const connection = cli[engine];
      return { engine, name: engine === 'codex' ? 'Codex' : 'Claude Code', ready: nativeDesktop && connection?.status === 'codex_ready',
        status: nativeDesktop ? connection?.status ?? 'codex_checking' : 'codexBrowser', details: connection?.details };
    }
    const target = providerTarget(engine);
    const profile = profiles?.find(item => item.id === target.id);
    const modelId = target.modelId ?? profile?.textModel;
    if (nativeDesktop && profile && modelId && configuredModels(profile).includes(modelId)) {
      const check = providerCheck?.profile === profile && providerCheck.modelId === modelId ? providerCheck : undefined;
      return { engine: providerEngine(profile.id, modelId), name: modelId, ready: true,
        status: check?.status ?? 'provider_configured', profile, modelId };
    }
    return { engine, name: modelId ?? unavailableName, ready: false, profile, modelId,
      status: nativeDesktop ? profiles ? 'provider_model' : 'codex_checking' : 'codexBrowser' };
  }

  function recheck(engine: AgentEngine) {
    if (engine === 'codex' || engine === 'claude') {
      void checkCli(engine, true);
      return;
    }
    const { profile, modelId, status, ready } = resolve(engine);
    if (!ready || !profile || !modelId || status === 'codex_checking') return;
    const check = { profile, modelId, status: 'codex_checking' };
    setProviderCheck(check);
    void testProvider(profile.id, modelId).then(
      () => setProviderCheck(current => current === check ? { ...check, status: 'codex_ready' } : current),
      error => setProviderCheck(current => current === check ? { ...check, status: errorCode(error, 'provider_failed') } : current),
    );
  }

  return { resolve, checkCli, recheck };
}
