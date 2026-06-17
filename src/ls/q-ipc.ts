import * as net from 'net';

const HEADER_LENGTH = 8;
const LITTLE_ENDIAN = 1;
const MESSAGE_SYNC = 1;
const MESSAGE_RESPONSE = 2;
const TYPE_CHAR_VECTOR = 10;
const TYPE_TABLE = 98;
const TYPE_DICTIONARY = 99;
const TYPE_ERROR = -128;
const INT_NULL = -2147483648;
const INT_INFINITY = 2147483647;
const SHORT_NULL = -32768;
const SHORT_INFINITY = 32767;
const J2P32 = Math.pow(2, 32);
const Q_EPOCH_DAYS = 10957;
const MS_PER_DAY = 86400000;
const NS_PER_DAY = 86400000000000;

export type QCellValue = string | number | boolean | null;

export interface QTable {
  qtype: 'table';
  columns: string[];
  rows: Array<{ [key: string]: QDisplayValue }>;
  columnData: QValue[];
}

export interface QKeyedTable {
  qtype: 'keyedTable';
  keyTable: QTable;
  valueTable: QTable;
  columns: string[];
  rows: Array<{ [key: string]: QDisplayValue }>;
}

export interface QDict {
  qtype: 'dict';
  keys: QValue;
  values: QValue;
  entries: Array<{ key: QValue; value: QValue }>;
}

export type QDisplayValue = QCellValue | QDisplayValue[] | { [key: string]: QDisplayValue };
export type QValue = QCellValue | QValue[] | QTable | QKeyedTable | QDict;

export interface QTabularResult {
  cols: string[];
  rows: Array<{ [key: string]: QDisplayValue }>;
  kind: string;
}

export interface KdbConnectionOptions {
  host: string;
  port: number;
  username?: string;
  password?: string;
  timeoutMs?: number;
}

interface PendingQuery {
  query: string;
  resolve(value: QValue): void;
  reject(error: Error): void;
  timeout?: NodeJS.Timer;
}

export class KdbQError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KdbQError';
  }
}

export class KdbIpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KdbIpcError';
  }
}

export class KdbIpcClient {
  private socket: net.Socket | null = null;
  private buffer = Buffer.alloc(0);
  private pending: PendingQuery | null = null;
  private queue: PendingQuery[] = [];
  private protocolVersion = 0;

  constructor(private readonly options: KdbConnectionOptions) {}

  public async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({
        host: this.options.host,
        port: this.options.port,
      });
      let settled = false;

