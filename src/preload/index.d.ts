import type { FrapApi } from './index.ts'

declare global {
  interface Window {
    frap: FrapApi
  }
}

export {}
