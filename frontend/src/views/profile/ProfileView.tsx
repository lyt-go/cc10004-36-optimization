import { useMemo, useState } from 'react'

import { downloadEntries } from '@/api/local-service'
import DetailDrawer from '@/views/profile-ab/DetailDrawer'
import BatchPanel from '@/views/profile-ab/BatchPanel'
import {
  formatBips,
  formatUpperBound,
  profileOverlaps,
} from '@/data/profile-ab/engine'
import { resetProfileAb, voidProfileById } from '@/data/profile-ab/store'
import type { ProfileDef } from '@/data/profile-ab/types'
import { useProfileAbState } from '@/data/profile-ab/use-profile-ab'

/**
 * 用户画像页（域驱动）。
 * 列表与详情共用同一份 store 状态，行 key 固定为画像编号，从根上避免
 * 「列表报错 / 残留重复 / 详情点不开 / 数据对不上」。
 */
export default function ProfileView() {
  const state = useProfileAbState()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)

  const profiles = useMemo(
    () => [...state.profiles].sort((a, b) => a.profileId.localeCompare(b.profileId)),
    [state.profiles],
  )

  const selected = profiles.find((profile) => profile.profileId === selectedId) ?? null
  const overlaps = selected ? profileOverlaps(state, selected.profileId) : []

  function showNotice(ok: boolean, text: string) {
    setNotice({ ok, text })
  }

  function doVoid(profile: ProfileDef) {
    const outcome = voidProfileById(profile.profileId)
    showNotice(outcome.ok, outcome.message)
  }

  function doReset() {
    resetProfileAb()
    setSelectedId(null)
    showNotice(true, '画像分流域数据已重置为初始示例。')
  }

  return (
    <section className="page" data-module="profile">
      <header className="page-head">
        <div>
          <h2>用户画像管理</h2>
          <p className="page-desc">
            画像按版本不可变保存；更新批次只覆盖指定分层区间，分流命中按「画像版本 + 分层」增量重算，未受影响方案复用原比例。
          </p>
        </div>
        <div className="page-actions">
          <button className="btn" type="button" onClick={() => downloadEntries('profile')}>
            导出画像清单
          </button>
          <button className="btn ghost" type="button" onClick={doReset}>重置演示数据</button>
        </div>
      </header>

      <div className="stat-row">
        <article className="stat-card">
          <span className="stat-label">画像总数</span>
          <strong className="stat-value">{profiles.length}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">已发布</span>
          <strong className="stat-value">{profiles.filter((p) => p.status === '已发布').length}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">已作废（历史保留）</span>
          <strong className="stat-value">{profiles.filter((p) => p.status === '已作废').length}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">待仲裁批次</span>
          <strong className="stat-value">{state.batches.filter((b) => b.status === '待仲裁').length}</strong>
        </article>
      </div>

      {notice && (
        <p className={notice.ok ? 'notice-bar ok' : 'notice-text error-text'} role="status">
          {notice.text}
          <button className="link notice-close" type="button" onClick={() => setNotice(null)}>收起</button>
        </p>
      )}

      <table className="data-table">
        <thead>
          <tr>
            <th>画像编号</th>
            <th>画像名称</th>
            <th>分数字段</th>
            <th>当前版本</th>
            <th>分层区间（当前版本人群）</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {profiles.map((profile) => {
            const current = profile.versions.find((v) => v.current)
            return (
              <tr
                key={profile.profileId}
                className="clickable-row"
                onClick={() => setSelectedId(profile.profileId)}
              >
                <td>{profile.profileId}</td>
                <td>{profile.name}</td>
                <td>{profile.scoreField}</td>
                <td>{current ? current.versionId : '无生效版本'}</td>
                <td>
                  {(current?.tierDefs ?? []).map((tier) => (
                    <span key={tier.tierId} className="tier-chip">
                      {tier.tierName} {current?.tierUsers[tier.tierId]?.length ?? 0}人
                    </span>
                  ))}
                </td>
                <td>
                  <span className={profile.status === '已发布' ? 'tag tag-active' : 'tag tag-off'}>
                    {profile.status}
                  </span>
                </td>
                <td className="row-actions" onClick={(event) => event.stopPropagation()}>
                  <button className="link" type="button" onClick={() => setSelectedId(profile.profileId)}>
                    详情/批次
                  </button>
                  {profile.status === '已发布' && (
                    <button className="link danger" type="button" onClick={() => doVoid(profile)}>
                      作废画像
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
          {profiles.length === 0 && (
            <tr><td className="empty-state" colSpan={7}>暂无画像数据</td></tr>
          )}
        </tbody>
      </table>

      <DetailDrawer
        open={selected !== null}
        title={selected ? `画像详情 · ${selected.profileId} ${selected.name}` : ''}
        onClose={() => setSelectedId(null)}
      >
        {selected && (
          <div className="detail-stack">
            <section className="panel">
              <h4>版本与分层人群（旧版本只读保留，用于命中历史对照）</h4>
              {[...selected.versions].reverse().map((version) => (
                <article
                  key={version.versionId}
                  className={version.current ? 'version-card current' : 'version-card'}
                >
                  <header>
                    <strong>{version.versionId}</strong>
                    {version.current && <span className="tag tag-active">当前生效</span>}
                    <span className="muted-text">{version.note}</span>
                  </header>
                  <table className="data-table inner-table">
                    <thead>
                      <tr><th>分层</th><th>区间</th><th>人群（{version.tierUsers ? version.tierDefs.flatMap((t) => version.tierUsers[t.tierId] ?? []).length : 0} 人）</th></tr>
                    </thead>
                    <tbody>
                      {version.tierDefs.map((tier) => (
                        <tr key={tier.tierId}>
                          <td>{tier.tierName}</td>
                          <td>[{tier.min}, {formatUpperBound(tier.max)}]</td>
                          <td className="user-cell">{(version.tierUsers[tier.tierId] ?? []).join('、') || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </article>
              ))}
            </section>

            <BatchPanel
              profile={selected}
              state={state}
              onNotice={showNotice}
            />

            <section className="panel">
              <h4>画像重合判断（当前版本分层人群 Jaccard，阈值 0.6000）</h4>
              {overlaps.length === 0 && <p className="muted-text">没有可对比的其它已发布画像。</p>}
              {overlaps.map((item) => {
                const other = state.profiles.find((p) => p.profileId === item.rightProfileId)
                return (
                  <article key={item.rightProfileId} className="overlap-card">
                    <strong>{other?.name ?? item.rightProfileId}</strong>
                    <span className={item.overlapped ? 'tag tag-pending' : 'tag tag-active'}>
                      {item.overlapped ? '判定重合' : '未重合'}
                    </span>
                    <span className="muted-text">
                      Jaccard = {item.jaccard.toFixed(4)}；共有分层：{item.sharedTierNames.join('、') || '无'}
                    </span>
                  </article>
                )
              })}
            </section>

            <section className="panel">
              <h4>引用该画像的分流方案命中概览</h4>
              {state.schemes.filter((s) => s.profileId === selected.profileId).map((scheme) => {
                const hit = state.hits.find(
                  (h) => h.schemeId === scheme.schemeId && !h.superseded && !h.withdrawn,
                )
                return (
                  <article key={scheme.schemeId} className="overlap-card">
                    <strong>{scheme.schemeId} {scheme.name}</strong>
                    {hit ? (
                      <span className="muted-text">
                        {hit.versionId} · {hit.tierName} · 候选 {hit.candidateUsers.length} 人 ·
                        比例 {hit.allocations.map((a) => `${a.groupName} ${formatBips(a.ratioBips)}`).join(' / ')}
                        {hit.ratioReused && '（复用原比例）'}
                      </span>
                    ) : (
                      <span className="tag tag-off">候选已撤回，仅保留历史</span>
                    )}
                  </article>
                )
              })}
            </section>
          </div>
        )}
      </DetailDrawer>
    </section>
  )
}
