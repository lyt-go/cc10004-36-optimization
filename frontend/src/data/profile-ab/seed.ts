/**
 * 画像分流域的示例数据。
 *
 * 场景设定（与验收口径一致）：
 * - PROF-0003「活跃度画像」按「活跃得分」分高/中/低活跃三层，被 ABGR-0001（高活跃）
 *   与 ABGR-0003（中活跃）两个方案共享；PROF-0004「付费意愿画像」被 ABGR-0002 引用。
 * - v1 分层人群是历史快照；当前用户分数里 U-007/U-008/U-009 已升入高活跃，
 *   但只有覆盖「高活跃」区间的批次才会重算该层，中活跃保持 v1 人群与原比例。
 * - 预置两个同时覆盖高活跃层的待仲裁批次：BATCH-0002 批次更新，仲裁胜出。
 */

import { allocate, NO_UPPER_BOUND } from './engine'
import type {
  AbScheme,
  HitRecord,
  ProfileAbState,
  ProfileDef,
  ProfileVersion,
  UpdateBatch,
} from './types'

function iso(text: string): string {
  return new Date(text).toISOString()
}

/** 当前用户分数：活跃得分已反映最新快照，付费意愿分仅 16 个用户有值。 */
function buildUsers(): Record<string, Record<string, number>> {
  const activity: Array<[string, number]> = [
    ['U-001', 85], ['U-002', 92], ['U-003', 88], ['U-004', 95], ['U-005', 81], ['U-006', 90],
    ['U-007', 83], ['U-008', 86], ['U-009', 80],
    ['U-010', 75], ['U-011', 66], ['U-012', 58], ['U-013', 52],
    ['U-014', 45], ['U-015', 30], ['U-016', 49], ['U-017', 20], ['U-018', 12],
    ['U-019', 38], ['U-020', 42], ['U-021', 18], ['U-022', 25], ['U-023', 33], ['U-024', 8],
  ]
  const willingness: Array<[string, number]> = [
    ['U-001', 78], ['U-002', 90], ['U-003', 72], ['U-010', 85], ['U-014', 71],
    ['U-004', 50], ['U-005', 66], ['U-011', 44], ['U-015', 60], ['U-016', 48],
    ['U-006', 30], ['U-012', 25], ['U-013', 35], ['U-007', 18], ['U-008', 22], ['U-009', 39],
  ]
  const users: Record<string, Record<string, number>> = {}
  for (const [userId, score] of activity) {
    users[userId] = { 活跃得分: score }
  }
  for (const [userId, score] of willingness) {
    users[userId] = { ...users[userId], 付费意愿分: score }
  }
  return users
}

const PROF3_TIERS = [
  { tierId: 'T-HIGH', tierName: '高活跃', min: 80, max: NO_UPPER_BOUND },
  { tierId: 'T-MID', tierName: '中活跃', min: 50, max: 79 },
  { tierId: 'T-LOW', tierName: '低活跃', min: 0, max: 49 },
]

const PROF4_TIERS = [
  { tierId: 'T-W-HIGH', tierName: '高意愿', min: 70, max: NO_UPPER_BOUND },
  { tierId: 'T-W-MID', tierName: '中意愿', min: 40, max: 69 },
  { tierId: 'T-W-LOW', tierName: '低意愿', min: 0, max: 39 },
]

function range(prefix: string, from: number, to: number): string[] {
  const result: string[] = []
  for (let i = from; i <= to; i += 1) {
    result.push(`${prefix}-${String(i).padStart(3, '0')}`)
  }
  return result
}

function buildProfiles(): ProfileDef[] {
  const version3: ProfileVersion = {
    versionId: 'PROF-0003-v1',
    versionNo: 1,
    tierDefs: PROF3_TIERS.map((tier) => ({ ...tier })),
    // v1 历史快照：U-007/U-008/U-009 当时仍在中活跃层。
    tierUsers: {
      'T-HIGH': range('U', 1, 6),
      'T-MID': range('U', 7, 13),
      'T-LOW': range('U', 14, 24),
    },
    createdAt: iso('2026-10-01T09:00:00'),
    note: '首次发布版本',
    current: true,
  }
  const version4: ProfileVersion = {
    versionId: 'PROF-0004-v1',
    versionNo: 1,
    tierDefs: PROF4_TIERS.map((tier) => ({ ...tier })),
    tierUsers: {
      'T-W-HIGH': ['U-001', 'U-002', 'U-003', 'U-010', 'U-014'],
      'T-W-MID': ['U-004', 'U-005', 'U-011', 'U-015', 'U-016'],
      'T-W-LOW': ['U-006', 'U-007', 'U-008', 'U-009', 'U-012', 'U-013'],
    },
    createdAt: iso('2026-10-02T09:00:00'),
    note: '首次发布版本',
    current: true,
  }
  return [
    {
      profileId: 'PROF-0003',
      name: '活跃度画像',
      scoreField: '活跃得分',
      status: '已发布',
      versions: [version3],
    },
    {
      profileId: 'PROF-0004',
      name: '付费意愿画像',
      scoreField: '付费意愿分',
      status: '已发布',
      versions: [version4],
    },
  ]
}

