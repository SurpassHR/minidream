import { useEffect, useState } from 'react';
import { client } from '../api/client';
import type { StoryProgress } from '../types';
import { ErrorBanner, LoadingState, RoleHeader } from './role-ui';
import { StoryChat } from './StoryChat';
import { ScriptViewer } from './ScriptViewer';

// story-teller 仅对话式：自由聊天 + 总结成稿入库（向导式已移除）。
// story 状态只需 completedAt（完成横幅/剧本栏）；answers 由总结成稿写入后端。
export function StoryTellerView(props: { projectName: string; prompts?: Record<string, string>; armorBreak?: string; armorBreakEnabled?: boolean }) {
  const [story, setStory] = useState<StoryProgress>({ step: 0, answers: {}, completedAt: null });
  const [md, setMd] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  // 项目切换/挂载时加载进度（completedAt + md）
  useEffect(() => {
    let disposed = false;
    setLoaded(false);
    setError('');
    void client.getStory().then(({ story: s, md: m }) => {
      if (disposed) return;
      setStory(s);
      setMd(m ?? null);
      setLoaded(true);
    }).catch(() => {
      if (!disposed) { setError('加载故事进度失败'); setLoaded(true); }
    });
    return () => { disposed = true; };
  }, [props.projectName]);

  // 对话式总结成稿：解析答案 → 写入 story.json → complete 入库 → 刷新完成状态
  const handleSummarized = (answers: Record<string, string>) => {
    void client.saveStory({ answers })
      .then(() => client.completeStory())
      .then((r) => {
        setStory(r.story);
        setMd(r.md);
        setSaved(true);
        setError('');
        setTimeout(() => setSaved(false), 1200);
      })
      .catch((err) => setError(err instanceof Error ? err.message : '总结入库失败'));
  };

  // 重新生成：清空进度与完成标记，回到未完成态（确认门防误触）
  const reset = () => {
    if (!window.confirm('重新生成将清空当前故事进度，确定？')) return;
    void client.resetStory().then((s) => {
      setStory(s);
      setMd(null);
      setError('');
    }).catch((err) => setError(err instanceof Error ? err.message : '重置失败'));
  };

  if (!loaded) {
    return <div className="role-view" data-testid="story-teller-view"><LoadingState /></div>;
  }

  return (
    // 仅对话式：chat-mode 布局常驻（高度受限，仅消息区滚动）
    <div className="role-view story-view chat-mode" data-testid="story-teller-view">
      <RoleHeader
        eyebrow="STORY TELLER"
        title="故事向导"
        meta={<span className="story-step-meta">自由对话 · 探索故事方向</span>}
      />
      <div className="story-layout">
        <div className="story-main">
          {story.completedAt && (
            <div className="story-banner">
              ✅ 已完成 · 已生成故事文档进素材库（{new Date(story.completedAt).toLocaleString()}）
              <button className="btn-ghost story-reset" onClick={reset}>重新生成</button>
            </div>
          )}
          <StoryChat
            projectName={props.projectName}
            completedAt={story.completedAt}
            onSummarized={handleSummarized}
            prompts={props.prompts}
            armorBreak={props.armorBreak}
            armorBreakEnabled={props.armorBreakEnabled}
          />
          {error && <ErrorBanner text={error} />}
        </div>
        {/* 右侧剧本栏：常驻；完成后以代码视图展示 buildStoryMarkdown 产物 */}
        <aside className="script-sidebar" data-testid="script-sidebar">
          <div className="panel-title">剧本 <span className="mini">story_{props.projectName || '未命名项目'}.md</span></div>
          {md ? (
            <ScriptViewer text={md} />
          ) : (
            <div className="script-empty">
              对话结束点击 ✨ 总结成稿后，
              剧本将在这里展示
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
