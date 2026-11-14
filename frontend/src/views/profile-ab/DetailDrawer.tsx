import type { ReactNode } from 'react'

/**
 * 通用详情抽屉：由唯一的 selectedId 驱动开合，关闭即清空选中，
 * 避免同一条数据渲染出多个抽屉实例导致的「点不动 / 重复显示」。
 */
export default function DetailDrawer(props: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
}) {
  const { open, title, onClose, children } = props
  if (!open) {
    return null
  }
  return (
    <div className="drawer-mask" role="presentation" onClick={onClose}>
      <aside
        className="drawer-panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="drawer-head">
          <h3>{title}</h3>
          <button className="btn ghost" type="button" onClick={onClose}>关闭</button>
        </header>
        <div className="drawer-body">{children}</div>
      </aside>
    </div>
  )
}
