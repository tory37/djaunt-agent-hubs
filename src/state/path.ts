export type JsonObject = { [key: string]: unknown };

export class PathNotFoundError extends Error {}

const PATH_SEPARATOR = ".";

// Paths are dotted segments. Inside an array, a segment is either a numeric
// index or the "id" of an element, so agents can write "steps.deploy.status"
// without tracking positions.
function splitPath(path: string): string[] {
  const trimmed = path.trim();
  if (trimmed === "") throw new Error("empty path");
  const segments = trimmed.split(PATH_SEPARATOR);
  if (segments.some((segment) => segment === "")) {
    throw new Error(`path "${path}" has an empty segment`);
  }
  return segments;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayIndex(elements: unknown[], segment: string): number | undefined {
  if (/^\d+$/.test(segment)) {
    const position = Number(segment);
    return position < elements.length ? position : undefined;
  }
  const position = elements.findIndex(
    (element) => isObject(element) && "id" in element && String(element.id) === segment,
  );
  return position >= 0 ? position : undefined;
}

function lookupChild(container: unknown, segment: string): { found: boolean; value?: unknown } {
  if (Array.isArray(container)) {
    const position = arrayIndex(container, segment);
    return position === undefined ? { found: false } : { found: true, value: container[position] };
  }
  if (isObject(container) && Object.hasOwn(container, segment)) {
    return { found: true, value: container[segment] };
  }
  return { found: false };
}

export function getPath(document: JsonObject, path: string): unknown {
  let current: unknown = document;
  for (const segment of splitPath(path)) {
    const child = lookupChild(current, segment);
    if (!child.found) throw new PathNotFoundError(`path not found: ${path}`);
    current = child.value;
  }
  return current;
}

function descendOrCreate(container: unknown, segment: string, fullPath: string): unknown {
  if (Array.isArray(container)) {
    const position = arrayIndex(container, segment);
    if (position === undefined) {
      throw new PathNotFoundError(`path not found: no element "${segment}" in ${fullPath}`);
    }
    return container[position];
  }
  if (isObject(container)) {
    const child = container[segment];
    if (child === undefined || child === null) {
      const created: JsonObject = {};
      container[segment] = created;
      return created;
    }
    return child;
  }
  throw new Error(`cannot descend into "${segment}" of ${fullPath}: not an object or array`);
}

// A null value deletes the key, or removes the array element.
export function setPath(document: JsonObject, path: string, value: unknown): void {
  const segments = splitPath(path);
  const finalSegment = segments.pop()!;
  let parent: unknown = document;
  for (const segment of segments) parent = descendOrCreate(parent, segment, path);

  const isDelete = value === null || value === undefined;
  if (Array.isArray(parent)) {
    const position = arrayIndex(parent, finalSegment);
    if (position === undefined) {
      throw new PathNotFoundError(`path not found: no element "${finalSegment}" in ${path}`);
    }
    if (isDelete) parent.splice(position, 1);
    else parent[position] = value;
    return;
  }
  if (isObject(parent)) {
    if (isDelete) delete parent[finalSegment];
    else parent[finalSegment] = value;
    return;
  }
  throw new Error(`cannot set "${finalSegment}" of ${path}: not an object or array`);
}
