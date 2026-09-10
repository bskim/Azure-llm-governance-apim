import { createHash } from 'node:crypto';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function skipWhitespace(text, start) {
  let index = start;
  while (/\s/.test(text[index] ?? '')) index += 1;
  return index;
}

function readJsonString(text, start) {
  if (text[start] !== '"') throw new Error('expected a JSON string.');
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === '\\') index += 2;
    else if (text[index] === '"') {
      const end = index + 1;
      return { end, value: JSON.parse(text.slice(start, end)) };
    } else index += 1;
  }
  throw new Error('unterminated JSON string.');
}

function skipJsonValue(text, start) {
  const first = text[start];
  if (first === '"') return readJsonString(text, start).end;
  if (first === '{' || first === '[') {
    const closing = first === '{' ? '}' : ']';
    let depth = 1;
    let index = start + 1;
    while (index < text.length && depth > 0) {
      if (text[index] === '"') index = readJsonString(text, index).end;
      else {
        if (text[index] === first) depth += 1;
        else if (text[index] === closing) depth -= 1;
        index += 1;
      }
    }
    if (depth !== 0) throw new Error('unterminated JSON value.');
    return index;
  }
  let index = start;
  while (index < text.length && !/[,}\]]/.test(text[index])) index += 1;
  return index;
}

function directObjectEntries(text, start) {
  if (text[start] !== '{') throw new Error('expected a JSON object.');
  const entries = [];
  let index = skipWhitespace(text, start + 1);
  while (text[index] !== '}') {
    const key = readJsonString(text, index);
    index = skipWhitespace(text, key.end);
    if (text[index] !== ':') throw new Error(`expected ":" after JSON key ${key.value}.`);
    const valueStart = skipWhitespace(text, index + 1);
    const valueEnd = skipJsonValue(text, valueStart);
    entries.push({ key: key.value, valueEnd, valueStart });
    index = skipWhitespace(text, valueEnd);
    if (text[index] === ',') index = skipWhitespace(text, index + 1);
    else if (text[index] !== '}') throw new Error(`expected "," after JSON key ${key.value}.`);
  }
  return entries;
}

export function assertUniquePackagePaths(lockText, packageLock) {
  const rootStart = skipWhitespace(lockText, 0);
  const rootEntries = directObjectEntries(lockText, rootStart);
  const packagesProperties = rootEntries.filter((entry) => entry.key === 'packages');
  if (packagesProperties.length !== 1) {
    throw new Error('package-lock.json must contain exactly one packages object.');
  }
  const property = packagesProperties[0];
  if (lockText[property.valueStart] !== '{') {
    throw new Error('package-lock.json packages must be an object.');
  }
  const packageEntries = directObjectEntries(lockText, property.valueStart);
  const seen = new Set();
  for (const { key } of packageEntries) {
    if (seen.has(key)) throw new Error(`duplicate package path in package-lock.json: ${key}`);
    seen.add(key);
  }
  const parsedPaths = Object.keys(packageLock.packages ?? {});
  if (seen.size !== parsedPaths.length || parsedPaths.some((packagePath) => !seen.has(packagePath))) {
    throw new Error('package-lock.json package paths are ambiguous after JSON parsing.');
  }
}

export function versionInventory(packageLock) {
  const rows = Object.entries(packageLock.packages ?? {})
    .filter(([packagePath, entry]) => packagePath.length > 0 && entry?.link !== true)
    .map(([packagePath, entry]) => {
      if (typeof entry.version !== 'string' || entry.version.length === 0) {
        throw new Error(`locked package has no exact version: ${packagePath}`);
      }
      return `${packagePath}|${entry.version}`;
    })
    .sort((left, right) => left.localeCompare(right));
  return {
    count: rows.length,
    sha256: sha256(rows.join('\n')),
  };
}
