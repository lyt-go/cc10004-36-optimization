/**
 * 画像分流增量影响引擎（纯函数，不碰 localStorage / React，可被测试与页面共用）。
 *
 * 影响范围定位规则：
 * 1. 批次只携带覆盖的分层区间，应用时按 (profileId, 新版本, coveredTierIds)
 *    定位受影响分流方案：绑定该画像且命中分层在覆盖集合内的方案才重算。
 * 2. 未受影响方案完全不产生新命中记录，列表/详情继续展示旧命中与旧分流比例。
 * 3. 同一画像被多个方案共享时，分层人群按 (versionId, tierId) 只计算一次并缓存。
 *
 * 仲裁规则（两批次同时覆盖同一分层）：
 * - 覆盖完整度高（覆盖分层数多）的批次优先；
 * - 覆盖完整度相同，批次序号 seq 更大（版本更新）的优先；
 * - 败者批次标记「已被取代」并完整保留为历史，不产生任何人群/比例数据。
 *
 * 精度设计：
 * - 分流比例一律用整数基点 bips 存储（1 bips = 0.01%），全程不出现浮点累加；
 * - 按命中用户数用最大余数法（Hare Quota）把整数人数分到各组，比例由
 *   人数 × 10000 / 总人数 四舍五入得到，并把舍入残差补给最大余数组，
 *   保证各分组比例之和恒为 10000（展示即 100.00%）。
 * - 画像重合判断用当前版本分层人群的 Jaccard 系数，阈值 0.6000。
 */

import type {
  AbScheme,
  GroupAllocation,
  HitRecord,
  ProfileAbState,
  ProfileDef,
  ProfileOverlap,
  ProfileVersion,
  TierDef,
  UpdateBatch,
} from './types'

/** 画像重合判定阈值：Jaccard >= 0.6 视为重合。 */
export const OVERLAP_THRESHOLD = 0.6

/**
 * 无上界哨兵：JSON 不能序列化 Infinity（会变成 null 导致区间判断失效），
 * 统一用 MAX_SAFE_INTEGER 表示无上界，展示时格式化为 ∞。
 */
export const NO_UPPER_BOUND = Number.MAX_SAFE_INTEGER

/** 比例展示的小数位数（百分比），底层仍为整数基点。 */
export const RATIO_DECIMALS = 2

/** 分层上界展示：哨兵值显示为 ∞。 */
export function formatUpperBound(max: number): string {
  return max === NO_UPPER_BOUND ? '∞' : String(max)
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message)
  }
}

function nowText(): string {
  return new Date().toISOString()
}

/** bips 整数转百分比文本，如 2500 -> '25.00%'。 */
export function formatBips(bips: number): string {
  return `${(bips / 100).toFixed(RATIO_DECIMALS)}%`
}

/** 输入百分比文本转 bips（用于未来录入入口），非法时抛错。 */
export function parseBips(percentText: string): number {
  const value = Number(percentText.replace('%', '').trim())
  assert(Number.isFinite(value), '分流比例必须是数字')
  const bips = Math.round(value * 100)
  assert(bips >= 0 && bips <= 10000, '分流比例必须在 0%~100% 之间')
  return bips
}

export function getProfile(state: ProfileAbState, profileId: string): ProfileDef {
  const profile = state.profiles.find((item) => item.profileId === profileId)
  assert(Boolean(profile), `画像 ${profileId} 不存在`)
  return profile as ProfileDef
}

export function getScheme(state: ProfileAbState, schemeId: string): AbScheme {
  const scheme = state.schemes.find((item) => item.schemeId === schemeId)
  assert(Boolean(scheme), `分流方案 ${schemeId} 不存在`)
  return scheme as AbScheme
}

export function getCurrentVersion(profile: ProfileDef): ProfileVersion {
  const current = profile.versions.find((version) => version.current)
  assert(Boolean(current), `画像 ${profile.profileId} 没有当前生效版本`)
  return current as ProfileVersion
}