      const fail = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        socket.destroy();
        reject(error);
      };

      const cleanup = () => {
        socket.removeListener('connect', onConnect);
        socket.removeListener('data', onHandshakeData);
        socket.removeListener('error', onError);
        socket.removeListener('close', onClose);
        socket.removeListener('timeout', onTimeout);
      };

      const onConnect = () => {
        socket.write(createHandshake(this.options), error => {
          if (error) {
            fail(error);
          }
        });
      };

      const onHandshakeData = (chunk: Buffer) => {
        if (!chunk.length) {
          return;
        }

        const version = chunk.readUInt8(0);
        if (version < 1) {
          fail(new KdbIpcError('kdb+ rejected IPC authentication'));
          return;
        }

        settled = true;
        cleanup();
        socket.setNoDelay(true);
        socket.setTimeout(0);
        socket.on('data', this.handleData);
        socket.on('error', this.handleSocketError);
        socket.on('close', this.handleSocketClose);
        this.protocolVersion = version;
        this.socket = socket;

        if (chunk.length > 1) {
          this.handleData(chunk.slice(1));
        }

        resolve();
      };

      const onError = (error: Error) => fail(error);
      const onClose = () => fail(new KdbIpcError('kdb+ connection closed during handshake'));
      const onTimeout = () => fail(new KdbIpcError(`kdb+ connection timed out after ${this.timeoutMs()} ms`));

      socket.once('connect', onConnect);
      socket.once('data', onHandshakeData);
      socket.once('error', onError);
      socket.once('close', onClose);
      if (this.timeoutMs() > 0) {
        socket.setTimeout(this.timeoutMs(), onTimeout);
      }
    });
  }

  public query(query: string): Promise<QValue> {
    if (!this.socket || this.socket.destroyed) {
      return Promise.reject(new KdbIpcError('kdb+ connection is not open'));
    }

    return new Promise<QValue>((resolve, reject) => {
      this.queue.push({ query, resolve, reject });
      this.flushQueue();
    });
  }

  public async close(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.failAll(new KdbIpcError('kdb+ connection closed'));

    if (!socket || socket.destroyed) {
      return;
    }

    await new Promise<void>(resolve => {
      socket.end(() => resolve());
    });
  }

  public getProtocolVersion(): number {
    return this.protocolVersion;
  }

  private timeoutMs(): number {
    return Math.max(0, Number(this.options.timeoutMs || 0));
  }

  private flushQueue() {
    if (this.pending || !this.socket || this.socket.destroyed) {
      return;
    }

    const pending = this.queue.shift();
    if (!pending) {
      return;
    }

    this.pending = pending;
    if (this.timeoutMs() > 0) {
      pending.timeout = setTimeout(() => {
        this.rejectPending(new KdbIpcError(`kdb+ query timed out after ${this.timeoutMs()} ms`));
        this.socket && this.socket.destroy();
      }, this.timeoutMs());
    }

    this.socket.write(serializeTextQuery(pending.query), error => {
      if (error) {
        this.rejectPending(error);
      }
    });
  }

  private handleData = (chunk: Buffer) => {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    try {
      while (this.buffer.length >= HEADER_LENGTH) {
        const length = readMessageLength(this.buffer);
        if (this.buffer.length < length) {
          return;
        }

        const message = this.buffer.slice(0, length);
        this.buffer = this.buffer.slice(length);
        this.handleMessage(message);
      }
    } catch (error) {
      this.failAll(toError(error));
      this.socket && this.socket.destroy();
    }
  };

  private handleMessage(message: Buffer) {
    const messageType = message.readUInt8(1);
    if (messageType !== MESSAGE_RESPONSE) {
      return;
    }

    const pending = this.pending;
    if (!pending) {
      return;
    }

    this.pending = null;
    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }

    try {
      pending.resolve(deserializeQMessage(message));
    } catch (error) {
      pending.reject(toError(error));
    } finally {
      this.flushQueue();
    }
  }

  private handleSocketError = (error: Error) => {
    this.failAll(error);
  };

  private handleSocketClose = () => {
    this.socket = null;
    this.failAll(new KdbIpcError('kdb+ connection closed'));
  };

  private rejectPending(error: Error) {
    const pending = this.pending;
    this.pending = null;
    if (!pending) {
      return;
    }
    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }
    pending.reject(error);
  }

  private failAll(error: Error) {
    this.rejectPending(error);
    const queued = this.queue.splice(0);
    queued.forEach(item => item.reject(error));
  }
}

export function serializeTextQuery(query: string): Buffer {
  const text = Buffer.from(query, 'utf8');
  const payload = Buffer.alloc(1 + 1 + 4 + text.length);
  payload.writeInt8(TYPE_CHAR_VECTOR, 0);
  payload.writeUInt8(0, 1);
  payload.writeInt32LE(text.length, 2);
  text.copy(payload, 6);

  const message = Buffer.alloc(HEADER_LENGTH + payload.length);
  message.writeUInt8(LITTLE_ENDIAN, 0);
  message.writeUInt8(MESSAGE_SYNC, 1);
  message.writeUInt8(0, 2);
  message.writeUInt8(0, 3);
  message.writeInt32LE(message.length, 4);
  payload.copy(message, HEADER_LENGTH);
  return message;
}

export function deserializeQMessage(message: Buffer): QValue {
  if (message.length < HEADER_LENGTH) {
    throw new KdbIpcError('Invalid q IPC message: header is incomplete');
  }

  const normalized = message.readUInt8(2) === 1 ? decompressMessage(message) : message;
  const littleEndian = normalized.readUInt8(0) === LITTLE_ENDIAN;
  return deserializeQPayload(normalized.slice(HEADER_LENGTH), littleEndian);
}

