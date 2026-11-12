export type { BootMark } from '@kortix/api-contract/runtime-relay'
import type { BootMark } from '@kortix/api-contract/runtime-relay'

/** Mutable host boot state shared with the selected runtime. */
export interface SandboxBootState {
  timeline: BootMark[]
}