export function findVersion(profile: ProfileDef, versionId: string): ProfileVersion | undefined {
  return profile.versions.find((version) => version.versionId === versionId)
}

/** 取方案当前生效（未被取代、未撤回）的命中记录。 */
export function activeHitOf(state: ProfileAbState, schemeId: string): HitRecord | undefined {
  return state.hits.find(
    (hit) => hit.schemeId === schemeId && !hit.superseded && !hit.withdrawn,
  )
}

/** 取方案全部历史命中（含已被取代、已撤回），按版本号倒序。 */
export function hitHistoryOf(state: ProfileAbState, schemeId: string): HitRecord[] {
  return state.hits
    .filter((hit) => hit.schemeId === schemeId)
    .sort((a, b) => b.versionNo - a.versionNo || b.hitId.localeCompare(a.hitId))
}

/**
 * 按分层区间从全量用户里计算人群。
 * 区间为双闭区间 [min, max]；max 为 Infinity 表示无上界。
 * 分数取自画像绑定的分数字段 scoreField，不同画像互不干扰。
 */
export function evaluateTierUsers(
  users: Record<string, Record<string, number>>,
  scoreField: string,
  tier: TierDef,
): string[] {
  return Object.keys(users)
    .filter((userId) => {
      const score = users[userId]?.[scoreField]
      return typeof score === 'number' && score >= tier.min && score <= tier.max
    })
    .sort((a, b) => a.localeCompare(b))
}

/**
 * 生成画像新版本：未覆盖分层直接沿用上一版本的区间与人群，
 * 覆盖分层按当前用户分数字段重新落区间、重算人群。
 * 人群结果缓存在版本对象的 tierUsers 上，多个分流方案共享同一份，不重复生成。
 */
export function buildNextVersion(
  state: ProfileAbState,
  profile: ProfileDef,
  coveredTierIds: string[],
  note: string,
): ProfileVersion {
  const previous = getCurrentVersion(profile)
  const nextVersionNo = previous.versionNo + 1
  const covered = new Set(coveredTierIds)
  const tierUsers: Record<string, string[]> = {}

  for (const tier of previous.tierDefs) {
    tierUsers[tier.tierId] = covered.has(tier.tierId)
      ? evaluateTierUsers(state.users, profile.scoreField, tier)
      : [...previous.tierUsers[tier.tierId]]
  }

  return {
    versionId: `${profile.profileId}-v${nextVersionNo}`,
    versionNo: nextVersionNo,
    tierDefs: previous.tierDefs.map((tier) => ({ ...tier })),
    tierUsers,
    createdAt: nowText(),
    note,
    current: true,
  }
}

/**
 * 最大余数法：把 totalUsers 个用户按权重切成整数人数。
 * 权重为整数基点，之和固定 10000，分配人数之和必然等于 totalUsers。
 */
function apportionUsers(totalUsers: number, groups: AbScheme['groups']): number[] {
  if (totalUsers <= 0) {
    return groups.map(() => 0)
  }
  const exact = groups.map((group) => (totalUsers * group.weightBips) / 10000)
  const floors = exact.map((value) => Math.floor(value))
  let remainder = totalUsers - floors.reduce((sum, value) => sum + value, 0)
  // 余数按小数部分从大到小补 1；并列时按 groupId 稳定排序，避免结果抖动。
  const order = exact
    .map((value, index) => ({ index, frac: value - Math.floor(value), key: groups[index].groupId }))
    .sort((a, b) => b.frac - a.frac || a.key.localeCompare(b.key))
  const result = [...floors]
  for (const item of order) {
    if (remainder <= 0) {
      break
    }
    result[item.index] += 1
    remainder -= 1
  }
  return result
}

/**
 * 由实际分配人数反算整数基点比例，并把四舍五入残差补给人数最多的组，
 * 保证比例之和严格等于 10000，杜绝 99.99% / 100.01% 类漂移。
 */
