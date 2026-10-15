import { describe, expect, it } from 'vitest';
import { createUsage } from '../src/usage.js';

describe('createUsage without a document', () => {
  it('is inert: a server-rendered docs site can construct it and call anything', () => {
    const usage = createUsage({ key: 'ld_test', logger: { warn: () => {} } });
    expect(() => {
      usage.page();
      usage.search('x');
      usage.setDimensions({ a: 'b' });
      usage.consent(true);
      usage.identify('u');
      usage.flush();
      usage.stop();
    }).not.toThrow();
  });
});
