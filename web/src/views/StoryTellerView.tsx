import { useCallback, useEffect, useRef, useState } from 'react';
import { client } from '../api/client';
import type { StoryProgress } from '../types';
import { agentChat } from '../api/agent';
import { resolvePrompt, withArmorBreak } from './roles';
import { AiButton, ErrorBanner, LoadingState, RoleCard, RoleHeader } from './role-ui';
import { StoryChat } from './StoryChat';
import { ScriptViewer } from './ScriptViewer';

// story-teller 向导步骤（镜像后端 src/story/steps.ts，前端渲染与校验用）
export const STORY_STEPS = [
  { id: 'theme', question: '故事主题是什么？', hint: '一句话主题（如「精灵与哥布林的战争与和解」）', required: true },
  { id: 'protagonist', question: '主角是谁？', hint: '身份、性格、目标', required: true },
  { id: 'support', question: '配角有哪些？', hint: '每个配角一句话（可留空）', required: false },
  { id: 'antagonist', question: '冲突来自哪里？', hint: '对手/障碍/内在矛盾', required: true },
  { id: 'scenes', question: '故事发生在哪些场景？', hint: '每个场景一句（可作为物体设计器的种子）', required: true },
  { id: 'ending', question: '结局如何？', hint: '开放/圆满/反转', required: true },
] as const;

