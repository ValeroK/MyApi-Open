'use strict';

const {
  isSafeInternalRedirect,
} = require('../lib/redirect-safety');

describe('lib/redirect-safety :: isSafeInternalRedirect', () => {
  describe('accepts well-formed same-origin paths', () => {
    test.each([
      ['/'],
      ['/dashboard/'],
      ['/dashboard'],
      ['/dashboard/profile'],
      ['/dashboard/profile?tab=api'],
      ['/dashboard/profile?tab=api&x=1#anchor'],
      ['/a/b/c/d/e'],
      ['/dashboard/?returnTo=%2Fdashboard%2F'],
    ])('accepts %p', (input) => {
      expect(isSafeInternalRedirect(input)).toBe(true);
    });
  });

  describe('rejects non-string / empty inputs', () => {
    test.each([
      [undefined],
      [null],
      [''],
      [0],
      [1],
      [false],
      [true],
      [{}],
      [[]],
      [['/dashboard/']],
      [() => '/dashboard/'],
      [Symbol('/dashboard/')],
    ])('rejects %p', (input) => {
      expect(isSafeInternalRedirect(input)).toBe(false);
    });
  });

  describe('rejects absolute URLs (any scheme)', () => {
    test.each([
      ['https://evil.example/phish'],
      ['http://evil.example/phish'],
      ['HTTPS://EVIL.EXAMPLE/'],
      ['ftp://evil.example/'],
      ['ws://evil.example/'],
      ['wss://evil.example/'],
      ['file:///etc/passwd'],
    ])('rejects %p', (input) => {
      expect(isSafeInternalRedirect(input)).toBe(false);
    });
  });

  describe('rejects protocol-relative URLs', () => {
    test.each([
      ['//evil.example'],
      ['//evil.example/'],
      ['//evil.example/x?returnTo=/dashboard/'],
      ['///evil.example'],
    ])('rejects %p', (input) => {
      expect(isSafeInternalRedirect(input)).toBe(false);
    });
  });

  describe('rejects backslash-smuggled cross-origin paths', () => {
    // Several user-agents and URL parsers historically treated "\" as a path
    // separator; "/\\evil.example" would then be re-parsed as "//evil.example".
    test.each([
      ['/\\evil.example'],
      ['/\\evil.example/x'],
      ['/\\\\evil.example'],
    ])('rejects %p', (input) => {
      expect(isSafeInternalRedirect(input)).toBe(false);
    });
  });

  describe('rejects scheme-like strings without a leading slash', () => {
    test.each([
      ['javascript:alert(1)'],
      ['JAVASCRIPT:alert(1)'],
      ['data:text/html,<script>alert(1)</script>'],
      ['vbscript:msgbox(1)'],
      ['about:blank'],
      ['blob:https://evil.example/x'],
      ['mailto:attacker@example'],
      ['dashboard/profile'], // missing leading slash
    ])('rejects %p', (input) => {
      expect(isSafeInternalRedirect(input)).toBe(false);
    });
  });

  describe('rejects control characters (header-injection vectors)', () => {
    test.each([
      ['/dashboard/\u0000'],
      ['/dashboard/\u0001'],
      ['/dashboard/\n'],
      ['/dashboard/\r'],
      ['/dashboard/\t'],
      ['/dashboard/\r\nLocation: https://evil'],
      ['/dashboard/\u007f'],
    ])('rejects %p', (input) => {
      expect(isSafeInternalRedirect(input)).toBe(false);
    });
  });

  describe('module surface', () => {
    test('exports isSafeInternalRedirect as a function', () => {
      expect(typeof isSafeInternalRedirect).toBe('function');
    });

    test('is deterministic and side-effect free', () => {
      const inputs = ['/dashboard/', 'https://evil.example', '//evil.example', ''];
      const first = inputs.map((i) => isSafeInternalRedirect(i));
      const second = inputs.map((i) => isSafeInternalRedirect(i));
      expect(first).toEqual(second);
      expect(first).toEqual([true, false, false, false]);
    });
  });
});
