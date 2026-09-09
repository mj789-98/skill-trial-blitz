/**
 * A missing type, not a missing function.
 *
 * `@firebase/auth` ships a react-native entry point that exports
 * `getReactNativePersistence`, and Metro resolves it — the function is really
 * there at runtime. TypeScript never sees it, because the package's exports map
 * lists a top-level `"types"` key BEFORE the `"react-native"` condition:
 *
 *   ".": {
 *     "types": "./dist/auth-public.d.ts",   <- matched first, resolution stops
 *     "react-native": { "types": "./dist/rn/index.rn.d.ts", ... },
 *   }
 *
 * So no tsconfig setting can reach the RN typings; `customConditions` is already
 * set and does not help. This AUGMENTS the module with the one declaration that
 * is missing, taken from `dist/rn/index.rn.d.ts`. The top-level import is what
 * makes it an augmentation rather than a replacement — without it, the block
 * below would declare a brand new module and hide every real export.
 *
 * The alternative was `as any` at the call site, which would have hidden the
 * same gap without explaining it. Delete this file when Firebase reorders those
 * keys.
 */

import type { Persistence } from 'firebase/auth';

declare module '@firebase/auth' {
  /** The subset of AsyncStorage that Firebase actually calls. */
  export interface ReactNativeAsyncStorage {
    setItem(key: string, value: string): Promise<void>;
    getItem(key: string): Promise<string | null>;
    removeItem(key: string): Promise<void>;
  }

  export function getReactNativePersistence(
    storage: ReactNativeAsyncStorage
  ): Persistence;
}
