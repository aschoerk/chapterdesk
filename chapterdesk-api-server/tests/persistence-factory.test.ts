import { afterEach, describe, expect, test } from 'vitest';
import { detectPersistenceKind } from '../src/persistence/factory.js';

const originalPersistence = process.env.PERSISTENCE;
const originalKService = process.env.K_SERVICE;
const originalCloudRunJob = process.env.CLOUD_RUN_JOB;

afterEach(() => {
  if (originalPersistence === undefined) delete process.env.PERSISTENCE;
  else process.env.PERSISTENCE = originalPersistence;
  if (originalKService === undefined) delete process.env.K_SERVICE;
  else process.env.K_SERVICE = originalKService;
  if (originalCloudRunJob === undefined) delete process.env.CLOUD_RUN_JOB;
  else process.env.CLOUD_RUN_JOB = originalCloudRunJob;
});

describe('detectPersistenceKind', () => {
  test('defaults to memory on Cloud Run without requiring Firebase', () => {
    delete process.env.PERSISTENCE;
    process.env.K_SERVICE = 'chapterly';
    delete process.env.CLOUD_RUN_JOB;

    expect(detectPersistenceKind()).toBe('memory');
  });

  test('allows Firebase only when explicitly selected', () => {
    process.env.PERSISTENCE = 'firebase';
    process.env.K_SERVICE = 'chapterly';

    expect(detectPersistenceKind()).toBe('firebase');
  });
});