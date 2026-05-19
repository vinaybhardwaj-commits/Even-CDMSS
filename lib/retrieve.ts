import { sql } from './db';
import { embedQuery, vectorLiteral, TOP_K } from './llm';
import type { ChunkHit } from './db';

export type RetrieveOptions = {
  topK?: number;
  bookFilter?: string;       // exact match on book column
  chunkType?: 'narrative' | 'explanation';
  minSimilarity?: number;    // 0..1, default 0.3 per V's handoff §5.3
};

export async function retrieve(query: string, opts: RetrieveOptions = {}): Promise<ChunkHit[]> {
  const topK = opts.topK ?? TOP_K;
  const minSim = opts.minSimilarity ?? 0.3;

  const vec = await embedQuery(query);
  const vlit = vectorLiteral(vec);

  // Build dynamic filters
  const wheres: string[] = [`1 - (embedding <=> $1::vector) > $2`];
  const params: unknown[] = [vlit, minSim];
  let pIdx = 3;
  if (opts.bookFilter) {
    wheres.push(`book = $${pIdx++}`);
    params.push(opts.bookFilter);
  }
  if (opts.chunkType) {
    wheres.push(`chunk_type = $${pIdx++}`);
    params.push(opts.chunkType);
  }
  wheres.push(`text IS NOT NULL`);

  const query_sql = `
    SELECT id, book, chapter, section, page_start, page_end, item_number, chunk_type, text, token_count,
           1 - (embedding <=> $1::vector) AS similarity
    FROM mksap_chunks
    WHERE ${wheres.join(' AND ')}
    ORDER BY embedding <=> $1::vector
    LIMIT ${topK}
  `;

  const rows = (await (sql as unknown as (q: string, p: unknown[]) => Promise<ChunkHit[]>)(query_sql, params)) as ChunkHit[];
  return rows;
}
