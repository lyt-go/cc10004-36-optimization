import { useMemo, useState } from 'react'

import { downloadEntries } from '@/api/local-service'
import DetailDrawer from '@/views/profile-ab/DetailDrawer'
import { formatBips, hitHistoryOf } from '@/data/profile-ab/engine'
import { resetProfileAb } from '@/data/profile-ab/store'
import type { AbScheme, HitRecord } from '@/data/profile-ab/types'
import { useProfileAbState } from '@/data/profile-ab/use-profile-ab'

function hitBadge(hit: HitRecord | undefined): { text: string; className: string } {
  if (!hit) {
    return { text: '候选已撤回', className: 'tag tag-off' }
  }
  if (hit.withdrawn) {
    return { text: '已撤回（历史保留）', className: 'tag tag-off' }
  }
  return { text: hit.ratioReused ? '复用原比例' : '已重算', className: hit.ratioReused ? 'tag tag-active' : 'tag tag-pending' }
}

/**
 * 分流配置页（域驱动）。
 * 当前命中与历史命中均来自同一份 store，保证每个方案在列表只有一行、
 * 详情抽屉与列表数字一致；历史命中按版本倒序，可对照两个版本的比例变化。
 */
export default function AbgroupView() {
  const state = useProfileAbState()
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const schemes = useMemo(
    () => [...state.schemes].sort((a, b) => a.schemeId.localeCompare(b.schemeId)),
    [state.schemes],
  )
  const selected = schemes.find((scheme) => scheme.schemeId === selectedId) ?? null
  const selectedHistory = selected ? hitHistoryOf(state, selected.schemeId) : []

  function activeHit(scheme: AbScheme): HitRecord | undefined {
    return state.hits.find(
      (hit) => hit.schemeId === scheme.schemeId && !hit.superseded && !hit.withdrawn,
    )
  }

  function doReset() {
    resetProfileAb()
    setSelectedId(null)
  }

  return (
    <section className="page" data-module="abgroup">
      <header className="page-head">
        <div>
          <h2>分流配置管理</h2>
          <p className="page-desc">
            分流方案绑定画像分层；画像批次应用后仅重算受影响分层的命中，未受影响方案继续复用原分流比例，全部命中版本可追溯。
          </p>
        </div>
        <div className="page-actions">
          <button className="btn" type="button" onClick={() => downloadEntries('abgroup')}>
            导出分流配置清单
          </button>
          <button className="btn ghost" type="button" onClick={doReset}>重置演示数据</button>
        </div>
      </header>

      <div className="stat-row">
        <article className="stat-card">
          <span className="stat-label">分流方案</span>
          <strong className="stat-value">{schemes.length}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">当前有效命中</span>
          <strong className="stat-value">{state.hits.filter((h) => !h.superseded && !h.withdrawn).length}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">复用原比例命中</span>
          <strong className="stat-value">{state.hits.filter((h) => !h.superseded && !h.withdrawn && h.ratioReused).length}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">历史命中版本（含撤回）</span>
          <strong className="stat-value">{state.hits.length}</strong>
        </article>
      </div>

      <table className="data-table">
        <thead>
          <tr>
            <th>方案编号</th>
            <th>方案名称</th>
            <th>绑定画像 / 分层</th>
            <th>命中版本</th>
            <th>候选用户</th>
            <th>当前分流比例</th>
            <th>命中状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {schemes.map((scheme) => {
            const profile = state.profiles.find((p) => p.profileId === scheme.profileId)
            const hit = activeHit(scheme)
            const badge = hitBadge(hit)
            return (
              <tr
                key={scheme.schemeId}
                className="clickable-row"
                onClick={() => setSelectedId(scheme.schemeId)}
              >
                <td>{scheme.schemeId}</td>
                <td>{scheme.name}</td>
                <td>
                  {scheme.profileId}
                  <span className="muted-text"> / {hit?.tierName ?? scheme.tierId}</span>
                </td>
                <td>{hit ? `${hit.versionId}` : '—'}</td>
                <td>{hit ? `${hit.candidateUsers.length} 人` : '已撤回'}</td>
                <td>
                  {hit ? (
                    hit.allocations.map((alloc) => (
                      <span key={alloc.groupId} className="tier-chip">
                        {alloc.groupName} {formatBips(alloc.ratioBips)}（{alloc.userCount}人）
                      </span>
                    ))
                  ) : (
                    <span className="muted-text">候选撤回，比例冻结为历史</span>
                  )}
                </td>
                <td><span className={badge.className}>{badge.text}</span></td>
                <td className="row-actions" onClick={(event) => event.stopPropagation()}>
                  <button className="link" type="button" onClick={() => setSelectedId(scheme.schemeId)}>
                    命中详情
                  </button>
                </td>
              </tr>
            )
          })}
          {schemes.length === 0 && (
            <tr><td className="empty-state" colSpan={8}>暂无分流方案</td></tr>
          )}
        </tbody>
      </table>

      <DetailDrawer
        open={selected !== null}
        title={selected ? `分流命中详情 · ${selected.schemeId} ${selected.name}` : ''}
        onClose={() => setSelectedId(null)}
      >
        {selected && (
          <div className="detail-stack">
            <section className="panel">
              <h4>方案配置</h4>
              <ul className="kv-list">
                <li><span>绑定画像</span><strong>{selected.profileId}（{state.profiles.find((p) => p.profileId === selected.profileId)?.name ?? '—'}）</strong></li>
                <li><span>绑定分层</span><strong>{selected.tierId}</strong></li>
                <li><span>方案状态</span><strong>{selected.status}</strong></li>
                <li>
                  <span>配置权重</span>
                  <strong>{selected.groups.map((g) => `${g.groupName} ${formatBips(g.weightBips)}`).join(' / ')}</strong>
                </li>
              </ul>
            </section>

            <section className="panel">
              <h4>命中历史（按画像版本倒序，撤回与被取代记录均保留）</h4>
              {selectedHistory.map((hit) => (
                <article key={hit.hitId} className="hit-card">
                  <header>
                    <strong>{hit.versionId} · {hit.tierName}</strong>
                    {hit.withdrawn && <span className="tag tag-off">已撤回</span>}
                    {hit.superseded && !hit.withdrawn && <span className="tag tag-off">已被新版本取代</span>}
                    {!hit.superseded && !hit.withdrawn && <span className="tag tag-active">当前生效</span>}
                    {hit.ratioReused && <span className="tag tag-pending">复用原分流比例</span>}
                  </header>
                  <p className="muted-text">
                    命中编号 {hit.hitId} · 来源批次 {hit.sourceBatchId} · 候选 {hit.candidateUsers.length} 人
                  </p>
                  <table className="data-table inner-table">
                    <thead>
                      <tr><th>分组</th><th>分配人数</th><th>实际比例</th></tr>
                    </thead>
                    <tbody>
                      {hit.allocations.map((alloc) => (
                        <tr key={alloc.groupId}>
                          <td>{alloc.groupName}</td>
                          <td>{alloc.userCount}</td>
                          <td>{formatBips(alloc.ratioBips)}</td>
                        </tr>
                      ))}
                      <tr className="sum-row">
                        <td>合计</td>
                        <td>{hit.allocations.reduce((sum, item) => sum + item.userCount, 0)}</td>
                        <td>{formatBips(hit.allocations.reduce((sum, item) => sum + item.ratioBips, 0))}</td>
                      </tr>
                    </tbody>
                  </table>
                  <p className="muted-text user-cell">候选用户：{hit.candidateUsers.join('、') || '（空）'}</p>
                </article>
              ))}
              {selectedHistory.length === 0 && <p className="muted-text">暂无命中记录。</p>}
            </section>
          </div>
        )}
      </DetailDrawer>
    </section>
  )
}
