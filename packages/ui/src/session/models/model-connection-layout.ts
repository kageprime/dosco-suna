'use client';

import { createContext } from 'react';

/** Only the first-chat home puts connection actions above its composer. */
export const ModelConnectionLayoutContext = createContext<'above' | 'below'>('below');
