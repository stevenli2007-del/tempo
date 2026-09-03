/**
 * JSON Schema 子集校验（P0-1-3）。
 *
 * **为什么需要它**：厂商的 JSON Output 模式（DeepSeek 的 `response_format: json_object`）
 * 只保证「返回的是合法 JSON」，**不保证符合你的 schema**。模型照样会漏字段、类型写错、
 * 或者给结果套一层 `{"data": ...}`。不校验的话，这些偏差会一路流到业务层变成
 * 「某个字段莫名是 undefined」，排查成本极高。
 *
 * **为什么不是完整的 JSON Schema 实现**：我们只需要挡住上面那几种真实会发生的偏差。
 * 完整实现（`oneOf` / `pattern` / `minimum` / `$ref` …）是几百行代码加一个依赖，
 * 而 schema 本身还要拼进 prompt 发给模型 —— 越复杂模型越容易跑偏。
 * 所以只支持 `type` / `properties` / `required` / `items` / `enum`。
 *
 * 业务侧的取值约束（日期格式、百分比范围等）不在这里做，由调用方的领域解析负责。
 */

import type { JSONSchema, JSONSchemaType } from './types'

function typeOf(value: unknown): JSONSchemaType {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  if (typeof value === 'string') return 'string'
  if (typeof value === 'boolean') return 'boolean'
  return 'object'
}

/**
 * `number` 的 schema 也接受整数，但反过来不行 —— 写 `integer` 就是在要求整数。
 */
function isTypeAllowed(actual: JSONSchemaType, expected: JSONSchemaType): boolean {
  if (actual === expected) return true
  return expected === 'number' && actual === 'integer'
}

/**
 * 把 `type` 统一成数组。
 *
 * 用 `typeof === 'string'` 而不是 `Array.isArray()` —— 后者对 `readonly T[]`
 * 不做收窄（`any[]` 与 `readonly T[]` 不兼容），收窄后仍是一个联合类型。
 */
function toTypeList(type: JSONSchema['type']): readonly JSONSchemaType[] | null {
  if (!type) return null
  return typeof type === 'string' ? [type] : type
}

function matchesType(value: unknown, schema: JSONSchema): boolean {
  const allowed = toTypeList(schema.type)
  if (!allowed) return true
  return allowed.some((expected) => isTypeAllowed(typeOf(value), expected))
}

function describeType(schema: JSONSchema): string {
  const allowed = toTypeList(schema.type)
  return allowed ? allowed.join(' | ') : 'any'
}

/**
 * 校验值是否符合 schema。
 *
 * @returns 第一个不匹配的说明（含 JSON 路径，便于定位）；符合则返回 `null`。
 */
export function validateJsonSchema(
  value: unknown,
  schema: JSONSchema,
  path = '$',
): string | null {
  if (!matchesType(value, schema)) {
    return `${path} 类型不符：期望 ${describeType(schema)}，实际 ${typeOf(value)}`
  }

  if (schema.enum && !schema.enum.some((candidate) => candidate === value)) {
    return `${path} 取值不在枚举内：期望 ${schema.enum.map(String).join(' | ')}，实际 ${JSON.stringify(value)}`
  }

  if (Array.isArray(value) && schema.items) {
    for (const [index, item] of value.entries()) {
      const error = validateJsonSchema(item, schema.items, `${path}[${index}]`)
      if (error) return error
    }
    return null
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>

    for (const key of schema.required ?? []) {
      if (!(key in record)) {
        return `${path} 缺少必填字段 ${key}`
      }
    }

    for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
      if (!(key in record)) continue
      const error = validateJsonSchema(record[key], childSchema, `${path}.${key}`)
      if (error) return error
    }
  }

  return null
}