function ratiosFromCounts(counts: number[], totalUsers: number): number[] {
  if (totalUsers <= 0) {
    return counts.map(() => 0)
  }
  const ratios = counts.map((count) => Math.round((count * 10000) / totalUsers))
  const drift = 10000 - ratios.reduce((sum, value) => sum + value, 0)
  if (drift !== 0) {
    // 残差补给人数最多（并列时索引最小）的组，规则稳定可复算。
    let target = 0
    for (let i = 1; i < counts.length; i += 1) {
      if (counts[i] > counts[target]) {
        target = i
      }
    }
    ratios[target] += drift
  }
  return ratios
}

/** 对一批候选用户执行一次分流命中，返回各组人数与实际比例。 */
export function allocate(
  scheme: AbScheme,
  candidateUsers: string[],
): GroupAllocation[] {
  const counts = apportionUsers(candidateUsers.length, scheme.groups)
  const ratios = ratiosFromCounts(counts, candidateUsers.length)
  return scheme.groups.map((group, index) => ({
    groupId: group.groupId,
    groupName: group.groupName,
    userCount: counts[index],
    ratioBips: ratios[index],
  }))
}

/** 稳定字符串哈希（FNV-1a 32 位），用于演示命中可复现，不参与比例计算。 */
export function hashUserId(userId: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < userId.length; i += 1) {
    hash ^= userId.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * 计算某方案在指定画像版本上的命中结果。
 * 若与上一活跃命中的候选用户完全一致，则直接复用旧比例（ratioReused=true），
 * 不再重新分配——未受影响分层据此保持原分流比例。
 */
function buildHit(
  state: ProfileAbState,
  scheme: AbScheme,
  version: ProfileVersion,
  tierName: string,
  sourceBatchId: string,
): HitRecord {
  const candidateUsers = version.tierUsers[scheme.tierId] ?? []
  const previous = activeHitOf(state, scheme.schemeId)
  const sameCandidates =
    previous !== undefined &&
    previous.candidateUsers.length === candidateUsers.length &&
    previous.candidateUsers.every((userId, index) => userId === candidateUsers[index])

  const allocations =
    sameCandidates && previous
      ? previous.allocations.map((item) => ({ ...item }))
      : allocate(scheme, candidateUsers)

  state.seq.hit += 1
  return {
    hitId: `HIT-${String(state.seq.hit).padStart(4, '0')}`,
    schemeId: scheme.schemeId,
    profileId: scheme.profileId,
    tierId: scheme.tierId,
    tierName,
    versionId: version.versionId,
    versionNo: version.versionNo,
    candidateUsers: [...candidateUsers],
    allocations,
    ratioReused: Boolean(sameCandidates && previous),
    sourceBatchId,
    superseded: false,
    withdrawn: false,
    createdAt: nowText(),
  }
}

/** 批次之间是否在同一画像的同一分层上冲突。 */
export function batchesConflict(left: UpdateBatch, right: UpdateBatch): boolean {
  if (left.profileId !== right.profileId || left.batchId === right.batchId) {
    return false
  }
  return left.coveredTierIds.some((tierId) => right.coveredTierIds.includes(tierId))
}

/**
 * 仲裁排序：覆盖完整度（覆盖分层数）降序，其次批次序号降序（版本较新者胜）。
 * 返回排序后的批次索引序列。
 */
export function arbitrateOrder(batches: UpdateBatch[]): UpdateBatch[] {
  return [...batches].sort((a, b) => {
    if (b.coveredTierIds.length !== a.coveredTierIds.length) {
      return b.coveredTierIds.length - a.coveredTierIds.length
    }
    return b.seq - a.seq
  })
}

/**
 * 应用一个画像更新批次：
 * 1. 校验批次存在且仍待仲裁；
 * 2. 与其它待仲裁批次做冲突仲裁，本批次落败则标记「已被取代」并原样保留；
 * 3. 胜出则生成新版本，仅对绑定该画像且命中覆盖分层的已生效方案重算命中；
 *    其它方案不产生任何记录，继续复用原比例；
 * 4. 同画像旧版本 current 置 false、旧命中置 superseded（历史保留）。
 * 返回应用结果说明（失败原因或受影响/复用方案明细）。
 */
export function applyBatch(state: ProfileAbState, batchId: string): {
  applied: boolean
  message: string
  affectedSchemeIds: string[]
  reusedSchemeIds: string[]
} {
  const batch = state.batches.find((item) => item.batchId === batchId)
  assert(Boolean(batch), `更新批次 ${batchId} 不存在`)
  assert((batch as UpdateBatch).status === '待仲裁', '该批次已处理，不能重复应用')

  const profile = getProfile(state, (batch as UpdateBatch).profileId)
  assert(profile.status === '已发布', `画像 ${profile.profileId} 已作废，不能再应用更新批次`)

  const rivals = state.batches.filter(
    (item) => item.status === '待仲裁' && item.batchId !== batchId,
  )
  const conflicts = rivals.filter((item) => batchesConflict(batch as UpdateBatch, item))
  const ranking = arbitrateOrder([batch as UpdateBatch, ...conflicts])
  const winner = ranking[0]

  if (winner.batchId !== batchId) {
    const target = batch as UpdateBatch
    target.status = '已被取代'
    target.decisionNote =
      `与批次 ${winner.batchId} 同时覆盖同一分层，对方覆盖 ${winner.coveredTierIds.length} 个分层` +
      `（本批次 ${target.coveredTierIds.length} 个）且批次更新，按完整度+版本仲裁由对方生效，本批次保留为历史。`
    return {
      applied: false,
      message: target.decisionNote,
      affectedSchemeIds: [],
      reusedSchemeIds: [],
    }
  }

  // 胜出：生成新版本（未覆盖分层人群原样沿用）。
  const previousVersion = getCurrentVersion(profile)
  const nextVersion = buildNextVersion(
    state,
    profile,
    (batch as UpdateBatch).coveredTierIds,
    (batch as UpdateBatch).reason,
  )
  state.seq.version += 1
  previousVersion.current = false
  profile.versions.push(nextVersion)

  const covered = new Set((batch as UpdateBatch).coveredTierIds)
  const tierNameById = new Map(nextVersion.tierDefs.map((tier) => [tier.tierId, tier.tierName]))
  const affectedSchemeIds: string[] = []
  const reusedSchemeIds: string[] = []

  for (const scheme of state.schemes) {
    if (scheme.profileId !== profile.profileId || scheme.status !== '已生效') {
      continue
    }
    if (!covered.has(scheme.tierId)) {
      // 未受影响方案：不生成新命中、不动旧比例，只登记到复用清单。
      reusedSchemeIds.push(scheme.schemeId)
      continue
    }
    const previousHit = activeHitOf(state, scheme.schemeId)
    if (previousHit) {
      previousHit.superseded = true
    }
    const hit = buildHit(
      state,
      scheme,
      nextVersion,
      tierNameById.get(scheme.tierId) ?? scheme.tierId,
      batchId,
    )
    state.hits.push(hit)
    affectedSchemeIds.push(scheme.schemeId)
  }

  const appliedBatch = batch as UpdateBatch
  appliedBatch.status = '已应用'
  appliedBatch.appliedAt = nowText()
  appliedBatch.producedVersionId = nextVersion.versionId
  appliedBatch.decisionNote =
    `已生成 ${nextVersion.versionId}，重算 ${affectedSchemeIds.length} 个受影响方案，` +
    `${reusedSchemeIds.length} 个未受影响方案复用原分流比例。` +
    (conflicts.length > 0
      ? ` 仲裁中击败批次：${conflicts.map((item) => item.batchId).join('、')}。`
      : '')

  // 冲突败者同时落为历史，避免它们之后再被应用造成重复人群。
  for (const loser of conflicts) {
    loser.status = '已被取代'
    loser.decisionNote =
      `与批次 ${batchId} 同时覆盖同一分层，对方仲裁优先级更高（覆盖完整度/批次版本），` +
      '本批次保留为历史，不产生分层人群与分流比例。'
  }

  return {
    applied: true,
    message: appliedBatch.decisionNote,
    affectedSchemeIds,
    reusedSchemeIds,
  }
}

/**
 * 画像作废：统一撤回引用该画像的全部当前候选（活跃命中 withdrawn=true），
 * 命中记录、版本与批次全部保留用于历史对照；方案本身不下线、不删除。
 */
export function voidProfile(
  state: ProfileAbState,
  profileId: string,
): { withdrawnHitIds: string[]; schemeIds: string[] } {
  const profile = getProfile(state, profileId)
  assert(profile.status === '已发布', `画像 ${profileId} 已是作废状态，无需重复作废`)
  profile.status = '已作废'
  for (const version of profile.versions) {
    version.current = false
  }
  const withdrawnHitIds: string[] = []
  const schemeIds: string[] = []
  for (const hit of state.hits) {
    if (hit.profileId === profileId && !hit.superseded && !hit.withdrawn) {
      hit.withdrawn = true
      withdrawnHitIds.push(hit.hitId)
      if (!schemeIds.includes(hit.schemeId)) {
        schemeIds.push(hit.schemeId)
      }
    }
  }
  // 待仲裁批次随画像作废一起关闭，防止对作废画像再应用。
  for (const batch of state.batches) {
    if (batch.profileId === profileId && batch.status === '待仲裁') {
      batch.status = '已被取代'
      batch.decisionNote = '画像已作废，批次随之中止，保留为历史。'
    }
  }
  return { withdrawnHitIds, schemeIds }
}

/**
 * 画像重合判断：对两份画像当前版本的全量分层人群求 Jaccard 系数。
 * J(A,B) = |A∩B| / |A∪B|；两份画像都无用户时系数记 0。
 */
export function evaluateOverlap(
  state: ProfileAbState,
  leftProfileId: string,
  rightProfileId: string,
): ProfileOverlap {
  const left = getProfile(state, leftProfileId)
  const right = getProfile(state, rightProfileId)
  const leftVersion = getCurrentVersion(left)
  const rightVersion = getCurrentVersion(right)
  const leftUsers = new Set(
    leftVersion.tierDefs.flatMap((tier) => leftVersion.tierUsers[tier.tierId] ?? []),
  )
  const rightUsers = new Set(
    rightVersion.tierDefs.flatMap((tier) => rightVersion.tierUsers[tier.tierId] ?? []),
  )
  let intersection = 0
  for (const userId of leftUsers) {
    if (rightUsers.has(userId)) {
      intersection += 1
    }
  }
  const union = leftUsers.size + rightUsers.size - intersection
  const jaccard = union === 0 ? 0 : Math.round((intersection / union) * 10000) / 10000
  const leftNames = new Set(leftVersion.tierDefs.map((tier) => tier.tierName))
  const sharedTierNames = rightVersion.tierDefs
    .map((tier) => tier.tierName)
    .filter((name) => leftNames.has(name))
  return {
    leftProfileId,
    rightProfileId,
    sharedTierNames,
    jaccard,
    overlapped: jaccard >= OVERLAP_THRESHOLD,
  }
}

/** 列出一份画像与其余画像的重合度（按系数倒序）。 */
export function profileOverlaps(
  state: ProfileAbState,
  profileId: string,
): ProfileOverlap[] {
  return state.profiles
    .filter((profile) => profile.profileId !== profileId && profile.status === '已发布')
    .map((profile) => evaluateOverlap(state, profileId, profile.profileId))
    .sort((a, b) => b.jaccard - a.jaccard)
}
