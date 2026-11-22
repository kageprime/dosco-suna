'use client';

import { createContext } from 'react';

/** Only the first-chat home puts connection actions above its composer. */
export const ModelConnectionLayoutContext = createContext<'above' | 'below'>('below');

/**
 * The project whose dismissible `SubscriptionOffer` the composer shows when it
 * has a model. Only project home provides it. The composer is then the one
 * owner of the connect rows: its `ModelConnectionBar` shows the no-model rows
 * or the offer, never both.
 */
export const SubscriptionOfferContext = createContext<string | null>(null);
