# 测试编写规范指南

## 概述
本指南定义Markus项目中测试编写的标准和规范，确保测试代码的质量、可维护性和一致性。

## 测试原则

### 1. FIRST原则
- **F**ast：测试应该快速运行
- **I**ndependent：测试应该相互独立
- **R**epeatable：测试应该在任何环境可重复
- **S**elf-validating：测试应该自动验证结果
- **T**imely：测试应该及时编写

### 2. 测试金字塔
```
        E2E测试 (少量)
           /\
          /  \
         /    \
        /      \
集成测试 (适量) 
      /          \
     /            \
    /              \
单元测试 (大量)
```

### 3. 测试覆盖率目标
- **单元测试**：80%+ 行覆盖率
- **集成测试**：70%+ 行覆盖率
- **E2E测试**：关键路径覆盖
- **总体目标**：85%+ 行覆盖率

## 测试类型

### 1. 单元测试
**目的**：测试单个函数或类的行为
**位置**：与源代码同目录，后缀 `.test.ts`
**工具**：Vitest + Testing Library

### 2. 集成测试
**目的**：测试多个组件的交互
**位置**：`__tests__/integration/` 目录
**工具**：Vitest + Supertest

### 3. E2E测试
**目的**：测试完整用户流程
**位置**：`__tests__/e2e/` 目录
**工具**：Playwright / Cypress

### 4. 快照测试
**目的**：确保UI输出不变
**位置**：与组件测试一起
**工具**：Vitest快照功能

## 测试文件结构

### 单元测试文件结构
```
src/
├── module/
│   ├── component.ts      # 源代码
│   ├── component.test.ts # 单元测试
│   └── __tests__/        # 测试工具和辅助函数
```

### 测试文件命名
- **单元测试**：`<filename>.test.ts`
- **集成测试**：`<filename>.integration.test.ts`
- **E2E测试**：`<filename>.e2e.test.ts`
- **测试工具**：`test-utils.ts`

## 测试编写规范

### 1. 测试描述
```typescript
// 好的描述
describe('UserService', () => {
  describe('createUser()', () => {
    it('should create a new user with valid data', () => {})
    it('should throw error when email is invalid', () => {})
  })
})

// 差的描述
describe('test user service', () => {
  it('test create user', () => {})
})
```

### 2. 测试结构（AAA模式）
```typescript
it('should return user by id', () => {
  // Arrange - 准备测试数据
  const userId = 'user-123'
  const expectedUser = { id: userId, name: 'John' }
  const userService = new UserService()

  // Act - 执行测试操作
  const result = userService.getUserById(userId)

  // Assert - 验证结果
  expect(result).toEqual(expectedUser)
})
```

### 3. 断言规范
```typescript
// 使用明确的断言
expect(result).toBe(true)           // 明确的值
expect(result).toEqual(expected)    // 对象比较
expect(result).toContain(item)      // 包含检查
expect(result).toHaveLength(3)      // 长度检查
expect(result).toBeInstanceOf(Error) // 类型检查

// 避免模糊的断言
expect(result).toBeTruthy()         // 避免，除非测试布尔值
expect(result).toBeDefined()        // 避免，除非测试undefined
```

### 4. Mock和Stub
```typescript
// 使用vi.fn()创建mock
const mockFetch = vi.fn()
mockFetch.mockResolvedValue({ data: 'test' })

// 使用vi.spyOn监视方法
const spy = vi.spyOn(console, 'log')

// 使用vi.mock模拟模块
vi.mock('../api', () => ({
  fetchData: vi.fn()
}))

// 清理mock
afterEach(() => {
  vi.clearAllMocks()
})
```

## 测试数据管理

### 1. 测试工厂函数
```typescript
// 创建可重用的测试数据工厂
const createTestUser = (overrides = {}) => ({
  id: 'user-123',
  name: 'Test User',
  email: 'test@example.com',
  ...overrides
})

// 使用工厂
const user = createTestUser({ name: 'Custom Name' })
```

### 2. 测试夹具（Fixtures）
```typescript
// 定义测试夹具
const userFixtures = {
  admin: { role: 'admin', permissions: ['read', 'write', 'delete'] },
  editor: { role: 'editor', permissions: ['read', 'write'] },
  viewer: { role: 'viewer', permissions: ['read'] }
}

// 使用夹具
const adminUser = createTestUser(userFixtures.admin)
```

### 3. 测试数据生成器
```typescript
// 使用Faker生成测试数据
import { faker } from '@faker-js/faker'

const generateUser = () => ({
  id: faker.string.uuid(),
  name: faker.person.fullName(),
  email: faker.internet.email(),
  createdAt: faker.date.recent()
})
```

## 异步测试

### 1. Promise测试
```typescript
it('should resolve with data', async () => {
  const promise = Promise.resolve('data')
  await expect(promise).resolves.toBe('data')
})

it('should reject with error', async () => {
  const promise = Promise.reject(new Error('error'))
  await expect(promise).rejects.toThrow('error')
})
```

