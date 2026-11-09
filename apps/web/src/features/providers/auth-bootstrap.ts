import { rejectAfter } from '@/lib/deadline';

export function withAuthBootstrapTimeout<T>(request: Promise<T>, timeoutMs: number): Promise<T> {
  return rejectAfter(request, timeoutMs, `Authentication did not answer within ${timeoutMs} ms`);
}
