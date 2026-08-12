/**
 * A small JSON Schema (draft 2020-12) validator.
 *
 * Deliberately not a complete implementation, and deliberately not a vendored
 * one: CI for this repository should have no install step, and a partial
 * validator that silently ignores what it does not understand is worse than no
 * validator at all. So this supports exactly the keywords the schemas in
 * `schema/` use, and throws on any keyword it does not know — if someone adds
 * `patternProperties` to a schema, they find out here rather than shipping a
 * rule that never runs.
 *
 * `format` is treated as an annotation and not enforced. Every field that
 * matters carries a `pattern` alongside it for that reason.
 */

const KNOWN_KEYWORDS = new Set([
  // Annotations, ignored.
  '$schema',
  '$id',
  'title',
  'description',
  'examples',
  'default',
  'format',
  // Structure.
  '$defs',
  '$ref',
  // Assertions.
  'type',
  'const',
  'enum',
  'pattern',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'uniqueItems',
  'required',
  'properties',
  'additionalProperties',
  'items',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  'if',
  'then',
  'else',
]);

/** Thrown when a schema uses something this validator cannot enforce. */
export class UnsupportedSchemaError extends Error {}

function assertKnownKeywords(schema, where) {
  for (const key of Object.keys(schema)) {
    if (!KNOWN_KEYWORDS.has(key)) {
      throw new UnsupportedSchemaError(
        `${where}: this validator does not implement the "${key}" keyword. ` +
          `Add it to scripts/lib/json-schema.mjs before using it in a schema.`,
      );
    }
  }
}

function resolveRef(root, ref, where) {
  if (!ref.startsWith('#/')) {
    throw new UnsupportedSchemaError(`${where}: only local "#/..." refs are supported, got "${ref}"`);
  }

  let node = root;
  for (const rawSegment of ref.slice(2).split('/')) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    node = node?.[segment];
    if (node === undefined) {
      throw new UnsupportedSchemaError(`${where}: cannot resolve "${ref}"`);
    }
  }
  return node;
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType(value, type) {
  switch (type) {
    case 'object':
      return typeOf(value) === 'object';
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      throw new UnsupportedSchemaError(`unknown type "${type}"`);
  }
}

/**
 * Validates `value` against `schema`.
 *
 * @returns {string[]} human-readable problems; empty means valid.
 */
export function validate(value, schema, { root = schema, path = '' } = {}) {
  const errors = [];
  const at = path || '(root)';

  if (typeof schema === 'boolean') {
    return schema ? [] : [`${at}: schema forbids any value here`];
  }

  assertKnownKeywords(schema, `schema at ${at}`);

  if (schema.$ref !== undefined) {
    // Every $ref in this repository's schemas stands alone, so sibling
    // keywords are not merged — draft 2020-12 would allow it, we do not need it.
    return validate(value, resolveRef(root, schema.$ref, at), { root, path });
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, type))) {
      return [`${at}: expected ${types.join(' or ')}, got ${typeOf(value)}`];
    }
  }

  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    errors.push(`${at}: expected ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }

  if (schema.enum !== undefined) {
    const encoded = JSON.stringify(value);
    if (!schema.enum.some((option) => JSON.stringify(option) === encoded)) {
      errors.push(`${at}: ${encoded} is not one of ${JSON.stringify(schema.enum)}`);
    }
  }

  if (typeof value === 'string') {
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) {
      errors.push(`${at}: ${JSON.stringify(value)} does not match /${schema.pattern}/`);
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${at}: shorter than ${schema.minLength} characters`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${at}: longer than ${schema.maxLength} characters`);
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${at}: ${value} is below the minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${at}: ${value} is above the maximum ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${at}: needs at least ${schema.minItems} items, has ${value.length}`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${at}: allows at most ${schema.maxItems} items, has ${value.length}`);
    }
    if (schema.uniqueItems === true) {
      const seen = new Set();
      for (const item of value) {
        const encoded = JSON.stringify(item);
        if (seen.has(encoded)) {
          errors.push(`${at}: contains the duplicate item ${encoded}`);
          break;
        }
        seen.add(encoded);
      }
    }
    if (schema.items !== undefined) {
      value.forEach((item, index) => {
        errors.push(...validate(item, schema.items, { root, path: `${path}[${index}]` }));
      });
    }
  }

  if (typeOf(value) === 'object') {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) {
        errors.push(`${at}: missing required property "${key}"`);
      }
    }

    const properties = schema.properties ?? {};
    for (const [key, subSchema] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) {
        errors.push(
          ...validate(value[key], subSchema, { root, path: path ? `${path}.${key}` : key }),
        );
      }
    }

    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) {
          errors.push(`${at}: unexpected property "${key}"`);
        }
      }
    } else if (schema.additionalProperties !== undefined) {
      throw new UnsupportedSchemaError(
        `schema at ${at}: only "additionalProperties": false is supported`,
      );
    }
  }

  for (const subSchema of schema.allOf ?? []) {
    errors.push(...validate(value, subSchema, { root, path }));
  }

  if (schema.anyOf !== undefined) {
    const branches = schema.anyOf.map((sub) => validate(value, sub, { root, path }));
    if (branches.every((branch) => branch.length > 0)) {
      errors.push(`${at}: matched none of the allowed shapes — ${branches.flat().join('; ')}`);
    }
  }

  if (schema.oneOf !== undefined) {
    const matched = schema.oneOf.filter((sub) => validate(value, sub, { root, path }).length === 0);
    if (matched.length !== 1) {
      errors.push(`${at}: matched ${matched.length} of the allowed shapes, expected exactly one`);
    }
  }

  if (schema.not !== undefined && validate(value, schema.not, { root, path }).length === 0) {
    errors.push(`${at}: matched a shape that is explicitly forbidden`);
  }

  if (schema.if !== undefined) {
    const branch = validate(value, schema.if, { root, path }).length === 0 ? schema.then : schema.else;
    if (branch !== undefined) {
      errors.push(...validate(value, branch, { root, path }));
    }
  }

  return errors;
}
