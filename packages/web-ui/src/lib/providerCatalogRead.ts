/**
 * provider 模型目录的**唯一取数实现**。
 *
 * 两个调用点（Settings 新增 provider 的「校验 key 并取模型」、Settings 的
 * 「从目录挑选」子组件）此前各写一遍
 * `try { … } catch { setModels([]) }` —— 读失败被渲染成「这个 provider 没有模型」，
 * 而事实是我们没读到（审计 §8.4 R1 的 R14 / R15）。
 *
 * 读失败必须落成 `state: 'error'`（`readList`），不要折成空数组 —— 否则界面
 * 说出的是一句我们并不知道的断言。带 `apiKey` 时走校验口，与不带 key 的读取
 * 共用同一个返回类型，调用方不需要分两套写法。
 */
import { api, type CatalogModel } from '../api.ts';
import { errorResource, okResource, type Resource } from './resourceState.ts';

/**
 * @param provider provider id（如 'openai'）
 * @param apiKey   有值时走「校验 key 并返回可用模型」；无值时读已配置/内置目录
 */
export async function readProviderCatalog(
  provider: string,
  options: { readonly apiKey?: string | undefined; readonly baseUrl?: string | undefined } = {},
): Promise<Resource<CatalogModel>> {
  try {
    if (options.apiKey) {
      const result = await api.modelCatalog.validateKey(provider, options.apiKey, options.baseUrl);
      return okResource(result.models ?? []);
    }
    const result = await api.modelCatalog.getByProvider(provider);
    return okResource(result.models ?? []);
  } catch (err) {
    return errorResource<CatalogModel>(err);
  }
}
