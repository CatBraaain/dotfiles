import {
  Alias,
  Document,
  isAlias,
  isMap,
  isNode,
  isScalar,
  isSeq,
  Pair,
  Scalar,
  type Node,
  YAMLMap,
  YAMLSeq,
} from "yaml";

type Notation = { anchor?: string; keys?: Map<string | symbol, unknown> };
const notation = new WeakMap<object, Notation>();

export function readYamlValue(node: Node | null): unknown {
  if (isAlias(node)) return new Alias(node.source);
  if (isScalar(node)) {
    const value = node.toJSON();
    if (!node.anchor) return value;
    if (typeof value === "object" && value !== null) {
      notation.set(value, { anchor: node.anchor });
      return value;
    }
    const scalar = new Scalar(value);
    scalar.anchor = node.anchor;
    return scalar;
  }
  if (isSeq(node)) {
    return rememberYamlNotation(
      node,
      node.items.map((item) => readYamlValue(item as Node | null)),
    );
  }
  if (!isMap(node)) return undefined;
  const result: Record<string | symbol, unknown> = {};
  for (const pair of node.items) {
    Object.defineProperty(result, yamlKey(pair.key), {
      value: readYamlValue(pair.value as Node | null),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return rememberYamlNotation(node, result);
}

export function rememberYamlNotation<T extends object>(node: YAMLMap | YAMLSeq, value: T): T {
  const keys = isMap(node)
    ? new Map(node.items.map((pair) => [yamlKey(pair.key), readYamlValue(pair.key as Node | null)]))
    : undefined;
  notation.set(value, { anchor: node.anchor, keys });
  return value;
}

export function copyYamlNotation<T extends object>(value: T, ...sources: object[]): T {
  for (const source of sources) {
    const incoming = notation.get(source);
    if (!incoming) continue;
    const current = notation.get(value);
    notation.set(value, {
      anchor: incoming.anchor ?? current?.anchor,
      keys: incoming.keys ? new Map([...(current?.keys ?? []), ...incoming.keys]) : current?.keys,
    });
  }
  return value;
}

export function yamlKey(node: unknown): string | symbol {
  if (!isNode(node)) return String(node);
  if (isScalar(node)) return String(node.toJSON());
  return Symbol.for(`yaml-key:${stringifyYamlValue(readYamlValue(node))}`);
}

export function ownEntries(value: object): [string | symbol, unknown][] {
  return Reflect.ownKeys(value)
    .filter((key) => Object.prototype.propertyIsEnumerable.call(value, key))
    .map((key) => [key, (value as Record<string | symbol, unknown>)[key]]);
}

export function stringifyYamlValue(value: unknown): string {
  const document = new Document();
  document.contents = createYamlNode(value, document);
  return document.toString({ verifyAliasOrder: false });
}

function createYamlNode(value: unknown, document: Document): Node {
  if (isNode(value)) return value;
  if (typeof value !== "object" || value === null) return document.createNode(value);
  const original = notation.get(value);
  if (Array.isArray(value)) {
    const sequence = new YAMLSeq<Node>(document.schema);
    sequence.items = value.map((item) => createYamlNode(item, document));
    sequence.anchor = original?.anchor;
    return sequence;
  }
  const map = new YAMLMap<Node, Node>(document.schema);
  map.items = ownEntries(value).map(
    ([key, child]) =>
      new Pair(
        createYamlNode(original?.keys?.get(key) ?? key, document),
        createYamlNode(child, document),
      ),
  );
  map.anchor = original?.anchor;
  return map;
}