export function deserializeQPayload(payload: Buffer, littleEndian = true): QValue {
  return new QReader(payload, littleEndian).readObject();
}

export function qValueToTabular(value: QValue): QTabularResult {
  if (isQTable(value)) {
    return {
      cols: value.columns,
      rows: value.rows,
      kind: 'table',
    };
  }

  if (isQKeyedTable(value)) {
    return {
      cols: value.columns,
      rows: value.rows,
      kind: 'keyed table',
    };
  }

  if (isQDict(value)) {
    return {
      cols: ['key', 'value'],
      rows: value.entries.map(entry => ({
        key: normalizeCell(entry.key),
        value: normalizeCell(entry.value),
      })),
      kind: 'dictionary',
    };
  }

  if (Array.isArray(value)) {
    if (value.length > 0 && value.every(isPlainObject)) {
      const rows = value.map(row => normalizePlainObject(row as unknown as { [key: string]: QValue }));
      return {
        cols: collectColumns(rows),
        rows,
        kind: 'list',
      };
    }

    return {
      cols: ['index', 'value'],
      rows: value.map((item, index) => ({ index, value: normalizeCell(item) })),
      kind: 'list',
    };
  }

  if (isPlainObject(value)) {
    const row = normalizePlainObject(value as unknown as { [key: string]: QValue });
    return {
      cols: Object.keys(row),
      rows: [row],
      kind: 'object',
    };
  }

  return {
    cols: ['value'],
    rows: [{ value: normalizeCell(value) }],
    kind: 'scalar',
  };
}

function createHandshake(options: KdbConnectionOptions): Buffer {
  const username = options.username || '';
  const password = options.password || '';
  const auth = username || password ? `${username}:${password}` : '';

  // Modern q clients advertise the highest IPC protocol they support by
  // appending the version byte before the NUL terminator. Older mock servers
  // also accept this because they only parse up to the NUL. Without this byte,
  // current kdb+/q 5.x responds with version 0 and rejects the handshake.
  return Buffer.concat([Buffer.from(auth, 'utf8'), Buffer.from([3, 0])]);
}

function readMessageLength(buffer: Buffer): number {
  const littleEndian = buffer.readUInt8(0) === LITTLE_ENDIAN;
  const length = littleEndian ? buffer.readInt32LE(4) : buffer.readInt32BE(4);
  if (length < HEADER_LENGTH) {
    throw new KdbIpcError(`Invalid q IPC message length ${length}`);
  }
  return length;
}

function decompressMessage(message: Buffer): Buffer {
  const littleEndian = message.readUInt8(0) === LITTLE_ENDIAN;
  const uncompressedLength = littleEndian ? message.readInt32LE(8) : message.readInt32BE(8);
  if (uncompressedLength < HEADER_LENGTH) {
    throw new KdbIpcError(`Invalid compressed q IPC length ${uncompressedLength}`);
  }

  // q IPC compression uses a compact byte-pair back-reference scheme.
  const dst = Buffer.alloc(uncompressedLength);
  dst.writeUInt8(message.readUInt8(0), 0);
  dst.writeUInt8(message.readUInt8(1), 1);
  dst.writeUInt8(0, 2);
  dst.writeUInt8(message.readUInt8(3), 3);
  littleEndian ? dst.writeInt32LE(uncompressedLength, 4) : dst.writeInt32BE(uncompressedLength, 4);

  let n = 0;
  let r = 0;
  let f = 0;
  let s = HEADER_LENGTH;
  let p = s;
  let i = 0;
  let d = 12;
  const lookup = new Int32Array(256);

  while (s < dst.length) {
    if (!i) {
      f = message[d++];
      i = 1;
    }
    if (f & i) {
      r = lookup[message[d++]];
      dst[s++] = dst[r++];
      dst[s++] = dst[r++];
      n = message[d++];
      for (let m = 0; m < n; m++) {
        dst[s + m] = dst[r + m];
      }
    } else {
      dst[s++] = message[d++];
    }
    while (p < s - 1) {
      lookup[dst[p] ^ dst[p + 1]] = p++;
    }
    if (f & i) {
      p = (s += n);
    }
    i *= 2;
    if (i === 256) {
      i = 0;
    }
  }

  return dst;
}

