// In-process Postgres (PGlite) behind the subset of the @neondatabase/serverless 1.x API the job store uses:
// lazy tagged-template queries that resolve to row arrays, and sql.transaction(txn => [queries]).
import { PGlite } from '@electric-sql/pglite';

function escapeArrayElement(value) {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function arrayLiteral(values) {
  const items = values.map(item => {
    if (item === null || item === undefined) return 'NULL';
    if (Array.isArray(item)) return arrayLiteral(item);
    return escapeArrayElement(prepareValue(item));
  });
  return `{${items.join(',')}}`;
}

// Mirrors neon's prepareValue, so array, Date and object parameters reach Postgres in the form production sends.
function prepareValue(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return arrayLiteral(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return value.toString();
}

function queryTag(run) {
  return (strings, ...values) => {
    const query = {
      text: strings.reduce((text, part, i) => `${text}$${i}${part}`),
      values: values.map(prepareValue),
    };
    let pending = null;
    return {
      query,
      then(resolve, reject) {
        pending ||= run(query);
        return pending.then(resolve, reject);
      },
    };
  };
}

export function createPgliteSql() {
  const db = new PGlite();
  const sql = queryTag(async ({ text, values }) => (await db.query(text, values)).rows);
  sql.transaction = async build => {
    const queries = build(queryTag(() => Promise.reject(new Error('Transaction queries run through sql.transaction.'))));
    return db.transaction(async tx => {
      const results = [];
      for (const { query } of queries) results.push((await tx.query(query.text, query.values)).rows);
      return results;
    });
  };
  return { sql, db };
}
