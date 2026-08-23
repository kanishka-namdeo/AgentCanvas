// verify-default-llm.ts — Verify the app's default LLM config end-to-end:
//   1. resolveModel(DEFAULT_SETTINGS) → must resolve the custom OpenAI-compatible
//      endpoint (provider 'custom', model kimi-k2-5, pinggy baseUrl) via the
//      synthetic openai-completions Model
//   2. A real completion through the resolved pi-ai Model (auth + endpoint + model)
//   3. A custom-endpoint override unit check (apiBaseUrl flows into baseUrl)
// Run: bun run scripts/verify-default-llm.ts

import { resolveModel } from '../src/lib/agent/pi-ai-model-resolver';
import { DEFAULT_SETTINGS } from '../src/lib/settings/types';

function mask(url: string): string {
  return url.replace(/([?&](?:key|token)=)[^&]+/g, '$1***');
}

async function main() {
  // 1. Resolve with pure defaults (exactly what a fresh install uses).
  const resolved = await resolveModel(DEFAULT_SETTINGS as never);
  console.log('[1] resolved label:', resolved.label);
  console.log('[1] model.id:', resolved.model.id);
  console.log('[1] model.baseUrl:', mask(resolved.model.baseUrl));
  console.log('[1] model.provider:', resolved.model.provider);
  console.log('[1] model.api:', resolved.model.api);
  console.log('[1] sandbox headers present:', Object.keys(resolved.model.headers ?? {}));

  if (resolved.model.id !== 'kimi-k2-5') {
    throw new Error(`Expected model kimi-k2-5, got ${resolved.model.id}`);
  }
  if (resolved.model.provider !== 'custom') {
    throw new Error(`Expected provider custom, got ${resolved.model.provider}`);
  }
  if (resolved.model.api !== 'openai-completions') {
    throw new Error(`Expected api openai-completions, got ${resolved.model.api}`);
  }
  if (resolved.model.baseUrl !== 'https://irhnglwoxe.a.pinggy.link/v1') {
    throw new Error(`Expected baseUrl https://irhnglwoxe.a.pinggy.link/v1, got ${resolved.model.baseUrl}`);
  }
  const compatFlags = resolved.model.compat as unknown as
    | { thinkingFormat?: string; zaiToolStream?: boolean }
    | undefined;
  if (compatFlags?.thinkingFormat === 'zai' || compatFlags?.zaiToolStream) {
    throw new Error('Synthetic custom-endpoint model must not carry z.ai compat flags');
  }

  // 2. Real turn through the SAME path production uses: createAgentSession
  //    with the resolved model + session.subscribe (mirrors runner-native.ts),
  //    proving endpoint + auth + model + the event loop all work.
  const { createAgentSession, SessionManager, SettingsManager } = await import(
    '@earendil-works/pi-coding-agent'
  );
  const { session } = await createAgentSession({
    cwd: process.cwd(),
    model: resolved.model,
    modelRuntime: resolved.modelRuntime,
    thinkingLevel: 'low',
    noTools: 'all',
    sessionManager: SessionManager.inMemory(process.cwd()),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } } as never),
  });
  const chunks: string[] = [];
  const unsubscribe = session.subscribe((event: {
    type: string;
    assistantMessageEvent?: { type?: string; delta?: string; content?: string };
  }) => {
    const inner = event.assistantMessageEvent;
    if (event.type === 'message_update' && inner?.type === 'text_delta' && inner.delta) {
      chunks.push(inner.delta);
    }
  });
  await session.prompt('Reply with exactly: OK', { expandPromptTemplates: false });
  await new Promise((r) => setTimeout(r, 500)); // let trailing events land
  unsubscribe();
  const text = chunks.join('').trim();
  console.log('[2] completion via createAgentSession:', JSON.stringify(text.slice(0, 60)));
  if (!text) {
    throw new Error('Empty completion from agent session');
  }

  // 3. Custom-endpoint override unit check: apiBaseUrl must flow into baseUrl
  //    (and the model id into the synthetic Model), for non-default endpoints too.
  const custom = await resolveModel({
    ...DEFAULT_SETTINGS,
    apiKey: 'sk-test',
    apiBaseUrl: 'https://my-proxy.example.com/v1',
    modelName: 'some-other-model',
  } as never);
  console.log('[3] custom endpoint baseUrl:', custom.model.baseUrl);
  console.log('[3] custom endpoint model id:', custom.model.id);
  if (custom.model.baseUrl !== 'https://my-proxy.example.com/v1') {
    throw new Error(`apiBaseUrl override not honored: ${custom.model.baseUrl}`);
  }
  if (custom.model.id !== 'some-other-model') {
    throw new Error(`modelName override not honored: ${custom.model.id}`);
  }

  console.log('ALL CHECKS PASSED');
}

main().catch((err) => {
  console.error('VERIFY FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