class QReader {
  private pos = 0;

  constructor(private readonly buffer: Buffer, private readonly littleEndian: boolean) {}

  public readObject(): QValue {
    const type = this.readInt8();
    if (type === TYPE_ERROR) {
      throw new KdbQError(String(this.readSymbolAtom() || 'error'));
    }

    if (type < 0 && type > -20) {
      return this.readAtom(-type);
    }

    if (type === TYPE_TABLE) {
      return this.readTable();
    }

    if (type === TYPE_DICTIONARY) {
      return this.readDictionary();
    }

    if (type > 99) {
      return this.readFunction(type);
    }

    this.readUInt8();
    const length = this.readInt32Raw();
    if (type === TYPE_CHAR_VECTOR) {
      return this.readString(length);
    }

    const values: QValue[] = [];
    for (let i = 0; i < length; i++) {
      values.push(type === 0 ? this.readObject() : this.readAtom(type));
    }
    return values;
  }

  private readAtom(type: number): QValue {
    switch (type) {
      case 1:
        return this.readInt8() === 1;
      case 2:
        return this.readGuid();
      case 4:
        return this.readUInt8();
      case 5:
        return this.nullableInt(this.readInt16Raw(), SHORT_NULL, SHORT_INFINITY);
      case 6:
        return this.nullableInt(this.readInt32Raw(), INT_NULL, INT_INFINITY);
      case 7:
        return this.readLongAtom();
      case 8:
        return this.nullableFloat(this.readFloatRaw());
      case 9:
        return this.nullableFloat(this.readDoubleRaw());
      case 10:
        return String.fromCharCode(this.readUInt8());
      case 11:
        return this.readSymbolAtom();
      case 12:
        return this.readTimestamp();
      case 13:
        return this.readMonth();
      case 14:
        return this.readDate();
      case 15:
        return this.readDateTime();
      case 16:
        return this.readTimespan();
      case 17:
        return this.readMinute();
      case 18:
        return this.readSecond();
      case 19:
        return this.readTime();
    }

    throw new KdbIpcError(`Unsupported q IPC type ${type}`);
  }

  private readTable(): QTable {
    this.readUInt8();
    const dictType = this.readInt8();
    if (dictType !== TYPE_DICTIONARY) {
      throw new KdbIpcError(`Invalid q table payload: expected dictionary, got ${dictType}`);
    }

    const columns = this.readObject();
    const values = this.readObject();
    return makeQTable(columns, values);
  }

  private readDictionary(): QDict | QKeyedTable {
    const keys = this.readObject();
    const values = this.readObject();
    if (isQTable(keys) && isQTable(values)) {
      return makeQKeyedTable(keys, values);
    }
    return makeQDict(keys, values);
  }

  private readFunction(type: number): QValue {
    if (type === 100) {
      this.readSymbolAtom();
      this.readObject();
      return '[lambda]';
    }

    if (type < 104) {
      return this.readInt8() === 0 && type === 101 ? null : '[function]';
    }

    if (type > 105) {
      this.readObject();
    } else {
      const length = this.readInt32Raw();
      for (let i = 0; i < length; i++) {
        this.readObject();
      }
    }

    return '[function]';
  }

  private readTimestamp(): QValue {
    const value = this.readLongNumber();
    return value === null ? null : formatTimestamp(value);
  }

  private readMonth(): QValue {
    const value = this.nullableInt(this.readInt32Raw(), INT_NULL, INT_INFINITY);
    if (value === null || !Number.isFinite(value as number)) {
      return value;
    }
    const raw = value as number;
    const year = 2000 + Math.floor(raw / 12);
    const month = ((raw % 12) + 12) % 12;
    return `${year.toString().padStart(4, '0')}.${(month + 1).toString().padStart(2, '0')}`;
  }

