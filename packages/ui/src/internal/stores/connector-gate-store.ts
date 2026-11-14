import { create } from 'zustand';

export interface ConnectorGateConnection {
  id: string;
  slug: string;
  name: string;
  authorization_strategy: 'project' | 'user';
}

/**
 * Drives the global connection gate. A failed session create opens this gate
 * with every missing connection. The gate retries the same
 * session create after all required connections are created.
 */
interface ConnectorGateState {
  isOpen: boolean;
  projectId: string | null;
  connectorConnections: ConnectorGateConnection[];
  /** Re-run the gated session-create after the connector is connected. */
  retry: (() => void) | null;
  openConnectorGate: (opts: {
    projectId: string;
    connectorConnections: ConnectorGateConnection[];
    retry: () => void;
    onCancel?: () => void;
  }) => void;
  closeConnectorGate: (retrying?: boolean) => void;
  onCancel?: () => void;
}

export const useConnectorGateStore = create<ConnectorGateState>((set, get) => ({
  isOpen: false,
  projectId: null,
  connectorConnections: [],
  retry: null,
  openConnectorGate: ({ projectId, connectorConnections, retry, onCancel }) => {
    const previousCancel = get().onCancel;
    set({ isOpen: true, projectId, connectorConnections, retry, onCancel });
    if (previousCancel !== onCancel) previousCancel?.();
  },
  closeConnectorGate: (retrying = false) => {
    const cancel = get().onCancel;
    set({ isOpen: false, projectId: null, connectorConnections: [], retry: null, onCancel: undefined });
    if (!retrying) cancel?.();
  },
}));
