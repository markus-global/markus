/**
 * 浏览器侧的「待办排序」入口。
 *
 * **实现不在这个文件里**，在 `packages/shared/src/types/todo-order.ts` —— 这里只有一行转发，
 * 原因是结构性的、不是风格选择：
 *
 *   · `@markus/shared` 的 barrel（`src/index.ts`）会带进 Node 侧依赖（fs / crypto），
 *     浏览器 bundle 不能 import 它（见 `lib/modelCapabilities.ts`、`lib/mailboxTypeMeta.ts`
 *     里同样的说明）。历史上每次「web-ui 需要 shared 的某个纯函数」都靠**抄一份**解决，
 *     于是抄出过 `toStringArray` 的第二份实现、`TASK_TRANSITIONS` 的第二份镜像 ——
 *     抄出来的那份不会跟着源一起改，这正是本次要消灭的缺陷族。
 *   · 所以这里改成**同源相对导入**：拿的是同一份源码，不是副本。纯函数、零 IO、
 *     不碰任何 Node API，因此对 bundle 没有副作用。
 *
 * 判据：**同一个事实只能有一个实现，多个入口可以有。** 这个文件是入口，不是写者。
 * 第二处「优先级权重表 / 自建 stage 序 / 就地 stage 比较器」会被
 * `scripts/architecture-guard.mjs` 的 `todo-order-single-writer` 判红。
 */
export {
  PRIORITY_RANK,
  NO_PRIORITY_RANK,
  todoStageRank,
  todoPriorityRank,
  compareTodoOrder,
  orderTodos,
  type TodoOrderInput,
} from '../../../shared/src/types/todo-order.ts';