### 2. 回调测试
```typescript
it('should call callback with result', (done) => {
  functionWithCallback((error, result) => {
    expect(error).toBeNull()
    expect(result).toBe('success')
    done()
  })
})
```

### 3. 定时器测试
```typescript
it('should call function after timeout', () => {
  vi.useFakeTimers()
  
  const callback = vi.fn()
  setTimeout(callback, 1000)
  
  vi.advanceTimersByTime(1000)
  expect(callback).toHaveBeenCalled()
  
  vi.useRealTimers()
})
```

## 测试性能优化

### 1. 测试隔离
```typescript
// 每个测试使用独立的数据
beforeEach(() => {
  // 重置测试状态
  database.clear()
  cache.clear()
})

afterEach(() => {
  // 清理测试资源
  vi.clearAllMocks()
})
```

### 2. 测试分组
```typescript
// 按功能分组测试
describe('UserService - createUser', () => {
  // 相关测试放在一起
})

describe('UserService - updateUser', () => {
  // 另一组相关测试
})
```

### 3. 跳过慢测试
```typescript
// 只在需要时运行慢测试
describe.skip('slow integration tests', () => {
  // 这些测试在开发时跳过
})

// 或使用条件跳过
describe('e2e tests', () => {
  it('should work in production', () => {
    if (process.env.NODE_ENV !== 'production') {
      return // 跳过非生产环境
    }
    // 测试逻辑
  })
})
```

## 测试报告和覆盖率

### 1. 覆盖率配置
```typescript
// vitest.config.ts
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80
      }
    }
  }
})
```

### 2. 测试报告
```bash
# 运行测试并生成报告
pnpm test --coverage

# 查看HTML报告
open coverage/index.html

# 运行特定测试
pnpm test --run <test-name>
```

### 3. 持续集成
```yaml
# GitHub Actions配置
- name: Run tests
  run: pnpm test --coverage

- name: Upload coverage
  uses: codecov/codecov-action@v3
```

## 常见测试模式

### 1. 参数化测试
```typescript
describe.each([
  [1, 1, 2],
  [1, 2, 3],
  [2, 2, 4]
])('add(%i, %i)', (a, b, expected) => {
  it(`returns ${expected}`, () => {
    expect(a + b).toBe(expected)
  })
})
```

### 2. 表格驱动测试
```typescript
const testCases = [
  { input: 'valid@email.com', expected: true },
  { input: 'invalid-email', expected: false },
  { input: '', expected: false }
]

testCases.forEach(({ input, expected }) => {
  it(`should return ${expected} for "${input}"`, () => {
    expect(isValidEmail(input)).toBe(expected)
  })
})
```

### 3. 快照测试
```typescript
it('should render component correctly', () => {
  const component = render(<MyComponent />)
  expect(component).toMatchSnapshot()
})

// 更新快照
pnpm test --update
```

## 测试最佳实践

### 1. 测试什么
- ✅ 测试业务逻辑和算法
- ✅ 测试错误处理和边界条件
- ✅ 测试公共API和接口
- ✅ 测试集成点和外部依赖

### 2. 避免什么
- ❌ 测试实现细节（如私有方法）
- ❌ 测试第三方库（除非集成测试）
- ❌ 测试过于琐碎的逻辑
- ❌ 编写脆弱的测试（依赖实现细节）

### 3. 测试维护
- 🔄 定期审查和更新测试
- 🔄 删除过时或无用的测试
- 🔄 重构重复的测试代码
- 🔄 保持测试代码质量

## 测试工具和库

### 1. 测试框架
- **Vitest**：主要测试框架
- **Jest**：备选方案（如果需要）

### 2. 断言库
- **Vitest断言**：内置断言
- **Chai**：备选断言库

### 3. Mock库
- **Vitest Mock**：内置mock功能
- **Sinon.js**：高级mock需求

### 4. 测试工具
- **Testing Library**：组件测试
- **Supertest**：API测试
- **Playwright**：E2E测试
- **Faker.js**：测试数据生成

## 测试代码审查

### 审查清单
- [ ] 测试描述是否清晰
- [ ] 测试是否独立
- [ ] 断言是否明确
- [ ] Mock使用是否合理
- [ ] 测试数据是否合适
- [ ] 覆盖率是否足够
- [ ] 测试性能是否可接受

### 常见问题
1. **测试太慢**：优化测试，使用mock
2. **测试不稳定**：确保测试独立性
3. **测试太复杂**：简化测试逻辑
4. **测试重复**：提取公共测试逻辑

## 总结
高质量的测试带来以下好处：
1. ✅ **代码质量**：及早发现和修复问题
2. ✅ **重构安全**：确保重构不破坏功能
3. ✅ **文档作用**：测试作为代码使用示例
4. ✅ **团队信心**：增强团队对代码的信心

遵循本指南，编写高质量、可维护的测试代码。