  private readDate(): QValue {
    const value = this.nullableInt(this.readInt32Raw(), INT_NULL, INT_INFINITY);
    if (value === null || !Number.isFinite(value as number)) {
      return value;
    }
    return formatDate(value as number);
  }

  private readDateTime(): QValue {
    const value = this.nullableFloat(this.readDoubleRaw());
    if (value === null || !Number.isFinite(value as number)) {
      return value;
    }
    return formatDateTime(value as number);
  }

  private readTimespan(): QValue {
    const value = this.readLongNumber();
    return value === null ? null : formatDuration(value);
  }

  private readMinute(): QValue {
    const value = this.nullableInt(this.readInt32Raw(), INT_NULL, INT_INFINITY);
    return value === null || !Number.isFinite(value as number) ? value : formatClock((value as number) * 60000, 'minute');
  }

  private readSecond(): QValue {
    const value = this.nullableInt(this.readInt32Raw(), INT_NULL, INT_INFINITY);
    return value === null || !Number.isFinite(value as number) ? value : formatClock((value as number) * 1000, 'second');
  }

  private readTime(): QValue {
    const value = this.nullableInt(this.readInt32Raw(), INT_NULL, INT_INFINITY);
    return value === null || !Number.isFinite(value as number) ? value : formatClock(value as number, 'millisecond');
  }

  private readGuid(): QValue {
    const parts: string[] = [];
    for (let i = 0; i < 16; i++) {
      const byte = this.readUInt8();
      if (i === 4 || i === 6 || i === 8 || i === 10) {
        parts.push('-');
      }
      parts.push((byte >> 4).toString(16));
      parts.push((byte & 15).toString(16));
    }
    const guid = parts.join('');
    return guid === '00000000-0000-0000-0000-000000000000' ? null : guid;
  }

  private readSymbolAtom(): QValue {
    const end = this.buffer.indexOf(0, this.pos);
    if (end < 0) {
      throw new KdbIpcError('Invalid q symbol: missing terminator');
    }
    const value = this.buffer.slice(this.pos, end).toString('utf8');
    this.pos = end + 1;
    return value || null;
  }

  private readLongAtom(): QValue {
    const value = this.readLongNumber();
    if (value === null || !Number.isFinite(value)) {
      return value;
    }
    return Number.isSafeInteger(value) ? value : value.toFixed(0);
  }

  private readLongNumber(): number | null {
    const low = this.readInt32Raw();
    const high = this.readInt32Raw();

    if (low === 0 && high === INT_NULL) {
      return null;
    }
    if (low === -1 && high === INT_INFINITY) {
      return Infinity;
    }
    if (low === 1 && high === INT_NULL) {
      return -Infinity;
    }

    return high * J2P32 + (low >= 0 ? low : J2P32 + low);
  }

  private nullableInt(value: number, nullValue: number, infinityValue: number): QValue {
    if (value === nullValue) {
      return null;
    }
    if (value === infinityValue) {
      return Infinity;
    }
    if (value === -infinityValue) {
      return -Infinity;
    }
    return value;
  }

  private nullableFloat(value: number): QValue {
    return Number.isNaN(value) ? null : value;
  }

  private readString(length: number): string {
    this.ensure(length);
    const value = this.buffer.slice(this.pos, this.pos + length).toString('utf8');
    this.pos += length;
    return value;
  }

  private readInt8(): number {
    this.ensure(1);
    const value = this.buffer.readInt8(this.pos);
    this.pos += 1;
    return value;
  }

  private readUInt8(): number {
    this.ensure(1);
    const value = this.buffer.readUInt8(this.pos);
    this.pos += 1;
    return value;
  }

  private readInt16Raw(): number {
    this.ensure(2);
    const value = this.littleEndian ? this.buffer.readInt16LE(this.pos) : this.buffer.readInt16BE(this.pos);
    this.pos += 2;
    return value;
  }

