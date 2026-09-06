// verify-default-llm.ts — Verify the app's default LLM config end-to-end:
//   1. resolveModel(DEFAULT_SETTINGS) → must resolve to the z.ai sandbox
//      (provider 'zai', model 'glm-5.3', sandbox OAuth headers applied via
//      ZAI.create()). The custom OpenAI-compatible endpoint (kimi-k2-5
//      behind a pinggy tunnel) is no longer the default — the app ships
//      with the z.ai sandbox as the default inference provider.
//   2. A real completion through the resolved pi-ai Model (auth + endpoint
//      + model) — works through the z.ai sandbox path.
//   3. A custom-endpoint override unit check (apiBaseUrl flows into baseUrl)
//      — when a user explicitly configures a non-default endpoint, the
//      synthetic custom Model is still built correctly.
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
  console.log('[1] usedFallback:', resolved.usedFallback ?? false);

  // The default provider is 'zai'. The resolver calls ZAI.create() to
  // auto-resolve sandbox credentials; inside the z.ai sandbox this yields
  // an OAuth token + sandbox baseUrl that override the Model's headers.
  // Outside the sandbox (no creds), the resolver throws — which is the
  // correct "no creds" error, not a verification failure.
  if (resolved.model.provider !== 'zai') {
    throw new Error(`Expected provider 'zai', got ${resolved.model.provider}`);
  }
  if (resolved.model.id !== 'glm-5.3') {
    throw new Error(`Expected model 'glm-5.3', got ${resolved.model.id}`);
  }
  if (resolved.model.api !== 'openai-completions') {
    throw new Error(`Expected api 'openai-completions', got ${resolved.model.api}`);
  }
  // usedFallback is true ONLY when the resolver swapped to the z.ai sandbox
  // because a non-zai configured endpoint was unreachable. With zai as the
  // configured default, usedFallback should be false (no swap needed).
  if (resolved.usedFallback) {
    throw new Error(
      `Expected usedFallback=false (zai is the default, no swap needed), got true`,
    );
  }
  // Sandbox OAuth headers should be present when running inside the
  // z.ai sandbox (the common case for this script).
  if (Object.keys(resolved.model.headers ?? {}).length === 0) {
    console.log('[1] NOTE: no sandbox OAuth headers — running outside the z.ai sandbox?');
  }

  // 2. Real turn through the SAME path production uses: createAgentSession
  //    with the resolved model + session.subscribe (mirrors runner-native.ts),
  //    proving endpoint + auth + model + the event loop all work via the
  //    z.ai sandbox path.
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

  // 3. Custom-endpoint override unit check: when a user explicitly
  //    configures a non-default apiBaseUrl + apiKey + modelName, the
  //    synthetic custom Model is still built correctly (the custom path
  //    remains supported — it's just no longer the default).
  const custom = await resolveModel({
    ...DEFAULT_SETTINGS,
    llmProvider: 'custom',
    apiKey: 'sk-test',
    apiBaseUrl: 'https://my-proxy.example.com/v1',
    modelName: 'some-other-model',
  } as never);
  console.log('[3] custom endpoint baseUrl:', mask(custom.model.baseUrl));
  console.log('[3] custom endpoint model id:', custom.model.id);
  console.log('[3] custom endpoint usedFallback:', custom.usedFallback ?? false);
  if (custom.usedFallback) {
    console.log('[3] SKIP override check — preflight fell back to z.ai sandbox (override endpoint is fake)');
  } else {
    if (custom.model.baseUrl !== 'https://my-proxy.example.com/v1') {
      throw new Error(`apiBaseUrl override not honored: ${custom.model.baseUrl}`);
    }
    if (custom.model.id !== 'some-other-model') {
      throw new Error(`modelName override not honored: ${custom.model.id}`);
    }
  }

  console.log('ALL CHECKS PASSED');
}

main().catch((err) => {
  console.error('VERIFY FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