// 防抖保存：输入停止 500ms 后 PUT
export function StoryTellerView(props: { projectName: string; prompts?: Record<string, string>; armorBreak?: string; armorBreakEnabled?: boolean }) {
  const [story, setStory] = useState<StoryProgress>({ step: 0, answers: {}, completedAt: null });
  const [draft, setDraft] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  // 剧本 md（buildStoryMarkdown 产物）：完成时由 GET/complete 响应写入，reset 清空
  const [md, setMd] = useState<string | null>(null);
  // 模式切换：向导式 / 对话式（localStorage 记住上次选择）
  const [mode, setMode] = useState<'wizard' | 'chat'>(() => {
    const savedMode = localStorage.getItem('dw:storyMode');
    return savedMode === 'chat' ? 'chat' : 'wizard';
  });
  const switchMode = (m: 'wizard' | 'chat') => {
    setMode(m);
    try { localStorage.setItem('dw:storyMode', m); } catch { /* 隐私模式等：仅本次会话生效 */ }
  };
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // AI 建议发起时的步骤 id：流式期间用户切步后丢弃过期 chunk（防污染新步骤草稿）
  const aiStepRef = useRef<string | null>(null);
  // 最新 step 的同步镜像：chunk 回调闭包中读取当前步骤（闭包捕获的 story 会过期）
  const stepRef = useRef(story.step);
  stepRef.current = story.step;
  const step = STORY_STEPS[Math.min(story.step, STORY_STEPS.length - 1)]!;
  const isLast = story.step === STORY_STEPS.length - 1;

  // 项目切换/挂载时加载进度
  useEffect(() => {
    let disposed = false;
    setLoaded(false);
    setError('');
    void client.getStory().then(({ story: s, md: m }) => {
      if (disposed) return;
      setStory(s);
      setMd(m ?? null);
      setDraft(s.answers[STORY_STEPS[Math.min(s.step, STORY_STEPS.length - 1)]!.id] ?? '');
      setLoaded(true);
    }).catch(() => {
      if (!disposed) {
        // GET 失败：清空剧本栏（切项目后不得残留上一项目已完成的 md）
        setMd(null);
        setError('加载故事进度失败');
        setLoaded(true);
      }
    });
    return () => {
      disposed = true;
      // 卸载/切项目时清防抖 timer：避免旧 timer 在切项目后把草稿写入新项目
      if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    };
  }, [props.projectName]);

  // 防抖自动保存草稿
  const persist = useCallback((nextStory: StoryProgress, nextDraft: string) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void client.saveStory({ answers: { [step.id]: nextDraft } }).then((s) => {
        // 不回退 step / completedAt：timer 响应可能晚于 goto/complete 的响应
        setStory((prev) => ({ ...s, step: Math.max(prev.step, s.step), completedAt: prev.completedAt ?? s.completedAt }));
        setSaved(true);
        setTimeout(() => setSaved(false), 1200);
      }).catch(() => setError('保存失败，请重试'));
    }, 500);
  }, [step.id]);

  // 立即保存当前草稿（清防抖 timer）：切步/完成前调用，避免草稿停留在 timer 里丢失。
  // 返回 true=保存成功（调用方据此决定是否继续切步/完成，避免失败后仍前进）
  const flushDraft = (nextDraft: string): Promise<boolean> => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    return client.saveStory({ answers: { [step.id]: nextDraft } }).then((s) => {
      setStory(s); setSaved(true);
      setTimeout(() => setSaved(false), 1200);
      return true;
    }).catch(() => { setError('保存失败，请重试'); return false; });
  };

  // 切换到某一步（保存 step 并加载该步草稿）
  const goto = (idx: number) => {
    const target = STORY_STEPS[Math.min(Math.max(idx, 0), STORY_STEPS.length - 1)]!;
    void client.saveStory({ step: idx }).then((s) => {
      setStory(s);
      setDraft(s.answers[target.id] ?? '');
      setError('');
    }).catch(() => setError('保存失败，请重试'));
  };

  // 下一步：先串行保存草稿（await），成功才切步——避免并发 PUT 响应乱序回退 step
  const next = async () => {
    if (step.required && !draft.trim()) {
      setError('请填写后再继续');
      return;
    }
    setError('');
    const ok = await flushDraft(draft);
    if (ok) goto(story.step + 1);
  };

  // 上一步：与 next 对称，先保存当前草稿再切步
  const prev = async () => {
    const ok = await flushDraft(draft);
    if (ok) goto(story.step - 1);
  };

  const aiSuggest = () => {
    setAiBusy(true);
    aiStepRef.current = step.id; // 记录发起步骤：切步后其 chunk 不再写入
    const answersText = Object.entries(story.answers)
      .map(([id, v]) => `${STORY_STEPS.find((s) => s.id === id)?.question ?? id}：${v}`)
      .join('\n');
    const prompt = withArmorBreak(
      `${resolvePrompt(props.prompts, 'storyTeller')}\n\n当前步骤问题：${step.question}\n已填写内容：\n${answersText || '（暂无）'}`,
      props.armorBreak,
      props.armorBreakEnabled,
    );
    void agentChat(prompt, [], (chunk) => {
      // 流式期间用户已切步（当前步骤 ≠ 发起步骤）：丢弃过期 chunk
      const curStepId = STORY_STEPS[Math.min(stepRef.current, STORY_STEPS.length - 1)]!.id;
      if (aiStepRef.current !== curStepId) return;
      setDraft((d) => d + chunk);
    }).catch(() => setError('AI 建议失败，请重试')).finally(() => {
      setAiBusy(false);
      aiStepRef.current = null;
    });
  };

  const complete = async () => {
    if (step.required && !draft.trim()) { setError('请填写后再继续'); return; }
    setError('');
    // 先清防抖 timer 并立即保存最后一步草稿；保存失败则中止（不调 completeStory）
    const ok = await flushDraft(draft);
    if (!ok) return;
    try {
      // 用 complete 返回值更新（含 completedAt），不额外 GET
      const r = await client.completeStory();
      setStory(r.story);
      setMd(r.md);
      setSaved(true);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '完成失败，请重试');
    }
  };

  // 重新生成：清空进度与完成标记，回到第一步（确认门防误触）
  const reset = () => {
    if (!window.confirm('重新生成将清空当前故事进度，确定？')) return;
    void client.resetStory().then((s) => {
      setStory(s);
      setMd(null);
      setDraft('');
      setError('');
    }).catch((err) => setError(err instanceof Error ? err.message : '重置失败'));
  };

  // 对话式总结成稿：解析答案 → 写入 story.json → complete 入库 → 刷新完成状态（留在对话式）
  const handleSummarized = (answers: Record<string, string>) => {
    void client.saveStory({ answers })
      .then(() => client.completeStory())
      .then((r) => {
        setStory(r.story);
        setMd(r.md);
        setSaved(true);
        setError('');
      })
      .catch((err) => setError(err instanceof Error ? err.message : '总结入库失败'));
  };

  if (!loaded) {
    return <div className="role-view" data-testid="story-teller-view"><LoadingState /></div>;
  }

  return (
    // 对话式（chat-mode）：高度受限布局，仅消息区内部滚动（输入行/按钮行固定底部）
    <div className={`role-view story-view${mode === 'chat' ? ' chat-mode' : ''}`} data-testid="story-teller-view">
      <RoleHeader
        eyebrow="STORY TELLER"
        title="故事向导"
        meta={
          // 第几步是向导式（问卷）的概念：对话式无步骤，meta 显示模式提示
          mode === 'wizard'
            ? <span className="story-step-meta">第 {story.step + 1}/{STORY_STEPS.length} 步</span>
            : <span className="story-step-meta">自由对话 · 探索故事方向</span>
        }
      />
      <div className="story-layout">
        <div className="story-main">
          {/* 模式切换：向导式 / 对话式 */}
          <div className="role-mode-tabs" role="tablist" aria-label="向导模式">
            <button
              type="button"
              className={`role-mode-tab${mode === 'wizard' ? ' active' : ''}`}
              data-testid="mode-wizard"
              onClick={() => switchMode('wizard')}
            >⬡ 向导式</button>
            <button
              type="button"
              className={`role-mode-tab${mode === 'chat' ? ' active' : ''}`}
              data-testid="mode-chat"
              onClick={() => switchMode('chat')}
            >✦ 对话式</button>
          </div>
          {mode === 'chat' ? (
            <StoryChat
              projectName={props.projectName}
              completedAt={story.completedAt}
              onSummarized={handleSummarized}
              prompts={props.prompts}
              armorBreak={props.armorBreak}
              armorBreakEnabled={props.armorBreakEnabled}
            />
          ) : (
            <>
              {/* 场记板步骤轨道：编号可点击跳转；完成=ok 绿+✓；当前=amber 发光 */}
              <div className="story-track" role="tablist" aria-label="向导步骤">
                {STORY_STEPS.map((s, i) => {
                  const done = i < story.step;
                  const cur = i === story.step;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      className={`track-seg${done ? ' done' : ''}${cur ? ' cur' : ''}`}
                      title={`${s.question}${s.required ? '' : '（可留空）'}`}
                      onClick={() => goto(i)}
                    >
                      <span className="track-no">{String(i + 1).padStart(2, '0')}</span>
                      <span className="track-mark">{done ? '✓' : cur ? '●' : ''}</span>
                    </button>
                  );
                })}
              </div>
              {story.completedAt && (
                <div className="story-banner">
                  ✅ 已完成 · 已生成故事文档进素材库（{new Date(story.completedAt).toLocaleString()}）
                  <button className="btn-ghost story-reset" onClick={reset}>重新生成</button>
                </div>
              )}
              <RoleCard className="story-card">
                <div className="story-q">❓ {step.question}</div>
                <div className="story-hint">{step.hint}</div>
                <textarea
                  className="ne-input story-answer" data-testid="story-answer"
                  value={draft}
                  placeholder="在这里填写…"
                  disabled={Boolean(story.completedAt)}
                  onChange={(e) => { setDraft(e.target.value); persist(story, e.target.value); }}
                  rows={6}
                />
                <div className="story-actions">
                  <AiButton busy={aiBusy} disabled={Boolean(story.completedAt)} onClick={aiSuggest}>✨ AI 建议</AiButton>
                  <span className="story-save-hint">{saved ? '已保存 ✓' : ''}</span>
                </div>
                <div className="story-nav">
                  <button className="btn-ghost" disabled={story.step === 0 || Boolean(story.completedAt)} onClick={() => void prev()}>← 上一步</button>
                  {isLast ? (
                    <button className="btn-primary" disabled={Boolean(story.completedAt)} onClick={() => void complete()}>完成故事</button>
                  ) : (
                    <button className="btn-primary" disabled={Boolean(story.completedAt)} onClick={() => void next()}>下一步 →</button>
                  )}
                </div>
              </RoleCard>
            </>
          )}
          {/* 错误横幅：对话式 / 向导式共用（提升到模式条件之外，避免 chat 模式静默失败） */}
          {error && <ErrorBanner text={error} />}
        </div>
        {/* 右侧剧本栏：常驻；完成后以代码视图展示 buildStoryMarkdown 产物 */}
        <aside className="script-sidebar" data-testid="script-sidebar">
          <div className="panel-title">剧本 <span className="mini">story_{props.projectName || '未命名项目'}.md</span></div>
          {md ? (
            <ScriptViewer text={md} />
          ) : (
            <div className="script-empty">
              对话结束点击 ✨ 总结成稿（或向导完成故事）后，
              剧本将在这里展示
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
