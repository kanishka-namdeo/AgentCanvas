// Probe pi-ai's static model catalog for the zai provider (and overall).
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

const rt = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
const zai = rt.getModels('zai');
console.log('=== zai catalog ===');
for (const m of zai) {
  console.log(`${m.id}  ctx=${m.contextWindow}  max=${m.maxTokens}  reasoning=${m.reasoning}  in=${m.input.join('+')}`);
}
console.log(`total zai models: ${zai.length}`);
const all = rt.getModels();
console.log(`total catalog models (all providers): ${all.length}`);
const providers = new Set(all.map((m) => m.provider));
console.log('providers in catalog:', [...providers].join(', '));
