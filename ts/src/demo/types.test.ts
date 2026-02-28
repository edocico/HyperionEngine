// ts/src/demo/types.test.ts
import { describe, it, expect } from 'vitest';
import type { DemoSection, TestResult, SectionReport } from './types';
import { createTestReporter } from './types';

describe('DemoSection types', () => {
  it('createTestReporter records pass/fail/skip', () => {
    const reporter = createTestReporter();
    reporter.check('quad grid', true, '25 entities');
    reporter.check('lines', false, 'missing');
    reporter.skip('msdf text', 'no atlas');
    const results = reporter.results();
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ name: 'quad grid', status: 'pass', detail: '25 entities' });
    expect(results[1]).toEqual({ name: 'lines', status: 'fail', detail: 'missing' });
    expect(results[2]).toEqual({ name: 'msdf text', status: 'skip', detail: 'no atlas' });
  });

  it('pending transitions to pass/fail', () => {
    const reporter = createTestReporter();
    reporter.pending('bloom');
    expect(reporter.results()[0].status).toBe('pending');
    reporter.check('bloom', true);
    expect(reporter.results()[0].status).toBe('pass');
  });

  it('sectionStatus computes overall status', () => {
    const reporter = createTestReporter();
    reporter.check('a', true);
    reporter.check('b', true);
    expect(reporter.sectionStatus()).toBe('pass');
    reporter.check('c', false);
    expect(reporter.sectionStatus()).toBe('fail');
  });

  it('sectionStatus is partial when mix of pass and skip', () => {
    const reporter = createTestReporter();
    reporter.check('a', true);
    reporter.skip('b', 'n/a');
    expect(reporter.sectionStatus()).toBe('partial');
  });
});