  private readInt32Raw(): number {
    this.ensure(4);
    const value = this.littleEndian ? this.buffer.readInt32LE(this.pos) : this.buffer.readInt32BE(this.pos);
    this.pos += 4;
    return value;
  }

  private readFloatRaw(): number {
    this.ensure(4);
    const value = this.littleEndian ? this.buffer.readFloatLE(this.pos) : this.buffer.readFloatBE(this.pos);
    this.pos += 4;
    return value;
  }

  private readDoubleRaw(): number {
    this.ensure(8);
    const value = this.littleEndian ? this.buffer.readDoubleLE(this.pos) : this.buffer.readDoubleBE(this.pos);
    this.pos += 8;
    return value;
  }

  private ensure(length: number) {
    if (this.pos + length > this.buffer.length) {
      throw new KdbIpcError('Invalid q IPC payload: unexpected end of buffer');
    }
  }
}

function makeQTable(columnsValue: QValue, columnDataValue: QValue): QTable {
  const columns = asList(columnsValue).map(valueToColumnName);
  const columnData = asList(columnDataValue);
  const rowCount = columns.length === 0 ? 0 : Math.max(...columnData.slice(0, columns.length).map(vectorLength));
  const rows: Array<{ [key: string]: QDisplayValue }> = [];

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
    const row: { [key: string]: QDisplayValue } = {};
    columns.forEach((column, columnIndex) => {
      row[column] = normalizeCell(vectorValueAt(columnData[columnIndex], rowIndex));
    });
    rows.push(row);
  }

  return {
    qtype: 'table',
    columns,
    rows,
    columnData,
  };
}

function makeQKeyedTable(keyTable: QTable, valueTable: QTable): QKeyedTable {
  const columns = keyTable.columns.slice();
  valueTable.columns.forEach(column => columns.push(uniqueColumnName(column, columns)));
  const rows: Array<{ [key: string]: QDisplayValue }> = [];
  const rowCount = Math.max(keyTable.rows.length, valueTable.rows.length);

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
    const row: { [key: string]: QDisplayValue } = {};
    keyTable.columns.forEach(column => {
      row[column] = keyTable.rows[rowIndex] ? keyTable.rows[rowIndex][column] : null;
    });
    valueTable.columns.forEach((column, columnIndex) => {
      row[columns[keyTable.columns.length + columnIndex]] = valueTable.rows[rowIndex] ? valueTable.rows[rowIndex][column] : null;
    });
    rows.push(row);
  }

  return {
    qtype: 'keyedTable',
    keyTable,
    valueTable,
    columns,
    rows,
  };
}

function makeQDict(keys: QValue, values: QValue): QDict {
  const keyList = asList(keys);
  const valuesMatchKeys = vectorLength(values) === keyList.length;

  return {
    qtype: 'dict',
    keys,
    values,
    entries: keyList.map((key, index) => ({
      key,
      value: valuesMatchKeys ? vectorValueAt(values, index) : values,
    })),
  };
}

function asList(value: QValue): QValue[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (value === null) {
    return [];
  }
  return [value];
}

function vectorLength(value: QValue): number {
  if (Array.isArray(value)) {
    return value.length;
  }
  if (typeof value === 'string') {
    return value.length;
  }
  return value === null ? 0 : 1;
}

function vectorValueAt(value: QValue | undefined, index: number): QValue {
  if (value === undefined || value === null) {
    return null;
  }
  if (Array.isArray(value)) {
    return value[index] === undefined ? null : value[index];
  }
  if (typeof value === 'string') {
    return index < value.length ? value.charAt(index) : null;
  }
  return index === 0 ? value : null;
}

function valueToColumnName(value: QValue): string {
  const base = normalizeCell(value);
  return base === null ? 'null' : String(base);
}

function normalizePlainObject(value: { [key: string]: QValue }): { [key: string]: QDisplayValue } {
  return Object.keys(value).reduce((row, key) => {
    row[key] = normalizeCell(value[key]);
    return row;
  }, {} as { [key: string]: QDisplayValue });
}

