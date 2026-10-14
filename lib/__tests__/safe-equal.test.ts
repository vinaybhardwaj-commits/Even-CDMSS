import test from 'node:test';
import assert from 'node:assert/strict';
import { safeEqual } from '../safe-equal';

test('equal strings match', () => {
  assert.equal(safeEqual('s3cret', 's3cret'), true);
  assert.equal(safeEqual('Bearer é-ü', 'Bearer é-ü'), true);
});
test('unequal same length is refused', () => {
  assert.equal(safeEqual('s3cret', 's3creT'), false);
});
test('different length is refused', () => {
  assert.equal(safeEqual('s3cret', 's3cret2'), false);
  assert.equal(safeEqual('s3cret2', 's3cret'), false);
});
test('empty secret never matches, even against empty', () => {
  assert.equal(safeEqual('', ''), false);
  assert.equal(safeEqual('x', ''), false);
  assert.equal(safeEqual('', 'x'), false);
});
test('non-string input is refused', () => {
  assert.equal(safeEqual(undefined, 'x'), false);
  assert.equal(safeEqual('x', undefined), false);
  assert.equal(safeEqual(null, null), false);
  assert.equal(safeEqual(1, 1), false);
});
