/**
 * The console's key decoder (console/keys.ts). It is fed by a stream decoded as UTF-8 (`setEncoding('utf8')`), which
 * owns byte splits, so a multi-byte character always arrives whole; escape sequences can still arrive split across
 * chunks, and the decoder holds an incomplete one until the next chunk or the escape timer's `flush()`.
 */
import { describe, expect, it } from 'vitest';
import type { Input, Key } from '../src/console/keys.js';
import { KeyDecoder } from '../src/console/keys.js';

const key = (name: Key): Input => ({ kind: 'key', key: name });
const text = (value: string): Input => ({ kind: 'text', text: value });
const decode = (chunks: readonly string[], mode: 'keys' | 'text' = 'keys'): Input[] => {
  const decoder = new KeyDecoder();
  decoder.mode = mode;
  return chunks.flatMap((chunk) => decoder.push(chunk));
};

describe('keys mode', () => {
  it.each([
    ['\x1b[A', 'up'],
    ['\x1bOA', 'up'],
    ['k', 'up'],
    ['\x1b[B', 'down'],
    ['\x1bOB', 'down'],
    ['j', 'down'],
    ['\x1b[5~', 'page-up'],
    ['\x1b[6~', 'page-down'],
    ['\r', 'enter'],
    ['\n', 'enter'],
    ['\t', 'tab'],
    [' ', 'space'],
    ['q', 'quit'],
    ['?', 'help'],
    ['r', 'refresh'],
    ['a', 'select-all'],
    ['b', 'batch'],
    ['f', 'find'],
    ['\x03', 'interrupt'],
    ['\x7f', 'backspace'],
    ['\b', 'backspace'],
    ['x', 'other'],
    ['\x1b[C', 'other'],
    ['\x1bOP', 'other'],
  ] as const)('%j is %s', (chunk, name) => {
    expect(decode([chunk])).toEqual([key(name)]);
  });
  it('a chunk holding several keys', () => {
    expect(decode(['jjk\r'])).toEqual([key('down'), key('down'), key('up'), key('enter')]);
    expect(decode(['\r\n'])).toEqual([key('enter')]);
  });
  it('an arrow split across two chunks is one up key', () => {
    expect(decode(['\x1b', '[A'])).toEqual([key('up')]);
    expect(decode(['\x1b', '[', 'A'])).toEqual([key('up')]);
    expect(decode(['j\x1b', '[Aj'])).toEqual([key('down'), key('up'), key('down')]);
  });
  it('a lone ESC is held, then Escape on flush', () => {
    const decoder = new KeyDecoder();
    expect(decoder.push('\x1b')).toEqual([]);
    expect(decoder.pending()).toBe(true);
    expect(decoder.flush()).toEqual([key('escape')]);
    expect(decoder.pending()).toBe(false);
    expect(decoder.flush()).toEqual([]);
  });
  it('ESC then j in one chunk is not Escape', () => {
    const inputs = decode(['\x1bj']);
    expect(inputs).toEqual([key('other')]);
    expect(inputs).not.toContainEqual(key('escape'));
    expect(inputs).not.toContainEqual(key('down'));
  });
  it('a page-down split at the tilde', () => {
    expect(decode(['\x1b[6', '~'])).toEqual([key('page-down')]);
  });
  it('an unknown CSI is one other, with no stray letters', () => {
    expect(decode(['\x1b[1;5Cq'])).toEqual([key('other'), key('quit')]);
    expect(decode(['\x1b[20', '0~'])).toEqual([key('other')]);
  });
  it('a partial sequence at flush is dropped as other', () => {
    const decoder = new KeyDecoder();
    expect(decoder.push('\x1b[1;')).toEqual([]);
    expect(decoder.pending()).toBe(true);
    expect(decoder.flush()).toEqual([key('other')]);
  });
});

describe('text mode', () => {
  it('a pasted run is one text input; j and q are text; backspace; enter', () => {
    expect(decode(['acme/kit@1.2'], 'text')).toEqual([text('acme/kit@1.2')]);
    expect(decode(['jkqabfr? '], 'text')).toEqual([text('jkqabfr? ')]);
    expect(decode(['ab\x7fc\r'], 'text')).toEqual([text('ab'), key('backspace'), text('c'), key('enter')]);
    expect(decode(['\b', '\n', '\x03'], 'text')).toEqual([key('backspace'), key('enter'), key('interrupt')]);
    expect(decode(['\x1b[A'], 'text')).toEqual([key('other')]);
  });
  it('Esc cancels after flush', () => {
    const decoder = new KeyDecoder();
    decoder.mode = 'text';
    expect(decoder.push('ab\x1b')).toEqual([text('ab')]);
    expect(decoder.flush()).toEqual([key('escape')]);
  });
  it('a multi-byte character fed whole is one text input', () => {
    expect(decode(['用户🚀'], 'text')).toEqual([text('用户🚀')]);
    expect(decode(['é'], 'text')).toEqual([text('é')]);
  });
});
