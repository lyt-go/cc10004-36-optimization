/**
 * 画像分流域状态容器：localStorage 持久化 + 订阅发布。
 * 所有写操作都在本文件内完成深拷贝替换，保证 React 能稳定感知变更，
 * 也避免页面直接改缓存造成列表残留、重复渲染与详情数据对不上。
 */

import { applyBatch, voidProfile } from './engine'
import { buildSeedState } from './seed'
import type { ProfileAbState, UpdateBatch } from './types'

const STORAGE_KEY = 'data-product-ops:profile-ab'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readState(): ProfileAbState {
  if (typeof window === 'undefined' || !window.localStorage) {
    return buildSeedState()
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seed = buildSeedState()
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seed))
    return seed
  }
  try {
    return JSON.parse(raw) as ProfileAbState
  } catch {
    const seed = buildSeedState()
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seed))
    return seed
  }
}

let state: ProfileAbState = readState()
const listeners = new Set<() => void>()

function persist(next: ProfileAbState): void {
  state = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }
  for (const listener of listeners) {
    listener()
  }
}

export function getState(): ProfileAbState {
  return state
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function resetProfileAb(): ProfileAbState {
  const seed = buildSeedState()
  persist(seed)
  return seed
}

export type BatchOutcome = {
  ok: boolean
  message: string
  affectedSchemeIds: string[]
  reusedSchemeIds: string[]
}

/** 应用更新批次（内部含同分层冲突仲裁），返回仲裁与影响范围明细。 */
export function applyUpdateBatch(batchId: string): BatchOutcome {
  const next = clone(state)
  try {
    const result = applyBatch(next, batchId)
    persist(next)
    return {
      ok: result.applied,
      message: result.message,
      affectedSchemeIds: result.affectedSchemeIds,
      reusedSchemeIds: result.reusedSchemeIds,
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : '批次应用失败',
      affectedSchemeIds: [],
      reusedSchemeIds: [],
    }
  }
}

export type VoidOutcome = {
  ok: boolean
  message: string
  withdrawnHitIds: string[]
  schemeIds: string[]
}

/** 画像作废：撤回候选但保留全部历史。 */
export function voidProfileById(profileId: string): VoidOutcome {
  const next = clone(state)
  try {
    const result = voidProfile(next, profileId)
    persist(next)
    return {
      ok: true,
      message: `画像已作废，撤回 ${result.withdrawnHitIds.length} 条当前命中候选，历史版本与命中记录全部保留。`,
      withdrawnHitIds: result.withdrawnHitIds,
      schemeIds: result.schemeIds,
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : '画像作废失败',
      withdrawnHitIds: [],
      schemeIds: [],
    }
  }
}

/**
 * 登记一个新的画像更新批次。
 * 覆盖分层由页面勾选；新批次 seq 永远最大，参与下一次仲裁。
 */
export function createUpdateBatch(input: {
  profileId: string
  coveredTierIds: string[]
  reason: string
}): { ok: boolean; message: string; batchId?: string } {
  const next = clone(state)
  const profile = next.profiles.find((item) => item.profileId === input.profileId)
  if (!profile) {
    return { ok: false, message: '画像不存在，无法创建批次' }
  }
  if (profile.status !== '已发布') {
    return { ok: false, message: '画像已作废，不能再登记更新批次' }
  }
  const tierIds = new Set(profile.versions.find((v) => v.current)?.tierDefs.map((t) => t.tierId) ?? [])
  const covered = input.coveredTierIds.filter((tierId) => tierIds.has(tierId))
  if (covered.length === 0) {
    return { ok: false, message: '请至少选择一个受影响的分层区间' }
  }
  next.seq.batch += 1
  const batch: UpdateBatch = {
    batchId: `BATCH-${String(next.seq.batch).padStart(4, '0')}`,
    profileId: input.profileId,
    seq: next.seq.batch,
    coveredTierIds: covered,
    targetVersionNo: (profile.versions.find((v) => v.current)?.versionNo ?? 0) + 1,
    reason: input.reason.trim() || '画像分层区间更新',
    status: '待仲裁',
    decisionNote: '',
    createdAt: new Date().toISOString(),
    appliedAt: null,
    producedVersionId: null,
  }
  next.batches.push(batch)
  persist(next)
  return { ok: true, message: `批次 ${batch.batchId} 已登记，等待仲裁应用`, batchId: batch.batchId }
}
