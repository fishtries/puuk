import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const apiSource = readFileSync(join(here, '../recommendations.ts'), 'utf8');
const typesSource = readFileSync(join(here, '../../types/recommendations.ts'), 'utf8');

// Литералы собраны по частям, чтобы сам файл-страж не содержал
// упоминаний legacy-контракта и не ловился grep'ом по src.
const LEGACY_SUBSTRING = 'm' + 'ood';
const LEGACY_ENDPOINT = '/m' + 'oods';
const LEGACY_CONSTANT_PREFIX = 'M' + 'OOD_';

const assertNoLegacyContract = (name: string, source: string): void => {
  assert.ok(
    !source.toLowerCase().includes(LEGACY_SUBSTRING),
    `${name}: найден legacy-подстрочный контракт`
  );
  assert.ok(!source.includes(LEGACY_ENDPOINT), `${name}: найден legacy-эндпоинт`);
  assert.ok(
    !source.includes(LEGACY_CONSTANT_PREFIX),
    `${name}: найдена legacy-константа`
  );
};

describe('recommendations api/types без старого персонального контракта', () => {
  it('src/api/recommendations.ts не содержит legacy-подстрок', () => {
    assertNoLegacyContract('src/api/recommendations.ts', apiSource);
  });

  it('src/types/recommendations.ts не содержит legacy-подстрок', () => {
    assertNoLegacyContract('src/types/recommendations.ts', typesSource);
  });

  it('api экспортирует новый персональный контракт', () => {
    assert.ok(apiSource.includes('fetchPersonalizedRecommendations'));
    assert.ok(apiSource.includes('/api/recommendations/youll-like-this'));
    assert.ok(typesSource.includes('PersonalizedPlaylistSection'));
    assert.ok(typesSource.includes('PersonalizedRecommendationsResponse'));
  });
});
