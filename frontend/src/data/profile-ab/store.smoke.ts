/** store 层冒烟：用内存垫片模拟浏览器 localStorage，验证持久化与订阅。 */

const memory = new Map<string, string>()
globalThis.window = {
  localStorage: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
  },
} as unknown as Window & typeof globalThis

import { applyUpdateBatch, getState, resetProfileAb, subscribe, voidProfileById } from './store'

let notifications = 0
const unsubscribe = subscribe(() => {
  notifications += 1
})

const s1 = getState()
if (s1.batches.filter((b) => b.status === '待仲裁').length !== 2) {
  throw new Error('初始待仲裁批次数量错误')
}

const lose = applyUpdateBatch('BATCH-0001')
if (lose.ok) {
  throw new Error('旧批次不应仲裁胜出')
}
const win = applyUpdateBatch('BATCH-0002')
if (!win.ok || win.affectedSchemeIds.join() !== 'ABGR-0001' || win.reusedSchemeIds.join() !== 'ABGR-0003') {
  throw new Error('新批次影响范围不符合预期')
}

const persisted = JSON.parse(memory.get('data-product-ops:profile-ab') ?? '{}')
if (persisted.profiles.find((p: { profileId: string }) => p.profileId === 'PROF-0003').versions.length !== 2) {
  throw new Error('localStorage 未持久化新版本')
}

const voided = voidProfileById('PROF-0003')
if (!voided.ok || voided.withdrawnHitIds.length !== 2) {
  throw new Error('作废撤回数量错误')
}

const reset = resetProfileAb()
if (reset.batches.filter((b) => b.status === '待仲裁').length !== 2) {
  throw new Error('重置未回到种子状态')
}

unsubscribe()
if (notifications !== 4) {
  throw new Error(`订阅通知次数错误：${notifications}`)
}
console.log(`store 冒烟通过：${notifications} 次状态通知，持久化/仲裁/作废/重置均符合预期`)
