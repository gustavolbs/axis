import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PROVIDER_CAPABILITY_IDS,
  negotiateEffectiveCapabilities,
  providerModelCapabilityOffer
} from '../src/agent-runtime/index.js';
import type { ProviderCapabilities } from '../src/providers/types.js';

const provider: ProviderCapabilities = {
  modelDiscovery: true,
  streaming: true,
  structuredOutput: true,
  reasoning: true,
  promptCaching: true,
  toolUse: true
};

test('model capability overrides narrow provider defaults in one canonical offer', () => {
  const offer = providerModelCapabilityOffer('connection:model', provider, {
    capabilities: {
      toolUse: false,
      promptCaching: false,
      reasoning: true
    }
  });

  assert.ok(offer.ids.includes(PROVIDER_CAPABILITY_IDS.streaming));
  assert.ok(offer.ids.includes(PROVIDER_CAPABILITY_IDS.structuredOutput));
  assert.ok(offer.ids.includes(PROVIDER_CAPABILITY_IDS.reasoning));
  assert.equal(offer.ids.includes(PROVIDER_CAPABILITY_IDS.toolUse), false);
  assert.equal(offer.ids.includes(PROVIDER_CAPABILITY_IDS.promptCaching), false);
});

test('provider/admin restriction can explicitly block an otherwise offered model capability', () => {
  const offer = providerModelCapabilityOffer('connection:model', provider);
  const effective = negotiateEffectiveCapabilities({
    offers: [offer],
    restrictions: [{
      source: 'provider-admin',
      deny: {
        [PROVIDER_CAPABILITY_IDS.toolUse]: 'disabled by provider policy'
      }
    }]
  });

  assert.equal(effective.entries[PROVIDER_CAPABILITY_IDS.reasoning]?.available, true);
  assert.equal(effective.entries[PROVIDER_CAPABILITY_IDS.toolUse]?.available, false);
  assert.deepEqual(
    effective.entries[PROVIDER_CAPABILITY_IDS.toolUse]?.blockedBy,
    ['provider-admin: disabled by provider policy']
  );
});
