// ts/src/demo/types.ts
import type { Hyperion } from '../hyperion';

export interface TestResult {
  name: string;
  status: 'pass' | 'fail' | 'skip' | 'pending';
  detail?: string;
}

export type SectionStatus = 'not-run' | 'pass' | 'fail' | 'partial';

export interface SectionReport {
  status: SectionStatus;
  checks: TestResult[];
}

export interface TestReporter {
  check(name: string, passed: boolean, detail?: string): void;
  skip(name: string, reason: string): void;
  pending(name: string): void;
  reset(): void;
  results(): TestResult[];
  sectionStatus(): SectionStatus;
}

export interface DemoSection {
  readonly name: string;
  readonly label: string;
  setup(engine: Hyperion, reporter: TestReporter): Promise<void>;
  teardown(engine: Hyperion): void;
}

export function createTestReporter(): TestReporter {
  const results: TestResult[] = [];

  return {
    check(name: string, passed: boolean, detail?: string) {
      const existing = results.find(r => r.name === name);
      const entry: TestResult = { name, status: passed ? 'pass' : 'fail', detail };
      if (existing) {
        Object.assign(existing, entry);
      } else {
        results.push(entry);
      }
    },
    skip(name: string, reason: string) {
      const existing = results.find(r => r.name === name);
      if (existing) {
        Object.assign(existing, { status: 'skip' as const, detail: reason });
      } else {
        results.push({ name, status: 'skip', detail: reason });
      }
    },
    pending(name: string) {
      const existing = results.find(r => r.name === name);
      if (existing) {
        Object.assign(existing, { status: 'pending' as const, detail: undefined });
      } else {
        results.push({ name, status: 'pending' });
      }
    },
    reset() {
      results.length = 0;
    },
    results() {
      return results;
    },
    sectionStatus(): SectionStatus {
      if (results.length === 0) return 'not-run';
      const hasAnyFail = results.some(r => r.status === 'fail');
      if (hasAnyFail) return 'fail';
      const hasSkipOrPending = results.some(r => r.status === 'skip' || r.status === 'pending');
      const hasPass = results.some(r => r.status === 'pass');
      if (hasPass && hasSkipOrPending) return 'partial';
      if (hasPass) return 'pass';
      return 'partial';
    },
  };
}
