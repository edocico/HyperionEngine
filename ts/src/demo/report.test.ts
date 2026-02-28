// ts/src/demo/report.test.ts
import { describe, it, expect } from 'vitest';
import { ReportBuilder } from './report';

describe('ReportBuilder', () => {
  it('builds report JSON', () => {
    const builder = new ReportBuilder('B', 'test-agent');
    builder.addSection('primitives', {
      status: 'pass',
      checks: [
        { name: 'Quad grid', status: 'pass', detail: '25 entities' },
        { name: 'MSDF text', status: 'skip', detail: 'no atlas' },
      ],
    });
    builder.addSection('audio', {
      status: 'fail',
      checks: [
        { name: 'Load sound', status: 'fail', detail: 'fetch error' },
      ],
    });
    const report = builder.build();
    expect(report.engine).toBe('hyperion');
    expect(report.mode).toBe('B');
    expect(report.summary.total).toBe(3);
    expect(report.summary.pass).toBe(1);
    expect(report.summary.fail).toBe(1);
    expect(report.summary.skip).toBe(1);
  });

  it('toJSON returns valid JSON string', () => {
    const builder = new ReportBuilder('C', 'agent');
    const json = builder.toJSON();
    expect(() => JSON.parse(json)).not.toThrow();
  });
});
