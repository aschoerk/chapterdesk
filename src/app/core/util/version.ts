/**
 * App version, baked in at build time from the root package.json so it is
 * available in every runtime (ng serve, Docker, packaged Electron) without a
 * round-trip to the API server.
 */
import { version as packageVersion } from '../../../../package.json';

export const APP_VERSION: string = packageVersion ?? '0.0.0';
