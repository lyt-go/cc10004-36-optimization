/**
 * 画像分流增量影响引擎的验收级断言脚本（Node 运行，无第三方依赖）。
 * 运行方式见 frontend/package.json 的 test:engine：
 *   tsc 输出到临时目录后用 node 执行本文件的编译产物。
 */

import {
  OVERLAP_THRESHOLD,
  activeHitOf,
  allocate,
  applyBatch,
  arbitrateOrder,
  buildNextVersion,
  evaluateOverlap,
  formatBips,
  getCurrentVersion,
  hashUserId,
  hitHistoryOf,
  voidProfile,
} from './engine'
import { buildSeedState } from './seed'
import type { ProfileAbState, UpdateBatch } from './types'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name} ${detail}`)
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function seedFresh(): ProfileAbState {
  return buildSeedState()
}

console.log('1) 种子数据基线')
{
  const state = seedFresh()
  const prof3 = state.profiles.find((p) => p.profileId === 'PROF-0003')!
  const v1 = getCurrentVersion(prof3)
  check('PROF-0003 v1 高活跃为 6 人', v1.tierUsers['T-HIGH'].length === 6)
  check('PROF-0003 v1 中活跃为 7 人', v1.tierUsers['T-MID'].length === 7)
  const hit1 = activeHitOf(state, 'ABGR-0001')!
  const hit3 = activeHitOf(state, 'ABGR-0003')!
  check('ABGR-0001 首版命中存在且未标记复用', hit1 && hit1.ratioReused === false)
  check('ABGR-0003 首版命中存在', Boolean(hit3))
  const sumBips = (hit: typeof hit1) => hit.allocations.reduce((s, a) => s + a.ratioBips, 0)
  check('比例基点之和恒为 10000', sumBips(hit1) === 10000 && sumBips(hit3) === 10000)
  check('每方案当前命中唯一', state.schemes.every((s) => state.hits.filter((h) => h.schemeId === s.schemeId && !h.superseded && !h.withdrawn).length === 1))
  check('预置两个待仲裁批次', state.batches.filter((b) => b.status === '待仲裁').length === 2)
}

console.log('2) 只调整 PROF-0003「高活跃」区间：ABGR-0001 重算，ABGR-0003 复用')
{
  const state = seedFresh()
  const before1 = activeHitOf(state, 'ABGR-0001')!
  const before3 = activeHitOf(state, 'ABGR-0003')!
  const before2 = activeHitOf(state, 'ABGR-0002')!

  // 先应用旧批次 BATCH-0001，应被更新的 BATCH-0002 仲裁击败
  const loseOutcome = applyBatch(state, 'BATCH-0001')
  check('旧批次仲裁落败且不产生数据', loseOutcome.applied === false)
  check('旧批次保留为历史', state.batches.find((b) => b.batchId === 'BATCH-0001')!.status === '已被取代')

  const outcome = applyBatch(state, 'BATCH-0002')
  check('新批次应用成功', outcome.applied === true)
  check('受影响方案仅 ABGR-0001', outcome.affectedSchemeIds.join() === 'ABGR-0001')
  check('同画像未覆盖分层的 ABGR-0003 进入复用清单', outcome.reusedSchemeIds.join() === 'ABGR-0003')

  const prof3 = state.profiles.find((p) => p.profileId === 'PROF-0003')!
  check('生成 v2 且 v1 不再 current', prof3.versions.length === 2 && getCurrentVersion(prof3).versionNo === 2)
  const v2 = getCurrentVersion(prof3)
  check('v2 高活跃重算为 9 人（U-007/8/9 升入）', v2.tierUsers['T-HIGH'].length === 9 && ['U-007', 'U-008', 'U-009'].every((u) => v2.tierUsers['T-HIGH'].includes(u)))
  check('v2 中活跃沿用 v1 快照 7 人（按当前分数重算只会剩 4 人，差异证明未重算）', v2.tierUsers['T-MID'].length === 7)
  check('v2 低活跃沿用 v1 快照 11 人', v2.tierUsers['T-LOW'].length === 11)

  const after1 = activeHitOf(state, 'ABGR-0001')!
  const after3 = activeHitOf(state, 'ABGR-0003')!
  const after2 = activeHitOf(state, 'ABGR-0002')!
  check('ABGR-0001 产生 v2 新命中且为重算', after1.versionNo === 2 && after1.ratioReused === false)
  check('ABGR-0001 候选变为 9 人', after1.candidateUsers.length === 9)
  check('ABGR-0001 仍只有一条当前命中（无残留重复）', state.hits.filter((h) => h.schemeId === 'ABGR-0001' && !h.superseded && !h.withdrawn).length === 1)
  check('ABGR-0003 仍是 v1 命中并标记复用', after3.hitId === before3.hitId && after3.ratioReused === false && after3.versionNo === 1)
  check('ABGR-0003 分流比例逐组未变', JSON.stringify(after3.allocations) === JSON.stringify(before3.allocations))
  check('ABGR-0002 完全未受影响（命中对象不变）', after2.hitId === before2.hitId)

  const history1 = hitHistoryOf(state, 'ABGR-0001')
  check('ABGR-0001 两个命中版本都可对照', history1.length === 2 && history1[0].versionNo === 2 && history1[1].versionNo === 1)
  check('旧 v1 命中被标记 superseded 但未删除', history1[1].superseded === true)
  check('新命中比例之和仍为 10000', after1.allocations.reduce((s, a) => s + a.ratioBips, 0) === 10000)
}

console.log('3) 仲裁规则：覆盖完整度优先于批次新旧')
{
  const state = seedFresh()
  // 构造：旧 seq 但覆盖两个分层 vs 新 seq 只覆盖一个分层
  state.seq.batch += 1
  const olderFull: UpdateBatch = {
    batchId: 'BATCH-X1', profileId: 'PROF-0003', seq: state.seq.batch,
    coveredTierIds: ['T-HIGH', 'T-MID'], targetVersionNo: 2, reason: '旧但覆盖全',
    status: '待仲裁', decisionNote: '', createdAt: new Date().toISOString(), appliedAt: null, producedVersionId: null,
  }
  state.seq.batch += 1
  const newerPartial: UpdateBatch = {
    batchId: 'BATCH-X2', profileId: 'PROF-0003', seq: state.seq.batch,
    coveredTierIds: ['T-HIGH'], targetVersionNo: 2, reason: '新但只覆盖一层',
    status: '待仲裁', decisionNote: '', createdAt: new Date().toISOString(), appliedAt: null, producedVersionId: null,
  }
  state.batches.push(olderFull, newerPartial)
  const ranking = arbitrateOrder([newerPartial, olderFull])
  check('完整度高的旧批次排第一', ranking[0].batchId === 'BATCH-X1')
  const outcome = applyBatch(state, 'BATCH-X2')
  check('新但覆盖少的批次落败', outcome.applied === false)
  check('败者状态为已被取代', newerPartial.status === '已被取代')
  const outcome2 = applyBatch(state, 'BATCH-X1')
  check('完整批次应用成功', outcome2.applied === true)
  check('完整批次同时重算两个方案', outcome2.affectedSchemeIds.sort().join() === 'ABGR-0001,ABGR-0003')
  check('败者全程未产生命中', state.hits.every((h) => h.sourceBatchId !== 'BATCH-X2'))
}

console.log('4) 画像作废：统一撤回候选，历史全部保留')
{
  const state = seedFresh()
  applyBatch(state, 'BATCH-0002') // 先制造 v2 与历史
  const totalHitsBefore = state.hits.length
  const result = voidProfile(state, 'PROF-0003')
  check('撤回命中数等于引用方案数', result.withdrawnHitIds.length === 2 && result.schemeIds.sort().join() === 'ABGR-0001,ABGR-0003')
  check('画像状态为已作废', state.profiles.find((p) => p.profileId === 'PROF-0003')!.status === '已作废')
  check('命中记录一条未删', state.hits.length === totalHitsBefore)
  check('两方案均无当前活跃命中', state.schemes.filter((s) => s.profileId === 'PROF-0003').every((s) => activeHitOf(state, s.schemeId) === undefined))
  check('历史版本仍可对照', state.profiles.find((p) => p.profileId === 'PROF-0003')!.versions.length === 2)
  check('待仲裁批次随作废关闭', state.batches.every((b) => b.profileId === 'PROF-0003' && b.status === '待仲裁' ? false : true))
  // 其它画像方案不受牵连
  check('PROF-0004 的 ABGR-0002 命中保持有效', Boolean(activeHitOf(state, 'ABGR-0002')))

  let threw = false
  try {
    applyBatch(clone(state), 'BATCH-0001')
  } catch {
    threw = true
  }
  check('作废画像不能再应用批次', threw)
}

console.log('5) 画像重合判断（Jaccard 阈值 0.6）')
{
  const state = seedFresh()
  const overlap = evaluateOverlap(state, 'PROF-0003', 'PROF-0004')
  // 24 与 16 人全集，交集 16，并集 24 -> 0.6667
  check('Jaccard 计算为 0.6667', overlap.jaccard === 0.6667, `实际 ${overlap.jaccard}`)
  check('超过阈值判定重合', overlap.overlapped === true && overlap.jaccard >= OVERLAP_THRESHOLD)
}

console.log('6) 小数精度：任意候选量下比例和为 100.00%，分配人数和等于候选数')
{
  const state = seedFresh()
  const scheme = state.schemes.find((s) => s.schemeId === 'ABGR-0001')!
  const scheme2 = state.schemes.find((s) => s.schemeId === 'ABGR-0002')!
  let allOk = true
  const oddDetails: string[] = []
  for (let n = 0; n <= 25; n += 1) {
    const users = Array.from({ length: n }, (_, i) => `U-T-${i}`)
    const allocs = allocate(scheme, users)
    const ratioSum = allocs.reduce((sum, item) => sum + item.ratioBips, 0)
    const userSum = allocs.reduce((sum, item) => sum + item.userCount, 0)
    if (userSum !== n || (n > 0 && ratioSum !== 10000) || (n === 0 && ratioSum !== 0)) {
      allOk = false
      oddDetails.push(`50/50 n=${n}: userSum=${userSum}, ratioSum=${ratioSum}`)
    }
  }
  // 再用 70/30 非等分权重验证最大余数法在奇数人数下也守恒
  for (let n = 1; n <= 20; n += 1) {
    const users = Array.from({ length: n }, (_, i) => `U-W-${i}`)
    const allocs = allocate(scheme2, users)
    const ratioSum = allocs.reduce((sum, item) => sum + item.ratioBips, 0)
    const userSum = allocs.reduce((sum, item) => sum + item.userCount, 0)
    if (userSum !== n || ratioSum !== 10000) {
      allOk = false
      oddDetails.push(`70/30 n=${n}: userSum=${userSum}, ratioSum=${ratioSum}`)
    }
  }
  check('穷举候选量 0~25 均满足人数守恒与比例和=10000', allOk, oddDetails.join('; '))
  check('百分比格式化保留两位小数', formatBips(3333) === '33.33%' && formatBips(10000) === '100.00%')
  check('用户哈希稳定可复现', hashUserId('U-007') === hashUserId('U-007'))
  void buildNextVersion

  // JSON 往返（模拟 localStorage 持久化）后无上界分层仍能正确落人，不允许出现 null 边界
  const roundTrip = JSON.parse(JSON.stringify(seedFresh())) as ProfileAbState
  const rtProfile = roundTrip.profiles.find((p) => p.profileId === 'PROF-0003')!
  const rtHighTier = getCurrentVersion(rtProfile).tierDefs.find((t) => t.tierId === 'T-HIGH')!
  check('无上界哨兵经 JSON 往返后仍是有效数字', typeof rtHighTier.max === 'number' && rtHighTier.max > 90)
  check('往返后高活跃人群仍为 6 人', getCurrentVersion(rtProfile).tierUsers['T-HIGH'].length === 6)
}

console.log('7) 未覆盖分层的人群缓存复用：同画像多方案共享一份分层人群')
{
  const state = seedFresh()
  applyBatch(state, 'BATCH-0002')
  const prof3 = state.profiles.find((p) => p.profileId === 'PROF-0003')!
  const v2 = getCurrentVersion(prof3)
  const hit1 = activeHitOf(state, 'ABGR-0001')!
  const hit3 = activeHitOf(state, 'ABGR-0003')!
  check('ABGR-0001 候选与 v2 高活跃缓存同源（同序同元素）', JSON.stringify(hit1.candidateUsers) === JSON.stringify(v2.tierUsers['T-HIGH']))
  check('ABGR-0003 候选与 v2 中活跃缓存同源', JSON.stringify(hit3.candidateUsers) === JSON.stringify(v2.tierUsers['T-MID']))
}

console.log(`\n结果：${passed} 通过，${failed} 失败`)
if (failed > 0) {
  process.exitCode = 1
}
