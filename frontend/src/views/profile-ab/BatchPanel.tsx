import { useMemo, useState } from 'react'

import { formatBips, formatUpperBound } from '@/data/profile-ab/engine'
import { applyUpdateBatch, createUpdateBatch } from '@/data/profile-ab/store'
import type { ProfileAbState, ProfileDef, UpdateBatch } from '@/data/profile-ab/types'

const STATUS_CLASS: Record<UpdateBatch['status'], string> = {
  待仲裁: 'tag tag-pending',
  已应用: 'tag tag-active',
  已被取代: 'tag tag-off',
}

/** 画像详情内的更新批次面板：登记批次、查看仲裁结论、应用并观察影响范围。 */
export default function BatchPanel(props: {
  profile: ProfileDef
  state: ProfileAbState
  onNotice: (ok: boolean, message: string) => void
}) {
  const { profile, state, onNotice } = props
  const currentVersion = profile.versions.find((version) => version.current)
  const [covered, setCovered] = useState<string[]>([])
  const [reason, setReason] = useState('')

  const batches = useMemo(
    () =>
      state.batches
        .filter((batch) => batch.profileId === profile.profileId)
        .sort((a, b) => b.seq - a.seq),
    [state.batches, profile.profileId],
  )

  function toggleTier(tierId: string) {
    setCovered((prev) =>
      prev.includes(tierId) ? prev.filter((id) => id !== tierId) : [...prev, tierId],
    )
  }

  function submitBatch() {
    const result = createUpdateBatch({
      profileId: profile.profileId,
      coveredTierIds: covered,
      reason,
    })
    onNotice(result.ok, result.message)
    if (result.ok) {
      setCovered([])
      setReason('')
    }
  }

  function applyOne(batch: UpdateBatch) {
    const outcome = applyUpdateBatch(batch.batchId)
    const detail = outcome.ok
      ? `${outcome.message} 受影响重算：${outcome.affectedSchemeIds.join('、') || '无'}；复用原比例：${outcome.reusedSchemeIds.join('、') || '无'}。`
      : outcome.message
    onNotice(outcome.ok, detail)
  }

  return (
    <section className="panel">
      <h4>画像更新批次（按分层区间登记，应用时自动仲裁）</h4>
      {profile.status === '已作废' ? (
        <p className="muted-text">画像已作废，不再接受新的更新批次；历史批次如下保留。</p>
      ) : (
        <div className="batch-form">
          <div className="tier-checks">
            {currentVersion?.tierDefs.map((tier) => (
              <label key={tier.tierId} className="check-item">
                <input
                  type="checkbox"
                  checked={covered.includes(tier.tierId)}
                  onChange={() => toggleTier(tier.tierId)}
                />
                <span>
                  {tier.tierName}（{tier.min}~{formatUpperBound(tier.max)}）
                </span>
              </label>
            ))}
          </div>
          <input
            className="batch-reason"
            placeholder="更新原因，例如：高活跃区间纳入新晋活跃用户"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <button className="btn primary" type="button" onClick={submitBatch}>
            登记更新批次
          </button>
        </div>
      )}

      <table className="data-table inner-table">
        <thead>
          <tr>
            <th>批次</th>
            <th>覆盖分层</th>
            <th>目标版本</th>
            <th>状态</th>
            <th>仲裁/应用结论</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {batches.map((batch) => {
            const tierNames = batch.coveredTierIds
              .map((tierId) => currentVersion?.tierDefs.find((tier) => tier.tierId === tierId)?.tierName ?? tierId)
              .join('、')
            return (
              <tr key={batch.batchId}>
                <td>{batch.batchId}<span className="muted-text"> #{batch.seq}</span></td>
                <td>{tierNames}</td>
                <td>v{batch.targetVersionNo}</td>
                <td><span className={STATUS_CLASS[batch.status]}>{batch.status}</span></td>
                <td className="note-cell">{batch.decisionNote || '—'}</td>
                <td>
                  {batch.status === '待仲裁' ? (
                    <button className="link" type="button" onClick={() => applyOne(batch)}>
                      仲裁并应用
                    </button>
                  ) : (
                    <span className="muted-text">已归档</span>
                  )}
                </td>
              </tr>
            )
          })}
          {batches.length === 0 && (
            <tr><td className="empty-state" colSpan={6}>暂无更新批次</td></tr>
          )}
        </tbody>
      </table>
      <p className="muted-text">
        仲裁规则：两个批次同时覆盖同一分层时，覆盖完整度高者优先；完整度相同则批次序号更新者优先，败者保留为历史且不产生任何分层人群与比例。比例以整数基点存储，展示 {formatBips(10000)} 精度且各组之和恒为 100.00%。
      </p>
    </section>
  )
}
