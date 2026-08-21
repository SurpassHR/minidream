# 导演工作台 v2 — 进行中任务

> 更新：2026-08-22
> 背景：v2 复刻即梦「生成」页（https://jimeng.jianying.com/ai-tool/generate）为创作对话工作台。
> 已登录 playwright 浏览器（persistent profile: `~/.cache/ms-playwright/daemon/f238a65447b5103a/ud-orig-chrome`），
> 有一个「女孩森林遇发光鹿」视频生成任务曾在排队/生成中。

## 当前状态

✅ 已完成（本次 ComfyUI 对接改动尚未提交）：

1. **v1 封存**：`v1` 分支保存全部旧代码（117 提交）；`main` 分支从零重建
2. **页面复刻**（生成页）：Rail 76px / Sidebar 240px / 空状态标题 / 3 张热门技能卡 / Composer 994px 贴底
3. **去掉登录/账户元素**：rail 底部「登录/领积分」已移除
4. **Agent 模式下拉**：7 个创作类型选项，选中高亮+对勾
5. **自动 → 生成偏好面板**：图片/视频 + 9 种比例 + 图片 4.0
6. **使用技能面板**：搜索框 + 更多技能 + 4 个官方技能 + 创建/管理技能
7. **真实技能卡数据**：叙事短片导演分镜 / 系列套图生成 / 爆款电商短视频题材创意
8. **中间态聊天流程**：思考日志逐条 → 任务卡片(进度/排队/取消) → 完成态(积分/AI标识/建议按钮/重新生成)
9. **抓取数据存档**：`docs/scraped-generate-page.md`
10. **ComfyUI 对接（通用 workflow 运行器）**：直连本地/远程 ComfyUI 原生 API（零第三方 SDK），
    workflow introspection 自动适配输入（文字/图像/视频）、参数、输出（图片/视频/文本），
    SSE 实时进度 + 取消 + `/comfyui/view` 代理。详见 `docs/comfyui-integration.md`
11. **官方模板接入**：从 Comfy-Org/workflow_templates 拉取并跑通
    Krea 2（t2i / 风格参考）与 MiniMax H3（t2v / r2v / flf2v）5 个工作流，
    支持 UI 格式（LiteGraph）运行时转 API 格式（基于 /object_info），
    LoadImage 占位文件自动探测 → 缺失标记「必传」
12. **真实 ComfyUI 验证**（0.33.0 @ 127.0.0.1:55554）：SDXL 文生图真实出图
    （1024×1024，SSE 进度 + done 输出 + `/comfyui/view` 渲染）；Krea2 / MiniMax H3
    云端节点提交格式跑通（动态 combo 点号键 + `extra_data` 凭证注入，请求日志证实
    `X-API-KEY` 已发出），配置 `COMFY_API_KEY` 即可出图；无凭证时报友好错误

## 下一步

- [ ] 配置 `COMFY_API_KEY` 后跑通 Krea 2 / MiniMax H3 云端模板的真实生成
- [ ] 复刻「资产库」页面结构（rail 菜单跳转）
- [ ] 抓生成完成后的最终结果界面（播放器/图片墙/下载/收藏/编辑按钮）对照打磨结果卡片

## 运行方式

```bash
COMFYUI_BASE_URL=http://127.0.0.1:8188 pnpm dev   # 前后端一起（server 4777 + web 5173）
pnpm run build    # 生产构建
cd server && pnpm test   # workflow introspection 单测
```

## 已抓原页数据参考

- `docs/scraped-generate-page.md` — 完整抓取数据
- `docs/comfyui-integration.md` — ComfyUI 对接架构与自动适配机制说明
