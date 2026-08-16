import type { ReactNode } from 'react';

// 角色页共享 UI 组件：story-teller / object-designer 统一视觉语言。
// 片场标签风格：mono 眉题 + 编号 + 状态徽章（延续全局 panel-title 的标签语言）。

// 角色页头：眉题（mono 标签）+ 标题 + 右侧 meta（计数/步骤信息）
export function RoleHeader(props: { eyebrow: string; title: string; meta?: ReactNode }) {
  return (
    <div className="role-head">
      <div className="role-head-main">
        <div className="role-eyebrow">{props.eyebrow}</div>
        <h1 className="role-title">{props.title}</h1>
      </div>
      {props.meta && <div className="role-head-meta">{props.meta}</div>}
    </div>
  );
}

// 统一卡片容器（表单/问题区）
export function RoleCard(props: { children: ReactNode; className?: string }) {
  return <div className={`role-card${props.className ? ` ${props.className}` : ''}`}>{props.children}</div>;
}

// 表单字段：mono 标签 + 控件 + 可选提示
export function Field(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="role-field">
      <span className="role-field-label">{props.label}</span>
      {props.children}
      {props.hint && <span className="role-field-hint">{props.hint}</span>}
    </label>
  );
}

// 状态徽章：ok（成功）/ warn（进行中）/ err（失败）/ dim（草稿）
export type BadgeTone = 'ok' | 'warn' | 'err' | 'dim';
export function StatusBadge(props: { tone: BadgeTone; children: ReactNode }) {
  return <span className={`role-badge tone-${props.tone}`}>{props.children}</span>;
}

// 空态：图标 + 文案 + 可选引导动作
export function EmptyState(props: { icon: string; text: string; action?: ReactNode }) {
  return (
    <div className="role-empty">
      <span className="role-empty-icon">{props.icon}</span>
      <span className="role-empty-text">{props.text}</span>
      {props.action}
    </div>
  );
}

// AI 辅助按钮（✨ 统一）：busy 时禁用并显示思考中
export function AiButton(props: { busy: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button className="btn-ghost role-ai-btn" disabled={props.busy} onClick={props.onClick}>
      {props.busy ? '⏳ 思考中…' : props.children}
    </button>
  );
}

// 错误条（表单校验失败 / 请求失败）；⚠ 图标独立 span，错误文本保持单元素（测试精确匹配）
export function ErrorBanner(props: { text: string }) {
  return (
    <div className="role-error" role="alert">
      <span className="role-error-icon">⚠</span>
      <span>{props.text}</span>
    </div>
  );
}

// 加载态（外层容器由调用方带 data-testid）
export function LoadingState() {
  return <div className="role-loading">加载中…</div>;
}
