import { useSyncExternalStore } from 'react'

import { getState, subscribe } from './store'
import type { ProfileAbState } from './types'

/** 订阅画像分流域状态，store 每次写入都是整体替换，引用变化即重渲染。 */
export function useProfileAbState(): ProfileAbState {
  return useSyncExternalStore(subscribe, getState, getState)
}
