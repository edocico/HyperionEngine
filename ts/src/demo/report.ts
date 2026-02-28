// ts/src/demo/report.ts
import type { SectionReport, TestResult } from './types';

export interface DemoReport {
  engine: 'hyperion';
  timestamp: string;
  mode: string;
  userAgent: string;
  sections: Record<string, SectionReport>;
  summary: { total: number; pass: number; fail: number; skip: number };
}

export class ReportBuilder {
  private readonly sections = new Map<string, SectionReport>();

  constructor(
    private readonly mode: string,
    private readonly userAgent: string,
  ) {}

  addSection(name: string, report: SectionReport): void {
    this.sections.set(name, report);
  }

  build(): DemoReport {
    const allChecks: TestResult[] = [];
    const sections: Record<string, SectionReport> = {};
    for (const [name, report] of this.sections) {
      sections[name] = report;
      allChecks.push(...report.checks);
    }
    return {
      engine: 'hyperion',
      timestamp: new Date().toISOString(),
      mode: this.mode,
      userAgent: this.userAgent,
      sections,
      summary: {
        total: allChecks.length,
        pass: allChecks.filter(c => c.status === 'pass').length,
        fail: allChecks.filter(c => c.status === 'fail').length,
        skip: allChecks.filter(c => c.status === 'skip').length,
      },
    };
  }

  toJSON(): string {
    return JSON.stringify(this.build(), null, 2);
  }

  download(): void {
    const json = this.toJSON();
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const filename = `hyperion-report-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.json`;
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }
}
