/**
 * Which sheet engine a subtree renders in.
 *
 * `KortixBottomSheetModal` renders the iOS native sheet (`NativeSheet`,
 * `native-sheet.tsx`) where the binary has it, and gorhom everywhere else.
 * gorhom's content parts (`BottomSheetScrollView`, `BottomSheetTextInput`,
 * `useBottomSheetInternal`, …) read gorhom's internal context and throw or
 * misbehave without it. The native sheet provides this context, so the parts
 * in `sheet-parts.tsx` render the plain React Native part inside it and the
 * gorhom part inside a gorhom sheet.
 *
 * Outside any native sheet the value is `null`.
 *
 * React-only, so a bun test loads it real without the sheet's native graph.
 */
import * as React from 'react';

export interface NativeSheetApi {
  /** Dismiss the native sheet this subtree renders in. */
  dismiss: () => void;
  /**
   * The colour the sheet draws its content on, or `null` on the iOS 26 system
   * glass (no colour to fade to: a pinned bar drops its fade there).
   */
  surface: string | null;
}

export const NativeSheetContext = React.createContext<NativeSheetApi | null>(null);

/** The native sheet this subtree renders in, or null (a gorhom sheet, or no sheet). */
export function useNativeSheet(): NativeSheetApi | null {
  return React.useContext(NativeSheetContext);
}
