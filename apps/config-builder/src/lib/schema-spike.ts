import { buildConfigSchema, type ConfigUiHint } from "@openclaw/config/schema.ts";

type JsonSchemaNode = {
  description?: string;
  default?: unknown;
  type?: string | string[];
  enum?: unknown[];
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode | JsonSchemaNode[];
  additionalProperties?: JsonSchemaNode | boolean;
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
  allOf?: JsonSchemaNode[];
};

export type FieldKind =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "enum"
  | "array"
  | "object"
  | "unknown";

export type ExplorerField = {
  path: string;
  label: string;
  help: string;
  sensitive: boolean;
  advanced: boolean;
  kind: FieldKind;
  enumValues: string[];
  hasDefault: boolean;
  editable: boolean;
};

export type ExplorerSection = {
  id: string;
  label: string;
  order: number;
  description: string;
  fields: ExplorerField[];
};

export type ExplorerSnapshot = {
  version: string;
  generatedAt: string;
  sectionCount: number;
  fieldCount: number;
  sections: ExplorerSection[];
};

const SECTION_FALLBACK_ORDER = 500;

function humanizeKey(value: string): string {
  if (!value.trim()) {
    return value;
  }
  return value
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (char) => char.toUpperCase());
}

function firstPathSegment(path: string): string {
  const [segment] = path.split(".");
  return segment?.trim() ?? "";
}

function lastPathSegment(path: string): string {
  const segments = path.split(".");
  return segments.at(-1) ?? path;
}

function isSectionHint(path: string, hint: ConfigUiHint): boolean {
  return !path.includes(".") && typeof hint.order === "number" && typeof hint.group === "string";
}

function fieldSort(a: ExplorerField, b: ExplorerField): number {
  return a.path.localeCompare(b.path);
}

function sectionSort(a: ExplorerSection, b: ExplorerSection): number {
  if (a.order !== b.order) {
    return a.order - b.order;
  }
  return a.label.localeCompare(b.label);
}

function normalizeSchemaPath(path: string): string[] {
  return path
    .replace(/\[\]/g, ".*")
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function asObjectNode(node: unknown): JsonSchemaNode | null {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    return null;
  }
  return node as JsonSchemaNode;
}

function resolveUnion(node: JsonSchemaNode): JsonSchemaNode {
  const pool = [...(node.anyOf ?? []), ...(node.oneOf ?? []), ...(node.allOf ?? [])];
  const preferred = pool.find((entry) => {
    const type = entry.type;
    if (typeof type === "string") {
      return type !== "null";
    }
    if (Array.isArray(type)) {
      return type.some((part) => part !== "null");
    }
    return true;
  });
  return preferred ?? node;
}

function resolveSchemaNode(root: JsonSchemaNode, path: string): JsonSchemaNode | null {
  const segments = normalizeSchemaPath(path);
  let current: JsonSchemaNode | null = root;

  for (const segment of segments) {
    if (!current) {
      return null;
    }

    current = resolveUnion(current);

    if (segment === "*") {
      if (Array.isArray(current.items)) {
        current = current.items[0] ?? null;
        continue;
      }
      const itemNode = asObjectNode(current.items);
      if (itemNode) {
        current = itemNode;
        continue;
      }
      const additionalNode = asObjectNode(current.additionalProperties);
      if (additionalNode) {
        current = additionalNode;
        continue;
      }
      return null;
    }

    const properties = current.properties ?? {};
    if (segment in properties) {
      current = properties[segment] ?? null;
      continue;
    }

    const additionalNode = asObjectNode(current.additionalProperties);
    if (additionalNode) {
      current = additionalNode;
      continue;
    }

    return null;
  }

  return current ? resolveUnion(current) : null;
}

function resolveType(node: JsonSchemaNode | null): FieldKind {
  if (!node) {
    return "unknown";
  }
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    return "enum";
  }

  const rawType = node.type;
  const type = Array.isArray(rawType) ? rawType.find((entry) => entry !== "null") : rawType;

  switch (type) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "integer":
      return "integer";
    case "boolean":
      return "boolean";
    case "array":
      return "array";
    case "object":
      return "object";
    default:
      if (node.properties) {
        return "object";
      }
      if (node.items) {
        return "array";
      }
      return "unknown";
  }
}

function isEditable(path: string, kind: FieldKind): boolean {
  if (path.includes("*") || path.includes("[]")) {
    return false;
  }
  return kind === "string" || kind === "number" || kind === "integer" || kind === "boolean" || kind === "enum";
}

function toEnumValues(values: unknown[] | undefined): string[] {
  if (!values || values.length === 0) {
    return [];
  }
  return values.map((value) => String(value));
}

export function buildExplorerSnapshot(): ExplorerSnapshot {
  const configSchema = buildConfigSchema();
  const uiHints = configSchema.uiHints;
  const schemaRoot = asObjectNode(configSchema.schema);
  const schemaProperties = schemaRoot?.properties ?? {};

  const sections = new Map<string, ExplorerSection>();

  for (const [path, hint] of Object.entries(uiHints)) {
    if (!isSectionHint(path, hint)) {
      continue;
    }
    sections.set(path, {
      id: path,
      label: hint.label?.trim() || hint.group?.trim() || humanizeKey(path),
      order: hint.order,
      description: "",
      fields: [],
    });
  }

  for (const [rootKey, node] of Object.entries(schemaProperties)) {
    if (sections.has(rootKey)) {
      const existing = sections.get(rootKey);
      if (existing) {
        existing.description = node.description?.trim() ?? existing.description;
      }
      continue;
    }
    const rootHint = uiHints[rootKey];
    sections.set(rootKey, {
      id: rootKey,
      label: rootHint?.label?.trim() || humanizeKey(rootKey),
      order: rootHint?.order ?? SECTION_FALLBACK_ORDER,
      description: node.description?.trim() ?? rootHint?.help?.trim() ?? "",
      fields: [],
    });
  }

  for (const [path, hint] of Object.entries(uiHints)) {
    const rootKey = firstPathSegment(path);
    if (!rootKey) {
      continue;
    }

    if (!sections.has(rootKey)) {
      sections.set(rootKey, {
        id: rootKey,
        label: humanizeKey(rootKey),
        order: SECTION_FALLBACK_ORDER,
        description: "",
        fields: [],
      });
    }

    if (isSectionHint(path, hint)) {
      continue;
    }

    const target = sections.get(rootKey);
    if (!target) {
      continue;
    }

    const schemaNode = resolveSchemaNode(schemaRoot ?? {}, path);
    const kind = resolveType(schemaNode);

    target.fields.push({
      path,
      label: hint.label?.trim() || humanizeKey(lastPathSegment(path)),
      help: hint.help?.trim() ?? schemaNode?.description?.trim() ?? "",
      sensitive: Boolean(hint.sensitive),
      advanced: Boolean(hint.advanced),
      kind,
      enumValues: toEnumValues(schemaNode?.enum),
      hasDefault: schemaNode?.default !== undefined,
      editable: isEditable(path, kind),
    });
  }

  const orderedSections = Array.from(sections.values())
    .map((section) => ({ ...section, fields: section.fields.toSorted(fieldSort) }))
    .toSorted(sectionSort);

  const fieldCount = orderedSections.reduce((sum, section) => sum + section.fields.length, 0);

  return {
    version: configSchema.version,
    generatedAt: configSchema.generatedAt,
    sectionCount: orderedSections.length,
    fieldCount,
    sections: orderedSections,
  };
}
