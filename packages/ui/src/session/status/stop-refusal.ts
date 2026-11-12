/**
 * The composer hides Stop when `useSession().canStop` says no, so a refusal
 * only reaches here when that answer was stale. The server's own words are
 * what the toast says.
 *
 * The guard lives once in `@kortix/shared/session/stop-refusal`.
 */
export { NOT_TURN_PROMPTER, stopRefusalMessage } from '@kortix/shared/session/stop-refusal';
