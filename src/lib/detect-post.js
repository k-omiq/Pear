// Detection post-processing, before engine coordinates enter the store.
// Ported from Komatose's src/lib/transcribeRegions.ts and src/lib/ocrConsensus.ts
// at commit d9be51e (MIT, Copyright (c) 2026 innominata). See THIRD-PARTY.md.
// Region types use the sfx.ts port in sfx-meanings.js; sidecar loads this module
// lazily so the dictionary is parsed only when detection or a queue hint needs it.

import { classifyRegionLineType } from './sfx-meanings.js';

// Ignore OCR spacing and interchangeable separators, but keep sound-length ー
// and punctuation that can change a reading, such as ! versus ?.
export function ocrComparableKey(value) {
  return value.normalize('NFKC').replace(/[\s\p{Cf}\p{Pd}~˜∼〜～＿_·•∙⋅・‧]/gu, '');
}

function visible(source) {
  return source.normalize('NFKC').replace(/<[^>\s]{1,40}>/g, '');
}

const SOURCE_SCRIPT = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u;

export function isAlreadyEnglish(source) {
  const letters = [...visible(source)].filter((ch) => /\p{L}/u.test(ch));
  if (letters.length < 2) return false;
  if (letters.some((ch) => SOURCE_SCRIPT.test(ch))) return false;
  const latin = letters.filter((ch) => /\p{Script=Latin}/u.test(ch)).length;
  return latin / letters.length >= 0.8;
}

function readingKey(source) {
  return ocrComparableKey(visible(source));
}

function hasReading(source) {
  return /[\p{L}\p{N}]/u.test(readingKey(source));
}

function area(region) {
  const [x1, y1, x2, y2] = region.box;
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

// Fraction of the inner region covered by the outer, in engine pixels.
function coverage(inner, outer) {
  const width = Math.max(0, Math.min(inner.box[2], outer.box[2]) - Math.max(inner.box[0], outer.box[0]));
  const height = Math.max(0, Math.min(inner.box[3], outer.box[3]) - Math.max(inner.box[1], outer.box[1]));
  const innerArea = area(inner);
  return innerArea <= 0 ? 0 : (width * height) / innerArea;
}

function coveredFraction(parent, parts) {
  let rest = parent;
  for (const part of [...parts].sort((a, b) => b.length - a.length)) {
    const at = rest.indexOf(part);
    if (at >= 0) rest = rest.slice(0, at) + rest.slice(at + part.length);
  }
  return parent.length ? (parent.length - rest.length) / parent.length : 0;
}

function dropRedundantTranscriptions(regions, { keepEnglish }) {
  const drop = new Set();
  if (!keepEnglish) {
    for (const region of regions) if (region.english) drop.add(region.id);
  }
  const live = () => regions.filter((region) => !drop.has(region.id) && hasReading(region.source));

  for (const region of live()) {
    if (drop.has(region.id)) continue;
    for (const other of live()) {
      if (other.id === region.id || drop.has(other.id) || drop.has(region.id)) continue;
      if (readingKey(region.source) !== readingKey(other.source)) continue;
      if (Math.max(coverage(region, other), coverage(other, region)) < 0.65) continue;
      drop.add(area(region) <= area(other) ? other.id : region.id);
    }
  }

  const parents = live().slice().sort((a, b) => area(b) - area(a));
  for (const parent of parents) {
    if (drop.has(parent.id)) continue;
    const parentKey = readingKey(parent.source);
    const nested = live().filter((child) => {
      if (child.id === parent.id || drop.has(child.id)) return false;
      if (!(area(child) < area(parent) * 0.85)) return false;
      if (coverage(child, parent) < 0.65) return false;
      const childKey = readingKey(child.source);
      return Boolean(childKey) && parentKey.includes(childKey);
    });
    if (!nested.length) continue;
    const identical = nested.filter((child) => readingKey(child.source) === parentKey);
    if (identical.length === nested.length) {
      drop.add(parent.id);
      continue;
    }
    const parts = nested.filter((child) => readingKey(child.source) !== parentKey);
    if (parts.length >= 2 && coveredFraction(parentKey, parts.map((part) => readingKey(part.source))) >= 0.8)
      drop.add(parent.id);
    else
      for (const child of nested) drop.add(child.id);
  }

  const keptText = regions.filter((region) => !drop.has(region.id) && hasReading(region.source));
  const skippedEnglish = keepEnglish ? [] : regions.filter((region) => region.english);
  for (const region of regions) {
    if (drop.has(region.id) || hasReading(region.source)) continue;
    const onKept = keptText.some((other) => coverage(region, other) >= 0.65);
    const onEnglish = skippedEnglish.some((other) => coverage(region, other) >= 0.65);
    if (onKept || onEnglish) drop.add(region.id);
  }
  return drop;
}

export function postProcessDetection(result, { keepEnglish = false } = {}) {
  // Array positions identify regions even if incoming line numbers have gaps.
  const regions = result.lines.map((line, id) => ({
    id, box: line.box, source: line.jp ?? '', english: isAlreadyEnglish(line.jp ?? ''),
  }));
  const drop = dropRedundantTranscriptions(regions, { keepEnglish });
  return {
    ...result,
    lines: result.lines.filter((_, id) => !drop.has(id)).map((line, i) => ({
      ...line,
      n: i + 1,
      type: classifyRegionLineType(line.kind, line.jp ?? '', { type: line.type, lang: line.lang ?? result.lang }),
    })),
  };
}
