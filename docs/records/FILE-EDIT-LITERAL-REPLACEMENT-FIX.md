# 编辑工具静默复制文件内容 — 根因调查与修复

**日期**：2026-10-04
**影响面**：`file_edit`、`apply_patch`（所有 Agent 的文档/代码编辑路径）
**严重度**：高 — 静默数据损坏，工具仍返回 `status: "success"`
**状态**：已修复 + 已配回归测试（含牙齿检验）

---

## 1. 结论摘要

`file_edit` 与 `apply_patch` 把**替换串**直接交给了 `String.prototype.replace`。当替换串里含有
dollar 序列时，JS 会把它们当**替换模板**展开，而不是按字面量写入，于是文件被静默复制 / 膨胀。

修法只有一行语义的改动：把 replacer 从「字符串」改成「函数」，并收敛到**单一实现点**
`packages/core/src/tools/literal-replace.ts`，两个工具都调它。

---

## 2. 现象

用户报告：编辑中文文档后，文件凭空多了 253 行，且**出现两份文档标题**（复制块从第 254 行开始）。

直觉怀疑是「中文 / 多字节编码 / 字节-字符 offset 混用」。**该怀疑是错误的**，见 §4。

---

## 3. 根因（行级证据）

三处调用点，全部是同一形状：

| 文件 | 修改前 |
|---|---|
| `packages/core/src/tools/file.ts:251` | `const updated = content.replace(oldStr, newStr);` |
| `packages/core/src/tools/patch.ts:121`（校验轮） | `content = content.replace(hunk.old_string, hunk.new_string);` |
| `packages/core/src/tools/patch.ts:149`（应用轮） | `content = content.replace(hunk.old_string, hunk.new_string);` |

`String.prototype.replace(search, replacement)` 的第二个参数是**替换模板**，其中：

| 替换串里的写法 | 被展开为 |
|---|---|
| 匹配文本占位符 | 被匹配到的文本本身 |
| 「匹配点之前」占位符 | **匹配点之前的全部文件内容** → 前缀被整段复制 |
| 「匹配点之后」占位符 | **匹配点之后的全部文件内容** → 后缀被整段复制 |
| 编号分组占位符 | 捕获组（字符串 search 无分组，故此处按字面量留下） |
| 转义占位符 | 一个单个的字面 dollar 符号 |

**只有前三种会改变文件长度**，也都表现为「内容被复制」。报告症状 `+253 行 / 复制块自第 254 行起 / 两份标题`
与「匹配点在第 254 行 → 前 253 行被复制」**逐项吻合**。

---

## 4. 为什么被误判为「CJK 问题」

两个事实排除了编码假设：

1. 源码全程**没有任何 offset 运算**——`file.ts` 是整串 `readFileSync` / `writeFileSync`，
   不存在字节与字符混用；
2. 「找不到匹配」分支在**写盘之前**就 `return`（`file.ts` 的 `count === 0` 分支），
   所以「报 not found 却把文件写坏」在结构上不可能发生。

真正的触发条件是**替换串里含 dollar 序列**，与语言无关。之所以该报告人踩中：
他编辑的是一份**工具契约文档**，正文里天然含 shell 示例（`` $` ``、`$'`、`$&` 这类写法），
命中概率极高；而 CJK 只是同时存在的混淆变量。

**判据**：能否触发只取决于 `new_string` 里是否含 `$` + (反引号 / 单引号 / `&` / 数字 / `$`)。
纯中文、纯英文都不会触发。

---

## 5. 影响面

- **触发面比报告更广**：任何写 shell 脚本、Makefile、正则、模板字符串、CI 配置的文档或代码
  都可能踩到，不只是中文文档。
- **`apply_patch` 校验轮也会中招**（`patch.ts:121`）：校验轮在本地 `content` 上顺序改写，
  替换串被展开后会让**后续 hunk 的匹配判定失真**，表现可能是「莫名报 hunk not found」。
  牙齿检验中实测到这一现象（见 §7）。
- **`file_write` 天然免疫**：它整文件写入，不走 `replace`。这也是当时唯一的临时规避手段。

---

## 6. 修复

新增单一实现点 `packages/core/src/tools/literal-replace.ts`：

```ts
export function replaceLiteral(content: string, search: string, replacement: string): string {
  return content.replace(search, () => replacement);
}
```

- 用**函数式 replacer**，返回值按字面量插入，彻底关闭模板展开；
- 语义与原来完全一致（仍是「只替换第一个匹配」），只是不再解释 dollar 序列；
- 三处调用点全部改为 `replaceLiteral(...)`；`tools/` 目录下其余 `.replace(` 调用经普查
  均为正则 / 字面量替换（安全），无需改动。

**为什么收敛成一个函数而不是各改一行**：同一个判据写两遍，将来只修一处就会漏另一处
（这类「只修一处无效」的坑在本仓库已出现过）。单一实现点 = 一处可审计、一处可测试。

---

## 7. 验证

新测试：`packages/core/test/file-edit-replace-template.test.ts`（9 例）

覆盖 5 种美元序列 ×（helper 层 / `file_edit` 层 / `apply_patch` 多 hunk 层），
并断言**结构性不变量**：编辑后行数不变、文档标题恰好出现 1 次、目标文本被替换掉。

真实场景复刻：构造 200 行中文文档（替换目标靠近文末，正是前缀复制最凶的形态），
断言行数不变、标题仅一份。

**牙齿检验（关键）**：临时回退源码到修复前，重跑该测试 → **3 例必红**，且红法正是 bug 本身：

| 失败断言 | 含义 |
|---|---|
| `expected ... to contain '新行 A$&B'` | 匹配文本占位符被展开成了「匹配到的文本」 |
| `expected ... to contain '新行 $`'` | 「匹配点之前」占位符把整段前缀复制走 |
| `expected 'error' to be 'success'` | `apply_patch` 校验轮被展开污染 → 误报错误 |

恢复修复后：新测试 9/9 绿，既有 `file-tools.test.ts`(20) + `patch-tool.test.ts`(16) 绿。

**全量回归**：`packages/core` 216 个测试文件 / 3063 例通过、0 失败；`tsc -b` 退出 0。

---

## 8. 后续自查清单（给工具作者）

1. 任何把 **Agent 产出的字符串**当替换串的地方，都必须用 `replaceLiteral`；
2. 替换串来自字面量或正则时（`x.replace(/re/g, '')`）保持现状即可，不必改；
3. 新增编辑类工具时，先问一句：「这个替换串可能是用户写的 shell / 模板 / 正则吗？」
   是 → 用 `replaceLiteral`；
4. 怀疑「内容被复制」类 bug 时，**先查替换串与匹配串**，再怀疑编码。
