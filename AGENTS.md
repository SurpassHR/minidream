# AGENTS.md — 开发备忘

## ComfyUI 配置持久化

- 配置文件：`server/data/settings.json`（结构 `{ comfyui: { baseUrl: string } }`）
- 持久化模块：`server/src/settings.ts`，照搬 v1 会话存储的原子写方案（tmp + rename）
- 启动时从文件恢复 `COMFYUI_BASE_URL`，环境变量仍可覆盖
- `POST /api/settings/comfyui` 同时写文件 + 更新内存 + 清缓存 + 健康检查
- 不要使用 localhost 作为存储配置的手段