function normalizeCell(value: QValue): QDisplayValue {
  if (isQTable(value)) {
    return `[table ${value.rows.length} rows]`;
  }
  if (isQKeyedTable(value)) {
    return `[keyed table ${value.rows.length} rows]`;
  }
  if (isQDict(value)) {
    return value.entries.reduce((dict, entry) => {
      dict[valueToColumnName(entry.key)] = normalizeCell(entry.value);
      return dict;
    }, {} as { [key: string]: QDisplayValue });
  }
  if (Array.isArray(value)) {
    return value.map(normalizeCell);
  }
  if (isPlainObject(value)) {
    return normalizePlainObject(value as unknown as { [key: string]: QValue });
  }
  return value;
}

function collectColumns(rows: Array<{ [key: string]: QDisplayValue }>): string[] {
  const columns: string[] = [];
  rows.forEach(row => {
    Object.keys(row).forEach(column => {
      if (!columns.includes(column)) {
        columns.push(column);
      }
    });
  });
  return columns;
}

function uniqueColumnName(column: string, existing: string[]): string {
  if (!existing.includes(column)) {
    return column;
  }
  let index = 1;
  let candidate = `${column}_${index}`;
  while (existing.includes(candidate)) {
    index += 1;
    candidate = `${column}_${index}`;
  }
  return candidate;
}

function isQTable(value: QValue): value is QTable {
  return isQTyped(value, 'table');
}

function isQKeyedTable(value: QValue): value is QKeyedTable {
  return isQTyped(value, 'keyedTable');
}

function isQDict(value: QValue): value is QDict {
  return isQTyped(value, 'dict');
}

function isQTyped(value: QValue, qtype: string): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) && (value as { qtype?: string }).qtype === qtype;
}

function isPlainObject(value: QValue): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) && !(value as { qtype?: string }).qtype;
}

function formatTimestamp(nanoseconds: number): string {
  if (!Number.isFinite(nanoseconds)) {
    return String(nanoseconds);
  }
  return new Date(Date.UTC(2000, 0, 1) + Math.trunc(nanoseconds / 1000000)).toISOString();
}

function formatDate(days: number): string {
  return new Date((Q_EPOCH_DAYS + days) * MS_PER_DAY).toISOString().slice(0, 10);
}

function formatDateTime(days: number): string {
  return new Date((Q_EPOCH_DAYS + days) * MS_PER_DAY).toISOString();
}

function formatDuration(nanoseconds: number): string {
  if (!Number.isFinite(nanoseconds)) {
    return String(nanoseconds);
  }
  const sign = nanoseconds < 0 ? '-' : '';
  let remaining = Math.abs(Math.trunc(nanoseconds));
  const days = Math.floor(remaining / NS_PER_DAY);
  remaining -= days * NS_PER_DAY;
  const hours = Math.floor(remaining / 3600000000000);
  remaining -= hours * 3600000000000;
  const minutes = Math.floor(remaining / 60000000000);
  remaining -= minutes * 60000000000;
  const seconds = Math.floor(remaining / 1000000000);
  const nanos = remaining - seconds * 1000000000;
  const prefix = days ? `${days}D ` : '';
  return `${sign}${prefix}${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}.${Math.trunc(nanos).toString().padStart(9, '0')}`;
}

function formatClock(milliseconds: number, precision: 'minute' | 'second' | 'millisecond'): string {
  const hours = Math.floor(milliseconds / 3600000);
  milliseconds -= hours * 3600000;
  const minutes = Math.floor(milliseconds / 60000);
  milliseconds -= minutes * 60000;
  const seconds = Math.floor(milliseconds / 1000);
  milliseconds -= seconds * 1000;
  const base = `${pad2(hours)}:${pad2(minutes)}`;
  if (precision === 'minute') {
    return base;
  }
  if (precision === 'second') {
    return `${base}:${pad2(seconds)}`;
  }
  return `${base}:${pad2(seconds)}.${Math.trunc(milliseconds).toString().padStart(3, '0')}`;
}

function pad2(value: number): string {
  return Math.trunc(value).toString().padStart(2, '0');
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
