import { compareActions, type Action } from "../config/schema.ts";

/**
 * 动作与严格度在策略层的入口（FR-1、FR-6）。
 *
 * 严格度序（`deny > ask > review > allow`）的唯一真源在 `config/schema.ts`，与动作枚举定义放在
 * 一起，避免出现第二个严格度来源；这里只做再导出与面向求值器的取值辅助。
 */
export { compareActions } from "../config/schema.ts";
export type { Action } from "../config/schema.ts";

/**
 * 取一组动作中最严格的一个；空数组返回 `undefined`。
 *
 * 返回 `undefined` 表示"不表态"，与 `mostRestrictiveAction` 要求的显式 `fallback` 不同：
 * 规则求值里"没有命中任何规则"是一个必须与"命中后得到 allow"区分开的状态，
 * 否则兜底层（baseline 与只读白名单）就没有触发条件。
 */
export function strictestAction(actions: readonly Action[]): Action | undefined {
  let strictest: Action | undefined;
  for (const action of actions) {
    if (strictest === undefined || compareActions(action, strictest) < 0) {
      strictest = action;
    }
  }
  return strictest;
}
