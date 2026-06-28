/// <reference types="vite/client" />

declare module 'virtual:build-info' {
  /** Short git commit of the build (suffixed `+` if the tree was dirty). */
  export const commit: string
  /** ISO timestamp stamped at build (or dev-server start). */
  export const buildTime: string
}
