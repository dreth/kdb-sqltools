import { IBaseQueries, IExpectedResult, NSDatabase, ContextValue, QueryBuilder } from '@sqltools/types';

type Query<P, R> = QueryBuilder<P, R>;

export interface NamespaceParams {
  namespace?: string;
  database?: string;
  schema?: string;
}

export interface TableParams extends NamespaceParams {
  table?: NSDatabase.ITable | string;
  label?: string;
}

export function normalizeNamespace(value?: string): string {
  const namespace = (value || '.').trim();
  if (!namespace || namespace === '.') {
    return '.';
  }
  return namespace.startsWith('.') ? namespace : `.${namespace}`;
}

export function qString(value?: string | number): string {
  const text = String(value === undefined || value === null ? '' : value);
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function qSymbolExpression(value: string): string {
  return `\`$${qString(value)}`;
}

export function tableNameFromParams(params: TableParams): string {
  const table = params.table;
  if (typeof table === 'string') {
    return table;
  }
  return table && table.label ? table.label : (params.label || '');
}

export function namespaceFromParams(params?: NamespaceParams): string {
  return normalizeNamespace(params && (params.namespace || params.database || params.schema));
}

function expected<T>(query: string): IExpectedResult<T> {
  return query as IExpectedResult<T>;
}

function query<P, R>(builder: (params: P) => string): Query<P, R> {
  return ((params?: P) => expected<R>(builder((params || {}) as P))) as Query<P, R>;
}

const tablePathExpression = '$[ns~".";table;ns,".",table]';

const fetchTables: IBaseQueries['fetchTables'] = query<NamespaceParams, NSDatabase.ITable>((params) => {
  const namespace = namespaceFromParams(params);
  return `{[ns]
  ts:tables \`$ns;
  n:count ts;
  ([] label:ts;
      type:n#enlist ${qString(ContextValue.TABLE)};
      schema:n#enlist ns;
      database:n#enlist ns;
      isView:n#0b;
      childType:n#enlist ${qString(ContextValue.COLUMN)})
}[${qString(namespace)}]`;
});

const fetchViews: IBaseQueries['fetchTables'] = query<NamespaceParams, NSDatabase.ITable>((params) => {
  const namespace = namespaceFromParams(params);
  return `{[ns]
  vs:$[ns~".";views[];system "b ",ns];
  n:count vs;
  ([] label:vs;
      type:n#enlist ${qString(ContextValue.VIEW)};
      schema:n#enlist ns;
      database:n#enlist ns;
      isView:n#1b;
      childType:n#enlist ${qString(ContextValue.COLUMN)})
}[${qString(namespace)}]`;
});

const fetchFunctions: IBaseQueries['fetchFunctions'] = query<NamespaceParams, NSDatabase.IFunction>((params) => {
  const namespace = namespaceFromParams(params);
  return `{[ns]
  fs:system "f ",ns;
  n:count fs;
  ([] label:fs;
      name:fs;
      type:n#enlist ${qString(ContextValue.FUNCTION)};
      schema:n#enlist ns;
      database:n#enlist ns;
      signature:string fs;
      args:n#enlist "";
      resultType:n#enlist "function";
      childType:n#enlist ${qString(ContextValue.NO_CHILD)};
      iconName:n#enlist "function")
}[${qString(namespace)}]`;
});

const fetchColumns: IBaseQueries['fetchColumns'] = query<TableParams, NSDatabase.IColumn>((params) => {
  const namespace = namespaceFromParams(params);
  const table = tableNameFromParams(params);
  return `{[ns;table]
  p:\`$ ${tablePathExpression};
  m:0!meta p;
  n:count m;
  update label:c,
    type:n#enlist ${qString(ContextValue.COLUMN)},
    dataType:t,
    table:n#enlist table,
    schema:n#enlist ns,
    database:n#enlist ns,
    isNullable:n#1b,
    childType:n#enlist ${qString(ContextValue.NO_CHILD)}
    from m
}[${qString(namespace)};${qString(table)}]`;
});

const describeTable: IBaseQueries['describeTable'] = fetchColumns;

const fetchRecords: IBaseQueries['fetchRecords'] = query<TableParams & { limit: number; offset: number }, any>((params) => {
  const namespace = namespaceFromParams(params);
  const table = tableNameFromParams(params);
  const limit = Number(params.limit || 50);
  const offset = Number(params.offset || 0);
  return `{[ns;table;limit;offset]
  p:\`$ ${tablePathExpression};
  limit#offset _ value p
}[${qString(namespace)};${qString(table)};${limit};${offset}]`;
});

const countRecords: IBaseQueries['countRecords'] = query<TableParams, { total: number }>((params) => {
  const namespace = namespaceFromParams(params);
  const table = tableNameFromParams(params);
  return `{[ns;table]
  p:\`$ ${tablePathExpression};
  ([] total:enlist count value p)
}[${qString(namespace)};${qString(table)}]`;
});

const searchTables: IBaseQueries['searchTables'] = query<{ search: string; namespace?: string }, NSDatabase.ITable>((params) => {
  return fetchTables(params as any).toString();
});

const searchColumns: IBaseQueries['searchColumns'] = query<{ search: string; tables: NSDatabase.ITable[]; namespace?: string }, NSDatabase.IColumn>((params) => {
  const table = params.tables && params.tables.length ? params.tables[0] : undefined;
  return table ? fetchColumns({ ...params, table } as any).toString() : '()';
});

const searchFunctions: IBaseQueries['searchFunctions'] = query<{ search: string; namespace?: string }, NSDatabase.IFunction>((params) => {
  return fetchFunctions(params as any).toString();
});

export default {
  describeTable,
  countRecords,
  fetchColumns,
  fetchFunctions,
  fetchRecords,
  fetchTables,
  fetchViews,
  searchColumns,
  searchFunctions,
  searchTables,
};
