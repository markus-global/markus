import { describe, it, expect, vi, afterEach } from 'vitest';
import { Command } from 'commander';
import * as doctor from '../src/commands/doctor.js';

describe('registerDoctorCommand', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers doctor command with --fix and --verbose', () => {
    const program = new Command();
    doctor.registerDoctorCommand(program);
    const doctorCmd = program.commands.find(c => c.name() === 'doctor');
    expect(doctorCmd?.options.some(o => o.long === '--fix')).toBe(true);
    expect(doctorCmd?.options.some(o => o.long === '--verbose')).toBe(true);
  });
});