function buildSchemes(): AbScheme[] {
  return [
    {
      schemeId: 'ABGR-0001',
      name: '首页推荐分流实验',
      profileId: 'PROF-0003',
      tierId: 'T-HIGH',
      groups: [
        { groupId: 'G-CTL', groupName: '对照组', weightBips: 5000 },
        { groupId: 'G-EXP-A', groupName: '实验组A', weightBips: 5000 },
      ],
      status: '已生效',
    },
    {
      schemeId: 'ABGR-0002',
      name: '付费引导实验',
      profileId: 'PROF-0004',
      tierId: 'T-W-HIGH',
      groups: [
        { groupId: 'G-CTL', groupName: '对照组', weightBips: 7000 },
        { groupId: 'G-EXP-C', groupName: '实验组C', weightBips: 3000 },
      ],
      status: '已生效',
    },
    {
      schemeId: 'ABGR-0003',
      name: '弹窗灰度方案',
      profileId: 'PROF-0003',
      tierId: 'T-MID',
      groups: [
        { groupId: 'G-CTL', groupName: '对照组', weightBips: 6000 },
        { groupId: 'G-EXP-B', groupName: '实验组B', weightBips: 4000 },
      ],
      status: '已生效',
    },
  ]
}

function buildBatches(): UpdateBatch[] {
  return [
    {
      batchId: 'BATCH-0001',
      profileId: 'PROF-0003',
      seq: 1,
      coveredTierIds: ['T-HIGH'],
      targetVersionNo: 2,
      reason: '高活跃阈值例行校准（先提交的旧批次）',
      status: '待仲裁',
      decisionNote: '',
      createdAt: iso('2026-11-10T10:00:00'),
      appliedAt: null,
      producedVersionId: null,
    },
    {
      batchId: 'BATCH-0002',
      profileId: 'PROF-0003',
      seq: 2,
      coveredTierIds: ['T-HIGH'],
      targetVersionNo: 2,
      reason: '高活跃区间纳入新晋活跃用户 U-007/U-008/U-0009',
      status: '待仲裁',
      decisionNote: '',
      createdAt: iso('2026-11-12T10:00:00'),
      appliedAt: null,
      producedVersionId: null,
    },
  ]
}

/** 用引擎的分配函数生成 v1 首版命中，保证种子数据与线上算法口径一致。 */
function buildSeedHits(state: ProfileAbState): HitRecord[] {
  const hits: HitRecord[] = []
  for (const scheme of state.schemes) {
    const profile = state.profiles.find((item) => item.profileId === scheme.profileId) as ProfileDef
    const version = profile.versions.find((item) => item.current) as ProfileVersion
    const tier = version.tierDefs.find((item) => item.tierId === scheme.tierId)
    const candidateUsers = version.tierUsers[scheme.tierId] ?? []
    state.seq.hit += 1
    hits.push({
      hitId: `HIT-${String(state.seq.hit).padStart(4, '0')}`,
      schemeId: scheme.schemeId,
      profileId: scheme.profileId,
      tierId: scheme.tierId,
      tierName: tier?.tierName ?? scheme.tierId,
      versionId: version.versionId,
      versionNo: version.versionNo,
      candidateUsers: [...candidateUsers],
      allocations: allocate(scheme, candidateUsers),
      ratioReused: false,
      sourceBatchId: 'seed',
      superseded: false,
      withdrawn: false,
      createdAt: version.createdAt,
    })
  }
  return hits
}

export function buildSeedState(): ProfileAbState {
  const state: ProfileAbState = {
    users: buildUsers(),
    profiles: [],
    schemes: buildSchemes(),
    hits: [],
    batches: buildBatches(),
    seq: { batch: 2, hit: 0, version: 1 },
  }
  state.profiles = buildProfiles()
  state.hits = buildSeedHits(state)
  return state
}
