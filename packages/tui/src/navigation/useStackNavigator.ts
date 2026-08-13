import { useState, useCallback, useMemo } from 'react';
import type { Route, RouteName, Routes, Navigator } from './types.js';

export function useStackNavigator(initialRoute: Route): Navigator {
  const [stack, setStack] = useState<Route[]>([initialRoute]);

  const route = stack[stack.length - 1];

  const push = useCallback(<T extends RouteName>(name: T, params: Routes[T]) => {
    setStack((prev) => [...prev, { name, params } as Route]);
  }, []);

  const replace = useCallback(<T extends RouteName>(name: T, params: Routes[T]) => {
    setStack((prev) => [...prev.slice(0, -1), { name, params } as Route]);
  }, []);

  const pop = useCallback(() => {
    setStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));
  }, []);

  const reset = useCallback(<T extends RouteName>(name: T, params: Routes[T]) => {
    setStack([{ name, params } as Route]);
  }, []);

  const canGoBack = useCallback(() => stack.length > 1, [stack.length]);

  return useMemo(
    () => ({ route, stack, push, replace, reset, pop, canGoBack }),
    [route, stack, push, replace, reset, pop, canGoBack],
  );
}
