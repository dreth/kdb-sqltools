import { IDriverAlias } from '@sqltools/types';

export const DRIVER_ID = 'KDB';
export const DRIVER_NAME = 'kdb+';
export const EXTENSION_NAME = 'kdb-sqltools';
export const EXTENSION_ID = 'DanielAlonso.kdb-sqltools';

export const DRIVER_ALIASES: IDriverAlias[] = [
  { displayName: DRIVER_NAME, value: DRIVER_ID },
  { displayName: DRIVER_NAME, value: DRIVER_NAME },
  { displayName: DRIVER_NAME, value: 'kdb' },
  { displayName: DRIVER_NAME, value: EXTENSION_NAME },
  { displayName: DRIVER_NAME, value: EXTENSION_ID },
];
