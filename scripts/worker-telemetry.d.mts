export function isValidWorkerModel(value: unknown): value is string;
export function resolveWorkerModel(
  config: { model?: string },
  project?: { model?: string },
): string | undefined;
export function buildEngineArgs(engine: string, args: string[], model?: string): string[];
export function normalizeProviderEvent(
  engine: string,
  event: unknown,
): Record<string, unknown> | null;
export function parseProviderLine(engine: string, line: string): Record<string, unknown> | null;
export function parseRuntimeVersion(output: unknown): string | null;

export function classifyWorkerDiagnostic(text: unknown): { code: string; message: string } | null;
