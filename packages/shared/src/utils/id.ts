import { randomBytes } from 'node:crypto';

export function generateId(prefix?: string): string {
  const hex = randomBytes(12).toString('hex');
  return prefix ? `${prefix}_${hex}` : hex;
}

export function agentId(): string {
  return generateId('agt');
}

export function taskId(): string {
  return generateId('tsk');
}

export function orgId(): string {
  return generateId('org');
}

export function envId(): string {
  return generateId('env');
}

export function msgId(): string {
  return generateId('msg');
}

export function requirementId(): string {
  return generateId('req');
}

export function userId(): string {
  return generateId('usr');
}
