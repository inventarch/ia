import { describe, expect, it } from 'vitest';
import { foldProse } from '../src/fold.js';

describe('foldProse', () => {
  it('joins continuation lines with one space and trims indentation', () => {
    expect(foldProse('A. The\n      reach order')).toBe('A. The reach order');
  });
  it('keeps a blank line as one paragraph break and collapses runs of blank lines', () => {
    expect(foldProse('para one\n   more.\n\n\n   para two.')).toBe('para one more.\npara two.');
  });
  it('trims the whole value', () => {
    expect(foldProse('  just one line  ')).toBe('just one line');
  });
  it('preserves interior double spaces inside a line', () => {
    expect(foldProse('a  b')).toBe('a  b');
  });
  it('treats a carriage return as line-boundary whitespace', () => {
    expect(foldProse('para one\r\n   more.\r\n\r\n   para two.')).toBe('para one more.\npara two.');
  });
  it('absorbs a leading empty line after the opening delimiter', () => {
    expect(foldProse('\nfirst content\nsecond')).toBe('first content second');
  });
  it('folds a whitespace-only value to the empty string', () => {
    expect(foldProse('   \n   \n  ')).toBe('');
    expect(foldProse('')).toBe('');
  });
  it('treats a line of only spaces as a paragraph break and keeps interior tabs', () => {
    expect(foldProse('para one\n   \npara two')).toBe('para one\npara two');
    expect(foldProse('\tfoo\tbar\t\n\tbaz\t')).toBe('foo\tbar baz');
  });
});
