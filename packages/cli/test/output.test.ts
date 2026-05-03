import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { table, detail, success, list, extractRows, setGlobalJson } from '../src/output.js';

describe('output module', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    setGlobalJson(false);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    setGlobalJson(false);
  });

  describe('table', () => {
    it('outputs JSON when json option is set', () => {
      const rows = [{ id: '1', name: 'Test' }];
      table(rows, [{ key: 'id', header: 'ID' }, { key: 'name', header: 'Name' }], { json: true });
      expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(rows, null, 2));
    });

    it('outputs formatted table for human display', () => {
      const rows = [{ id: '1', name: 'Test' }];
      table(rows, [{ key: 'id', header: 'ID', width: 5 }, { key: 'name', header: 'Name', width: 10 }]);
      const output = consoleSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('ID');
      expect(output).toContain('Name');
      expect(output).toContain('Test');
    });

    it('shows (none) for empty rows', () => {
      table([], [{ key: 'id', header: 'ID' }]);
      expect(consoleSpy).toHaveBeenCalledWith('  (none)');
    });

    it('shows title when provided', () => {
      table([{ id: '1' }], [{ key: 'id', header: 'ID', width: 5 }], { title: 'My Table' });
      const output = consoleSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('My Table');
    });

    it('uses globalJson flag', () => {
      setGlobalJson(true);
      const rows = [{ id: '1' }];
      table(rows, [{ key: 'id', header: 'ID' }]);
      expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(rows, null, 2));
    });
  });

  describe('detail', () => {
    it('outputs JSON when json option is set', () => {
      const data = { id: '1', name: 'Test' };
      detail(data, { json: true });
      expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(data, null, 2));
    });

    it('outputs key-value pairs for human display', () => {
      detail({ id: '1', name: 'Test' });
      const output = consoleSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('id');
      expect(output).toContain('name');
      expect(output).toContain('Test');
    });

    it('handles null/undefined values', () => {
      detail({ id: '1', optional: null });
      const output = consoleSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('(none)');
    });

    it('handles array values', () => {
      detail({ tags: ['a', 'b', 'c'] });
      const output = consoleSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('a, b, c');
    });
  });

  describe('success', () => {
    it('outputs message in human mode', () => {
      success('Project created');
      expect(consoleSpy).toHaveBeenCalledWith('Project created');
    });

    it('outputs JSON data when json option is set', () => {
      const data = { id: 'proj_001' };
      success('Created', data, { json: true });
      expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(data, null, 2));
    });

    it('outputs ok message when no data in json mode', () => {
      success('Done', undefined, { json: true });
      const output = consoleSpy.mock.calls[0][0];
      expect(JSON.parse(output)).toEqual({ ok: true, message: 'Done' });
    });
  });

  describe('list', () => {
    it('outputs JSON when json option is set', () => {
      list(['a', 'b'], { json: true });
      expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(['a', 'b'], null, 2));
    });

    it('outputs items in human mode', () => {
      list(['item1', 'item2']);
      expect(consoleSpy).toHaveBeenCalledWith('  item1');
      expect(consoleSpy).toHaveBeenCalledWith('  item2');
    });

    it('shows (none) for empty list', () => {
      list([]);
      expect(consoleSpy).toHaveBeenCalledWith('  (none)');
    });
  });

  describe('extractRows', () => {
    it('returns array as-is', () => {
      expect(extractRows([{ id: '1' }])).toEqual([{ id: '1' }]);
    });

    it('extracts array from wrapped object', () => {
      expect(extractRows({ tasks: [{ id: '1' }] })).toEqual([{ id: '1' }]);
    });

    it('extracts first array value from object', () => {
      expect(extractRows({ meta: 'x', items: [{ id: '2' }] })).toEqual([{ id: '2' }]);
    });

    it('returns empty array for non-array data', () => {
      expect(extractRows({ name: 'test' })).toEqual([]);
    });

    it('returns empty array for null/undefined', () => {
      expect(extractRows(null)).toEqual([]);
      expect(extractRows(undefined)).toEqual([]);
    });
  });
});
