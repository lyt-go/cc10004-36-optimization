/**
 * 画像分流增量影响域的公共类型。
 *
 * 设计要点：
 * - 画像按「版本」不可变保存，每次更新生成新版本，旧版本保留用于命中历史对照。
 * - 分流方案与画像按 profileId 绑定，命中记录按 (方案, 画像版本, 分层) 定位，
 *   只重算受影响分层，未受影响方案/分层复用旧命中与旧分流比例。
 * - 更新批次携带覆盖分层与批次序号，两个批次撞同一分层时由引擎统一仲裁，
 *   败者保留为历史，不产生重复人群与重复比例。
 */

/** 分层定义：区间为 [min, max] 的双闭区间，按分数字段 score 判定。 */
export type TierDef = {
  tierId: string
  tierName: string
  min: number
  max: number
}

/** 画像版本：一旦生成即不可变；current=true 的版本为当前生效版本。 */
export type ProfileVersion = {
  versionId: string
  /** 单调递增的版本号，数字越大越新。 */
  versionNo: number
  tierDefs: TierDef[]
  /** 该版本分层人群：tierId -> 用户标识列表，引擎按版本缓存，多方案共享不重算。 */
  tierUsers: Record<string, string[]>
  createdAt: string
  note: string
  current: boolean
}

/** 画像主实体：作废后保留全部版本与历史，只是不再参与新的分流。 */
export type ProfileDef = {
  profileId: string
  name: string
  scoreField: string
  status: '已发布' | '已作废'
  versions: ProfileVersion[]
}

/** 分流分组：权重为整数基点（1 基点 = 0.01%），避免浮点精度问题。 */
export type GroupDef = {
  groupId: string
  groupName: string
  /** 整数基点，全部权重之和必须等于 10000。 */
  weightBips: number
}

/** 分流方案：绑定画像与其中一个分层，白名单用户是该分层人群的候选集。 */
export type AbScheme = {
  schemeId: string
  name: string
  profileId: string
  tierId: string
  groups: GroupDef[]
  status: '已生效' | '已下线'
}

/** 单个分组在一次命中里的实际分配结果。 */
export type GroupAllocation = {
  groupId: string
  groupName: string
  /** 分配到该组的用户数。 */
  userCount: number
  /** 实际分流比例，整数基点。 */
  ratioBips: number
}

/**
 * 命中记录：方案 × 画像版本 × 分层 的一次快照。
 * superseded=true 表示已被新版本命中取代，仅作历史对照，不再是当前结果。
 */
export type HitRecord = {
  hitId: string
  schemeId: string
  profileId: string
  tierId: string
  tierName: string
  versionId: string
  versionNo: number
  /** 命中时的候选用户（分层人群），作废撤回后通过 withdrawn 标记，不删除记录。 */
  candidateUsers: string[]
  allocations: GroupAllocation[]
  /** 本次命中是否复用了上一版本的分流比例（未受影响分层不重算）。 */
  ratioReused: boolean
  /** 来源批次 id；种子初始化的首版命中为 'seed'。 */
  sourceBatchId: string
  superseded: boolean
  withdrawn: boolean
  createdAt: string
}

/** 更新批次的状态。 */
export type BatchStatus = '待仲裁' | '已应用' | '已被取代'

/** 画像更新批次：只描述覆盖到的分层，未覆盖分层不受影响。 */
export type UpdateBatch = {
  batchId: string
  profileId: string
  /** 批次序号：越大表示批次越新，同覆盖完整度时以序号新者为准。 */
  seq: number
  /** 本批次覆盖的分层 id；覆盖集合越完整，仲裁优先级越高。 */
  coveredTierIds: string[]
  targetVersionNo: number
  reason: string
  status: BatchStatus
  /** 仲裁结论说明，应用/被取代时写入。 */
  decisionNote: string
  createdAt: string
  appliedAt: string | null
  /** 应用后产生的新版本 id；未应用时为 null。 */
  producedVersionId: string | null
}

/** 画像重合度评估结果。 */
export type ProfileOverlap = {
  leftProfileId: string
  rightProfileId: string
  /** 重合分层对：分层名相同即视为同一业务分层。 */
  sharedTierNames: string[]
  /** Jaccard 重合系数，0~1，保留四位小数。 */
  jaccard: number
  /** jaccard >= OVERLAP_THRESHOLD 即判定为画像重合。 */
  overlapped: boolean
}

/** 整个画像分流域的持久化状态。 */
export type ProfileAbState = {
  /** 用户标识 -> 分数字段 -> 分数；不同画像可绑定不同分数字段。 */
  users: Record<string, Record<string, number>>
  profiles: ProfileDef[]
  schemes: AbScheme[]
  hits: HitRecord[]
  batches: UpdateBatch[]
  /** 自增序号，保证 id 与批次序号稳定。 */
  seq: { batch: number; hit: number; version: number }
}
