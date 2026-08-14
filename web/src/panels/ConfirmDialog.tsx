// 模态确认对话框：破坏性/确认操作的确认门；confirmLabel 可自定义确认按钮文案
// （生成提交用“确认提交”，删除/回滚/取消用默认“确认删除”）
export function ConfirmDialog(props: {
  open: boolean;
  title: string;
  body: string;
  onConfirm: () => void;
  onCancel: () => void;
  confirmLabel?: string;
}) {
  if (!props.open) return null;
  return (
    <div className="dialog-mask" onClick={props.onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">{props.title}</div>
        <div className="dialog-body">{props.body}</div>
        <div className="dialog-actions">
          <button className="btn-ghost" onClick={props.onCancel}>取消</button>
          <button className="btn-danger" onClick={props.onConfirm}>{props.confirmLabel ?? '确认删除'}</button>
        </div>
      </div>
    </div>
  );
}
