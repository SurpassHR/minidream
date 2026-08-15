import { useEffect, useState } from 'react';

// 角色路由：hash 形式 #/story-teller、#/object-designer、#/canvas（默认）
export type RoleRoute = 'story-teller' | 'object-designer' | 'canvas';

export function parseRoleRoute(hash: string): RoleRoute {
  if (hash === '#/story-teller') return 'story-teller';
  if (hash === '#/object-designer') return 'object-designer';
  return 'canvas';
}

export function useHashRoute(): RoleRoute {
  const [route, setRoute] = useState<RoleRoute>(() => parseRoleRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoleRoute(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
