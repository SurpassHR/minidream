import { useCallback, useEffect, useRef, useState } from 'react';
import { client } from '../api/client';
import type { StoryProgress } from '../types';
import { agentChat } from '../api/agent';
import { STORY_TELLER_SYSTEM } from './roles';

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
export function StoryTellerView(props: { projectName: string }) {
  const [story, setStory] = useState<StoryProgress>({ step: 0, answers: {}, completedAt: null });
  const [draft, setDraft] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const step = STORY_STEPS[Math.min(story.step, STORY_STEPS.length - 1)]!;
  const isLast = story.step === STORY_STEPS.length - 1;

  // 项目切换/挂载时加载进度
  useEffect(() => {
    let disposed = false;
    setLoaded(false);
    setError('');
    void client.getStory().then((s) => {
      if (disposed) return;
      setStory(s);
      setDraft(s.answers[STORY_STEPS[Math.min(s.step, STORY_STEPS.length - 1)]!.id] ?? '');
      setLoaded(true);
    }).catch(() => {
      if (!disposed) { setError('加载故事进度失败'); setLoaded(true); }
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
    const answersText = Object.entries(story.answers)
      .map(([id, v]) => `${STORY_STEPS.find((s) => s.id === id)?.question ?? id}：${v}`)
      .join('\n');
    const prompt = `${STORY_TELLER_SYSTEM}\n\n当前步骤问题：${step.question}\n已填写内容：\n${answersText || '（暂无）'}`;
    void agentChat(prompt, [], (chunk) => {
      setDraft((d) => d + chunk);
    }).catch(() => setError('AI 建议失败，请重试')).finally(() => setAiBusy(false));
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
      setSaved(true);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '完成失败，请重试');
    }
  };

  if (!loaded) return <div className="role-view" data-testid="story-teller-view"><div className="story-center">加载中…</div></div>;

  return (
    <div className="role-view story-view" data-testid="story-teller-view">
      <div className="story-head">
        <div className="story-title">故事向导 · 第 {story.step + 1}/{STORY_STEPS.length} 步</div>
        <div className="story-progress">
          {STORY_STEPS.map((s, i) => (
            <span key={s.id} className={`seg${i <= story.step ? ' done' : ''}${i === story.step ? ' cur' : ''}`} />
          ))}
        </div>
      </div>
      {story.completedAt && (
        <div className="story-banner">✅ 已完成 · 已生成故事文档进素材库（{new Date(story.completedAt).toLocaleString()}）</div>
      )}
      <div className="story-card">
        <div className="story-q">❓ {step.question}</div>
        <div className="story-hint">{step.hint}</div>
        <textarea
          className="ne-input story-answer" data-testid="story-answer"
          value={draft}
          placeholder="在这里填写…"
          onChange={(e) => { setDraft(e.target.value); persist(story, e.target.value); }}
          rows={6}
        />
        <div className="story-actions">
          <button className="btn-ghost" disabled={aiBusy} onClick={aiSuggest}>✨ AI 建议</button>
          <span className="story-save-hint">{saved ? '已保存 ✓' : ''}</span>
        </div>
        <div className="story-nav">
          <button className="btn-ghost" disabled={story.step === 0} onClick={() => void prev()}>← 上一步</button>
          {isLast ? (
            <button className="btn-primary" onClick={() => void complete()}>完成故事</button>
          ) : (
            <button className="btn-primary" onClick={() => void next()}>下一步 →</button>
          )}
        </div>
        {error && <div className="story-error">{error}</div>}
      </div>
    </div>
  );
}
