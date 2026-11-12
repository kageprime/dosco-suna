/**
 * The devices module's status and action surface. The pieces live in their own
 * modules (the status primitives cannot need the modals, and the actions menu
 * does); this file keeps their import path stable for the views.
 */
export {
  HealthNote,
  StatusDot,
  StatusLabel,
  useStatusText,
} from './device-status-label';
export { DeviceActionsMenu } from './device-actions-menu';
