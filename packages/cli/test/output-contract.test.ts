import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiError } from '../src/api-client.js';
import { CLI_EXIT_CODES } from '@markus/shared';
import {
  success,
  fail,
  withErrorHandling,
  setGlobalJson,
} from '../src/output.js';

describe('output contract', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    setGlobalJson(false);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
    setGlobalJson(false);
  });

  describe('success()', () => {
    it('outputs { ok: true, data } in JSON mode', () => {
      setGlobalJson(true);
      success('Created', { id: 'proj_001' });
      const output = JSON.parse(String(logSpy.mock.calls[0][0]));
      expect(output).toEqual({ ok: true, data: { id: 'proj_001' } });
    });

    it('wraps message in data when no explicit data provided', () => {
      setGlobalJson(true);
      success('Done');
      const output = JSON.parse(String(logSpy.mock.calls[0][0]));
      expect(output).toEqual({ ok: true, data: { message: 'Done' } });
    });

    it('outputs plain message in human mode', () => {
      success('Project created');
      expect(logSpy).toHaveBeenCalledWith('Project created');
    });
  });

  describe('fail()', () => {
    it('outputs { ok: false, error, code } in JSON mode', () => {
      setGlobalJson(true);
      fail('Not found', CLI_EXIT_CODES.SERVER_ERROR, 'NOT_FOUND');
      const output = JSON.parse(String(errorSpy.mock.calls[0][0]));
      expect(output).toEqual({ ok: false, error: 'Not found', code: 'NOT_FOUND' });
      expect(exitSpy).toHaveBeenCalledWith(CLI_EXIT_CODES.SERVER_ERROR);
    });

    it('defaults to USER_ERROR code and exit code 1', () => {
      setGlobalJson(true);
      fail('Invalid input');
      const output = JSON.parse(String(errorSpy.mock.calls[0][0]));
      expect(output).toEqual({ ok: false, error: 'Invalid input', code: 'USER_ERROR' });
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('outputs human-readable error in non-JSON mode', () => {
      fail('Something went wrong', 2, 'SERVER_ERROR');
      expect(errorSpy).toHaveBeenCalledWith('Error: Something went wrong');
      expect(exitSpy).toHaveBeenCalledWith(2);
    });
  });

  describe('withErrorHandling()', () => {
    it('returns result on success without exiting', async () => {
      const action = withErrorHandling(async () => {
        success('ok', { done: true });
      });
      await action();
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('exits with code 2 on ApiError', async () => {
      setGlobalJson(true);
      const action = withErrorHandling(async () => {
        throw new ApiError(500, { error: 'Internal server error' });
      });
      await action();
      expect(exitSpy).toHaveBeenCalledWith(CLI_EXIT_CODES.SERVER_ERROR);
      const output = JSON.parse(String(errorSpy.mock.calls[0][0]));
      expect(output.ok).toBe(false);
      expect(output.code).toBe('API_500');
    });

    it('exits with code 2 and NOT_FOUND on 404 ApiError', async () => {
      setGlobalJson(true);
      const action = withErrorHandling(async () => {
        throw new ApiError(404, { error: 'Agent not found' });
      });
      await action();
      expect(exitSpy).toHaveBeenCalledWith(CLI_EXIT_CODES.SERVER_ERROR);
      const output = JSON.parse(String(errorSpy.mock.calls[0][0]));
      expect(output.code).toBe('NOT_FOUND');
    });

    it('exits with code 3 on network errors', async () => {
      setGlobalJson(true);
      const action = withErrorHandling(async () => {
        throw new Error('Cannot connect to Markus server at http://localhost:8056. Is it running? (ECONNREFUSED)');
      });
      await action();
      expect(exitSpy).toHaveBeenCalledWith(CLI_EXIT_CODES.NETWORK_ERROR);
      const output = JSON.parse(String(errorSpy.mock.calls[0][0]));
      expect(output.code).toBe('NETWORK_ERROR');
    });

    it('exits with code 1 on user errors via fail()', async () => {
      setGlobalJson(true);
      const action = withErrorHandling(async () => {
        fail('Bad argument', CLI_EXIT_CODES.USER_ERROR, 'USER_ERROR');
      });
      await action();
      expect(exitSpy).toHaveBeenCalledWith(CLI_EXIT_CODES.USER_ERROR);
    });
  });
});
